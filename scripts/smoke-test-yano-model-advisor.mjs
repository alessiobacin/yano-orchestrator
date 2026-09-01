// Smoke test for scripts/yano-model-advisor.mjs — uses an injected fake
// fetchFn/spawnFn built from the real `llmproxy provider:list` sample data
// captured on Alessio's machine (never a real network call: this sandbox
// cannot reach llmProxy's 127.0.0.1:7045 on his Mac in the first place).

import {
	parseProviderListText,
	fetchProviderCatalog,
	fetchProviderCatalogFromCli,
	scoreCatalog,
	recommend,
	llmProxyPin,
	runYanoModelAdvisor,
	AFFORDABLE_BAND_MULTIPLIER,
	SUPPORT_MIN_CODING_FLOOR,
} from "./yano-model-advisor.mjs";

// ---------------------------------------------------------------------------
// Fixture — the exact real sample from Alessio's `llmproxy provider:list`.
// ---------------------------------------------------------------------------

const SAMPLE_CLI_TEXT = `1. openrouter-glm (OpenRouter)
   model=z-ai/glm-5.3-flash
   credit=19.91 credits
   coding=71.5
   vision=true free=false
   price=in=USD 0.07/1M out=USD 0.25/1M
   best=huggingface (in=USD 0.07/1M out=USD 0.25/1M)
   proxy=proxy:no
   bench=2149 ms

2. opencode-bacin (opencode-bacin)
   model=deepseek-v4-flash
   credit=n/a
   coding=69.1
   vision=false free=false
   price=n/a
   best=openrouter (in=USD 0.03/1M out=USD 0.16/1M)
   proxy=proxy:no
   bench=19736 ms

3. opencode-alessio (opencode-alessio)
   model=deepseek-v4-flash
   credit=n/a
   coding=69.1
   vision=false free=false
   price=n/a
   best=openrouter (in=USD 0.03/1M out=USD 0.16/1M)
   proxy=proxy:no
   bench=927 ms

4. openrouter-openai (openrouter-openai)
   model=gpt-5.6-luna
   credit=19.91 credits
   coding=71.4
   vision=true free=false
   price=in=USD 0.20/1M out=USD 1.20/1M
   best=openrouter (in=USD 0.20/1M out=USD 1.20/1M)
   proxy=proxy:no
   bench=448 ms

5. meta (Meta AI)
   model=muse-spark-1.2
   credit=n/a
   coding=n/a
   vision=true free=false
   price=unavailable
   best=unavailable (unavailable)
   proxy=proxy:no
   bench=errore no-endpoint

6. qwen (Qwen)
   model=qwen3.7-max
   credit=n/a
   coding=66.0 plan=payg
   vision=false free=false
   price=in=USD 2.50/1M out=USD 7.50/1M
   best=novita (in=USD 1.25/1M out=USD 3.75/1M)
   proxy=proxy:no
   bench=5120 ms

7. kimi (Kimi (Moonshot))
   model=kimi-k3
   credit=5.69
   coding=76.2
   vision=false free=false
   price=in=USD 3.00/1M out=USD 15.00/1M
   best=qwen (in=USD 2.83/1M out=USD 14.13/1M)
   proxy=proxy:no
   bench=2147 ms

8. qwen-vision (Qwen-vision)
   model=qwen3.7-plus
   credit=n/a
   coding=55.9 plan=payg
   vision=true free=false
   price=in=USD 0.40/1M out=USD 1.60/1M
   best=openrouter (in=USD 0.32/1M out=USD 1.28/1M)
   proxy=proxy:no
   bench=5914 ms`;

function assert(condition, message) {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function byId(providers, id) {
	const found = providers.find((p) => p.id === id);
	assert(found, `provider "${id}" present in normalized list`);
	return found;
}

// ---------------------------------------------------------------------------
// 1. Text parser — direct unit check against the raw sample.
// ---------------------------------------------------------------------------

const directParse = parseProviderListText(SAMPLE_CLI_TEXT);
assert(directParse.length === 8, `parseProviderListText finds all 8 providers (got ${directParse.length})`);

const glm = byId(directParse, "openrouter-glm");
assert(glm.coding === 71.5, `openrouter-glm.coding === 71.5 (got ${glm.coding})`);
assert(glm.price_in_usd_per_1m === 0.07 && glm.price_out_usd_per_1m === 0.25, "openrouter-glm price in/out parsed from price=");
assert(glm.available === true, "openrouter-glm is available");

const kimi = byId(directParse, "kimi");
assert(kimi.price_in_usd_per_1m === 3.00, `kimi.price_in_usd_per_1m === 3.00 (got ${kimi.price_in_usd_per_1m})`);
assert(kimi.price_out_usd_per_1m === 15.00, `kimi.price_out_usd_per_1m === 15.00 (got ${kimi.price_out_usd_per_1m})`);
assert(kimi.coding === 76.2, "kimi.coding === 76.2 (highest coding score in the sample)");

const meta = byId(directParse, "meta");
assert(meta.available === false, "meta.available === false (bench=errore no-endpoint)");
assert(meta.coding === null && meta.price_in_usd_per_1m === null, "meta has no usable coding/price data");

const bacin = byId(directParse, "opencode-bacin");
assert(bacin.bench_ms === 19736, `opencode-bacin.bench_ms === 19736 (got ${bacin.bench_ms})`);
// price= is n/a for opencode-bacin; the normalizer must fall back to best= —
// this is the detail that makes the coordinator/support worked example add up.
assert(bacin.price_in_usd_per_1m === 0.03 && bacin.price_out_usd_per_1m === 0.16, `opencode-bacin falls back to best= pricing (got in=${bacin.price_in_usd_per_1m} out=${bacin.price_out_usd_per_1m})`);
assert(bacin.available === true, "opencode-bacin is available despite price=n/a (coding is known)");

const qwen = byId(directParse, "qwen");
assert(qwen.coding === 66.0, `qwen.coding === 66.0 despite trailing "plan=payg" (got ${qwen.coding})`);
// qwen's price= IS present, so the normalizer must use it (2.50/7.50), NOT
// the cheaper best= (1.25/3.75) — this is the other detail behind the
// worked example's numbers.
assert(qwen.price_in_usd_per_1m === 2.50 && qwen.price_out_usd_per_1m === 7.50, `qwen keeps its own price= over the cheaper best= (got in=${qwen.price_in_usd_per_1m} out=${qwen.price_out_usd_per_1m})`);

console.log("OK — direct text parser: field extraction, n/a handling, best= price fallback, error bench");

// ---------------------------------------------------------------------------
// 2. CLI-fallback path — spawnFn injected, never a real process spawn.
// ---------------------------------------------------------------------------

function fakeSpawnFn(cmd, args) {
	assert(cmd === "llmproxy" && Array.isArray(args) && args[0] === "provider:list", "spawnFn invoked with the expected llmproxy provider:list command");
	return { status: 0, stdout: SAMPLE_CLI_TEXT, stderr: "", error: null };
}
const cliResult = fetchProviderCatalogFromCli({ spawnFn: fakeSpawnFn });
assert(cliResult.ok === true && cliResult.source === "cli", "fetchProviderCatalogFromCli succeeds with an injected spawnFn");
assert(cliResult.providers.length === 8, "CLI-fallback path normalizes to 8 providers");
assert(byId(cliResult.providers, "openrouter-glm").coding === 71.5, "CLI-fallback path: openrouter-glm.coding === 71.5");

// ---------------------------------------------------------------------------
// 3. HTTP path — injected fetchFn returning llmProxy's REAL envelope shape
// ({ success, data: { output: "<cli text>" } }, verified by reading
// llmProxy/lib/app.js's GET /api/providers handler) — must normalize to the
// exact same shape as the CLI-fallback path above.
// ---------------------------------------------------------------------------

async function fakeFetchHttpEnvelope(url) {
	assert(String(url).endsWith("/api/providers"), `fetchFn called with .../api/providers (got ${url})`);
	return {
		ok: true,
		status: 200,
		async json() {
			return { success: true, exitCode: 0, command: "provider:list", data: { output: SAMPLE_CLI_TEXT, error: "" }, timestamp: new Date().toISOString() };
		},
	};
}
const httpCatalog = await fetchProviderCatalog({ baseUrl: "http://127.0.0.1:7045", fetchFn: fakeFetchHttpEnvelope });
assert(httpCatalog.ok === true && httpCatalog.source === "http", "fetchProviderCatalog succeeds via the injected HTTP envelope path");
assert(httpCatalog.providers.length === 8, "HTTP path normalizes to 8 providers");
assert(JSON.stringify(httpCatalog.providers) === JSON.stringify(cliResult.providers), "HTTP path and CLI-fallback path normalize to byte-identical provider lists");

console.log("OK — HTTP-envelope path and CLI-spawn path both normalize to the same providers shape");

// ---------------------------------------------------------------------------
// 4. Scoring — the concrete behavioral contract Alessio asked for.
// ---------------------------------------------------------------------------

const fixtureCatalog = { ok: true, source: "cli", fetched_at: new Date().toISOString(), providers: directParse };

const coordinatorScore = scoreCatalog(fixtureCatalog, { roleClass: "coordinator" });
assert(coordinatorScore.ranked.length > 0, "coordinator scoring returns candidates");
assert(coordinatorScore.ranked[0].id === "openrouter-glm", `coordinator top pick is openrouter-glm (got ${coordinatorScore.ranked[0].id})`);
assert(coordinatorScore.ranked[0].pinned_id === "z-ai/glm-5.3-flash@openrouter-glm", `coordinator top pick pinned_id uses llmProxy model@provider-id (got ${coordinatorScore.ranked[0].pinned_id})`);
assert(llmProxyPin(glm) === "z-ai/glm-5.3-flash@openrouter-glm", "llmProxyPin preserves the model and explicit provider instance in gateway order");
assert(llmProxyPin(bacin) === "deepseek-v4-flash@opencode-bacin", "llmProxyPin works for another provider instance");
assert(!coordinatorScore.ranked[0].pinned_id.startsWith("openrouter-glm:"), "model-advisor never emits the ambiguous provider-id:model form");
assert(coordinatorScore.band_relaxed === false, "coordinator scoring did not need to relax the affordable band for this sample");
// kimi has the single highest coding score (76.2) but must lose: its blended
// price (9.00) is nowhere near AFFORDABLE_BAND_MULTIPLIER(=3)x the cheapest
// (0.095) — Alessio's explicit "not quasi economico allo stesso modo" case.
assert(coordinatorScore.ranked.every((entry) => entry.id !== "kimi") || coordinatorScore.ranked.findIndex((e) => e.id === "kimi") > coordinatorScore.ranked.findIndex((e) => e.id === "openrouter-glm"), "kimi (highest coding, far too expensive) never outranks openrouter-glm for coordinator");

const supportScore = scoreCatalog(fixtureCatalog, { roleClass: "support" });
assert(supportScore.ranked.length > 0, "support scoring returns candidates");
assert(supportScore.ranked[0].id !== "kimi" && supportScore.ranked[0].id !== "qwen", `support top pick excludes kimi/qwen as too expensive (got ${supportScore.ranked[0].id})`);
assert(["opencode-bacin", "opencode-alessio", "openrouter-glm"].includes(supportScore.ranked[0].id), `support top pick is one of the cheap-tier entries (got ${supportScore.ranked[0].id})`);

console.log(`OK — scoreCatalog: coordinator top pick = ${coordinatorScore.ranked[0].pinned_id}; support top pick = ${supportScore.ranked[0].pinned_id}`);

// requireVision filters correctly (only openrouter-glm/openrouter-openai/qwen-vision/meta have vision=true; meta is unavailable).
const visionScore = scoreCatalog(fixtureCatalog, { roleClass: "coordinator", requireVision: true });
assert(visionScore.ranked.every((entry) => entry.vision === true), "requireVision:true filters out non-vision providers");
assert(visionScore.ranked.some((entry) => entry.id === "meta") === false, "requireVision:true still excludes unavailable meta");

// Named constants stay named/importable (per Alessio's "so I can tune it later" request).
assert(AFFORDABLE_BAND_MULTIPLIER === 3, "AFFORDABLE_BAND_MULTIPLIER is the documented default (3)");
assert(SUPPORT_MIN_CODING_FLOOR === 60, "SUPPORT_MIN_CODING_FLOOR is the documented default (60)");

// ---------------------------------------------------------------------------
// 5. recommend() must never throw for a data problem — llmProxy unreachable.
// ---------------------------------------------------------------------------

async function alwaysFailingFetch() { throw new Error("simulated network error: llmProxy unreachable"); }
function alwaysFailingSpawn() { return { status: 1, stdout: "", stderr: "command not found: llmproxy", error: null }; }

const unreachable = await recommend({ roleClass: "coordinator", fetchFn: alwaysFailingFetch, spawnFn: alwaysFailingSpawn });
assert(unreachable.recommended === null, "recommend() returns recommended:null when llmProxy is fully unreachable");
assert(unreachable.catalog_ok === false, "recommend() reports catalog_ok:false when llmProxy is fully unreachable");
assert(unreachable.auto_fallback && unreachable.auto_fallback.model === "llmproxy" && unreachable.auto_fallback.pinned_id === null, "recommend() always proposes a usable auto_fallback (model:llmproxy, no pin)");
assert(Array.isArray(unreachable.alternatives) && unreachable.alternatives.length === 0, "recommend() alternatives is an empty array, not undefined, when unreachable");

console.log("OK — recommend() degrades to auto_fallback instead of throwing when llmProxy is unreachable");

// A working catalog but an invalid roleClass IS a genuine programmer error and must throw.
let threwOnInvalidRoleClass = false;
try {
	await recommend({ roleClass: "nonsense", fetchFn: fakeFetchHttpEnvelope });
} catch (error) {
	threwOnInvalidRoleClass = error instanceof Error;
}
assert(threwOnInvalidRoleClass, "recommend() throws on a genuinely invalid roleClass (programmer error, not a data problem)");

// ---------------------------------------------------------------------------
// 6. CLI entry point does not crash on --help.
// ---------------------------------------------------------------------------

const originalLog = console.log;
let helpOutput = "";
console.log = (...args) => { helpOutput += `${args.join(" ")}\n`; };
try {
	await runYanoModelAdvisor({ argv: ["--help"] });
} finally {
	console.log = originalLog;
}
assert(helpOutput.includes("yano model-advisor"), "runYanoModelAdvisor({ argv: ['--help'] }) prints usage without throwing");

// Also confirm the missing --role-class case fails clearly instead of hanging
// or crashing with an unrelated stack trace (still no network call made).
let threwOnMissingRoleClass = false;
try {
	await runYanoModelAdvisor({ argv: ["recommend"] });
} catch (error) {
	threwOnMissingRoleClass = error instanceof Error && /--role-class/.test(error.message);
}
assert(threwOnMissingRoleClass, "runYanoModelAdvisor recommend without --role-class fails fast with a clear message (no network call attempted)");

console.log("OK — CLI entry point (runYanoModelAdvisor) handles --help and argument validation without crashing");
console.log("YANO MODEL-ADVISOR SMOKE TEST PASSED");
