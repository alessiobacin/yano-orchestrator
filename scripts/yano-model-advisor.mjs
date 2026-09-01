#!/usr/bin/env node

// yano model-advisor — recommends a concrete llmProxy model@provider-id pin per
// task/role, based on live cost/coding-benchmark/latency data pulled from
// llmProxy (http://127.0.0.1:7045 by default — Alessio's local instance).
// Library + CLI only in this increment: `yano model-advisor <recommend|catalog>`.
// No REST server (unlike yano-debugger.mjs/yano-auto-improver.mjs) — nothing
// long-running is needed for a single advisory lookup.
//
// This increment ONLY produces the recommendation; wiring the planner to
// actually read it and propose a pinned model per task (with user
// confirmation, and "model became unavailable mid-round → fallback to auto"
// handling) is a later increment in prompts/planner.md — see
// docs/yano-model-advisor.md.
//
// ---------------------------------------------------------------------------
// Ground-truth note on llmProxy's HTTP surface (read before touching the
// parser below): `GET /api/providers` does NOT return structured
// per-provider JSON. llmProxy's own server (llmProxy/lib/app.js) shells out
// to `provider:list` internally and wraps the exact same colorless CLI text
// inside a JSON envelope:
//
//   { success, exitCode, command, data: { output: "<cli text>", error }, timestamp }
//
// So both code paths below — the HTTP call and the CLI-spawn fallback —
// ultimately parse the SAME text format with the SAME
// parseProviderListText(): the HTTP path is just "fetch that text over the
// network instead of spawning `llmproxy` locally". A future llmProxy version
// could start returning real structured JSON from that endpoint, so
// fetchProviderCatalog() still checks for that shape defensively before
// assuming the CLI-text envelope — see looksLikeStructuredProviderArray().
// This was verified by reading llmProxy/lib/app.js's `app.get("/api/providers", ...)`
// handler and `lib/cli.js`'s formatProviderList()/resolveEffectiveProviderList(),
// not by a live call (this sandbox cannot reach 127.0.0.1:7045 on Alessio's Mac).
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveYanoConfig } from "./yano-config.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:7045";

// Named, commented tuning constants (per Alessio's request — do not inline
// these unnamed so they stay easy to find and adjust later).
//
// "About as cheap": a provider costing up to AFFORDABLE_BAND_MULTIPLIER times
// the single cheapest available blended price still counts as affordable —
// so among the affordable ones, a coordinator role picks the smartest
// (highest `coding`) rather than the outright cheapest.
export const AFFORDABLE_BAND_MULTIPLIER = 3;
// A support role never picks something below this coding score, even if it
// is the cheapest option in the affordable band.
export const SUPPORT_MIN_CODING_FLOOR = 60;

// llmProxy distinguishes a provider *instance* (for example
// `openrouter-glm`) from its provider kind (`openrouter`). The gateway's
// explicit instance syntax is `model@provider-id`; do not emit
// `provider-id:model`, because that is either parsed as a bare model or can
// trigger provider-kind shorthand/fallback handling.
export function llmProxyPin(entry) {
	const providerId = String(entry?.id || "").trim();
	const model = String(entry?.model || "").trim();
	return providerId && model ? `${model}@${providerId}` : null;
}

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}
function has(argv, flag) { return argv.includes(flag); }

// ---------------------------------------------------------------------------
// Text parsing — `llmproxy provider:list`'s exact colorless output, the same
// text llmProxy's `GET /api/providers` wraps in a JSON envelope (see note
// above). One provider block per blank-line-separated group:
//
//   1. openrouter-glm (OpenRouter)
//      model=z-ai/glm-5.3-flash
//      credit=19.91 credits
//      coding=71.5
//      vision=true free=false
//      price=in=USD 0.07/1M out=USD 0.25/1M
//      best=huggingface (in=USD 0.07/1M out=USD 0.25/1M)
//      proxy=proxy:no
//      bench=2149 ms
// ---------------------------------------------------------------------------

function parseNumber(text) {
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}

function parseCodingLine(line) {
	// "coding=71.5" | "coding=n/a" | "coding=66.0 plan=payg"
	const m = line.match(/coding=([0-9.]+|n\/a)/);
	if (!m || m[1] === "n/a") return null;
	return parseNumber(m[1]);
}

function parsePriceFragment(fragment) {
	// "in=USD 0.07/1M out=USD 0.25/1M" | "unavailable"
	const m = String(fragment || "").match(/in=USD\s*([0-9.]+)\/1M\s+out=USD\s*([0-9.]+)\/1M/i);
	if (!m) return { in: null, out: null };
	return { in: parseNumber(m[1]), out: parseNumber(m[2]) };
}

function parsePriceLine(line) {
	// "price=in=USD 0.07/1M out=USD 0.25/1M" | "price=n/a" | "price=unavailable"
	const rest = line.replace(/^price=/, "").trim();
	if (rest === "n/a" || rest === "unavailable" || !rest) return { in: null, out: null };
	return parsePriceFragment(rest);
}

function parseBestLine(line) {
	// "best=huggingface (in=USD 0.07/1M out=USD 0.25/1M)" | "best=unavailable (unavailable)"
	const m = line.match(/^best=(\S+)\s*\(([^)]*)\)\s*$/);
	if (!m) return { label: null, in: null, out: null };
	const [, label, inner] = m;
	if (label === "unavailable" || inner.trim() === "unavailable") return { label: null, in: null, out: null };
	return { label, ...parsePriceFragment(inner) };
}

function parseBenchLine(line) {
	// "bench=2149 ms" | "bench=errore no-endpoint"
	const rest = line.replace(/^bench=/, "").trim();
	const m = rest.match(/^(\d+)\s*ms$/);
	if (m) return { ms: Number(m[1]), error: null };
	return { ms: null, error: rest || null };
}

function parseVisionFreeLine(line) {
	return {
		vision: /vision=true/.test(line),
		free: /free=true/.test(line),
	};
}

/**
 * Parses `llmproxy provider:list`'s exact colorless text output into the
 * normalized provider list this module works with everywhere else. Never
 * throws on malformed input — an unparseable block is skipped defensively
 * rather than crashing the caller (llmProxy is a live external service and
 * its text format is not a contract this module owns).
 */
export function parseProviderListText(text) {
	const blocks = String(text || "")
		.split(/\r?\n\s*\r?\n/)
		.map((block) => block.trim())
		.filter(Boolean);
	const providers = [];
	for (const block of blocks) {
		const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		if (!lines.length) continue;
		const header = lines[0].match(/^\d+\.\s+(\S+)\s*\((.*)\)\s*$/);
		if (!header) continue; // not a provider block (stray banner/log text) — skip
		const [, id, name] = header;
		let model = "";
		let coding = null;
		let vision = false;
		let free = false;
		let price = { in: null, out: null };
		let best = { label: null, in: null, out: null };
		let bench = { ms: null, error: null };
		for (const line of lines.slice(1)) {
			if (line.startsWith("model=")) model = line.slice("model=".length).trim();
			else if (line.startsWith("coding=")) coding = parseCodingLine(line);
			else if (line.startsWith("price=")) price = parsePriceLine(line);
			else if (line.startsWith("best=")) best = parseBestLine(line);
			else if (line.startsWith("bench=")) bench = parseBenchLine(line);
			else if (line.includes("vision=") && line.includes("free=")) ({ vision, free } = parseVisionFreeLine(line));
		}
		// Prefer the provider's own live current price; when llmProxy has no
		// direct quote for this provider (e.g. subscription-based providers
		// like opencode-*, which report `price=n/a`), fall back to the best
		// known market price for the same model (`best=...`) as an estimate —
		// this is what makes the worked example's numbers line up (see
		// docs/yano-model-advisor.md).
		const priceIn = price.in ?? best.in;
		const priceOut = price.out ?? best.out;
		const benchIsError = bench.ms === null && Boolean(bench.error);
		const priceUnavailable = priceIn === null && priceOut === null;
		const codingUnavailable = coding === null;
		const available = !benchIsError && !(priceUnavailable && codingUnavailable);
		providers.push({
			id: String(id || "").trim(),
			name: String(name || id || "").trim(),
			model,
			coding,
			price_in_usd_per_1m: priceIn,
			price_out_usd_per_1m: priceOut,
			bench_ms: bench.ms,
			vision,
			free,
			available,
		});
	}
	return providers;
}

// ---------------------------------------------------------------------------
// Defensive shape validation for a hypothetical future structured
// `/api/providers` response — not exercised by the real service today (see
// note above), kept as a forward-compatible fallback so a future llmProxy
// upgrade doesn't silently break this module.
// ---------------------------------------------------------------------------

function looksLikeCliEnvelope(json) {
	return Boolean(json) && typeof json === "object" && json.data && typeof json.data.output === "string";
}

function looksLikeStructuredProviderArray(json) {
	const arr = Array.isArray(json) ? json
		: Array.isArray(json?.providers) ? json.providers
			: Array.isArray(json?.data) ? json.data
				: null;
	if (!arr || arr.length === 0) return null;
	const allLookLikeProviders = arr.every((entry) => entry && typeof entry === "object" && "id" in entry
		&& ("model" in entry || "default_model" in entry || "effective_model" in entry || "name" in entry));
	return allLookLikeProviders ? arr : null;
}

function normalizeStructuredProviders(arr) {
	return arr.map((p) => {
		const id = String(p.id ?? p.provider_id ?? "").trim();
		const name = String(p.name ?? id).trim();
		const model = String(p.model ?? p.default_model ?? p.effective_model ?? "").trim();
		const coding = typeof p.coding === "number" ? p.coding
			: typeof p.coding_score === "number" ? p.coding_score
				: typeof p.coding_info?.value === "number" ? p.coding_info.value
					: null;
		const priceIn = typeof p.price_in_usd_per_1m === "number" ? p.price_in_usd_per_1m
			: typeof p.price?.in === "number" ? p.price.in : null;
		const priceOut = typeof p.price_out_usd_per_1m === "number" ? p.price_out_usd_per_1m
			: typeof p.price?.out === "number" ? p.price.out : null;
		const benchMs = typeof p.bench_ms === "number" ? p.bench_ms
			: typeof p.bench_metric === "number" ? p.bench_metric : null;
		return {
			id,
			name,
			model,
			coding,
			price_in_usd_per_1m: priceIn,
			price_out_usd_per_1m: priceOut,
			bench_ms: benchMs,
			vision: Boolean(p.vision),
			free: Boolean(p.free ?? p.free_model),
			available: p.available !== undefined ? Boolean(p.available) : true,
		};
	}).filter((p) => p.id);
}

// ---------------------------------------------------------------------------
// Catalog fetch — HTTP first, CLI-spawn fallback, never throws for a data
// problem (only for a genuine caller error, none exist in this function).
// ---------------------------------------------------------------------------

function resolveBaseUrl(explicit) {
	if (explicit) return explicit;
	const cfg = resolveYanoConfig({});
	if (cfg.YANO_LLMPROXY_URL) return cfg.YANO_LLMPROXY_URL;
	return DEFAULT_BASE_URL;
}

function resolveApiKey(explicit) {
	if (explicit) return explicit;
	const cfg = resolveYanoConfig({});
	return cfg.YANO_LLMPROXY_API_KEY || null;
}

/** Runs `llmproxy provider:list` locally and parses its stdout. Never throws. */
export function fetchProviderCatalogFromCli({ spawnFn = spawnSync } = {}) {
	let result;
	try {
		result = spawnFn("llmproxy", ["provider:list"], { encoding: "utf8" });
	} catch (error) {
		return { ok: false, reason: `impossibile eseguire "llmproxy provider:list": ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!result) return { ok: false, reason: 'impossibile eseguire "llmproxy provider:list": nessun risultato dal processo' };
	if (result.error) return { ok: false, reason: `impossibile eseguire "llmproxy provider:list": ${result.error.message}` };
	if (typeof result.status === "number" && result.status !== 0) {
		return { ok: false, reason: `"llmproxy provider:list" uscito con codice ${result.status}${result.stderr ? `: ${String(result.stderr).trim()}` : ""}` };
	}
	const providers = parseProviderListText(String(result.stdout || ""));
	return { ok: true, source: "cli", fetched_at: new Date().toISOString(), providers };
}

/**
 * Resolves the live llmProxy provider catalog. Tries `GET {baseUrl}/api/providers`
 * first; on any failure (network error, timeout, non-2xx, unrecognized JSON
 * shape) falls back to shelling out `llmproxy provider:list` locally. If
 * BOTH fail, returns `{ ok: false, reason }` — this function never throws
 * for a data/network problem, so callers (recommend() in particular) can
 * always degrade to "use auto" instead of crashing.
 */
export async function fetchProviderCatalog({ baseUrl, apiKey, fetchFn = fetch, timeoutMs = 4000, spawnFn = spawnSync } = {}) {
	const resolvedBaseUrl = resolveBaseUrl(baseUrl);
	const resolvedApiKey = resolveApiKey(apiKey);
	let httpError = null;
	try {
		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
		let res;
		try {
			const headers = { Accept: "application/json" };
			if (resolvedApiKey) headers.Authorization = `Bearer ${resolvedApiKey}`;
			res = await fetchFn(`${String(resolvedBaseUrl).replace(/\/+$/, "")}/api/providers`, {
				method: "GET",
				headers,
				signal: controller ? controller.signal : undefined,
			});
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "nessuna risposta"}`);
		const json = await res.json();
		if (looksLikeCliEnvelope(json)) {
			if (json.success === false) throw new Error(`llmproxy provider:list ha fallito lato server: ${json.data?.error || "errore sconosciuto"}`);
			return { ok: true, source: "http", fetched_at: new Date().toISOString(), providers: parseProviderListText(json.data.output) };
		}
		const structured = looksLikeStructuredProviderArray(json);
		if (structured) return { ok: true, source: "http", fetched_at: new Date().toISOString(), providers: normalizeStructuredProviders(structured) };
		throw new Error("forma della risposta di GET /api/providers non riconosciuta");
	} catch (error) {
		httpError = error instanceof Error ? error.message : String(error);
	}
	const cliResult = fetchProviderCatalogFromCli({ spawnFn });
	if (cliResult.ok) return cliResult;
	return {
		ok: false,
		reason: `impossibile contattare llmProxy su ${resolvedBaseUrl} (${httpError}); fallback CLI fallito a sua volta: ${cliResult.reason}`,
	};
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function blendedPrice(provider) {
	if (provider.price_in_usd_per_1m == null || provider.price_out_usd_per_1m == null) return null;
	return (provider.price_in_usd_per_1m + provider.price_out_usd_per_1m) / 2;
}

function rankPricedEntries(entries, roleClass) {
	const list = entries.slice();
	if (roleClass === "coordinator") {
		// Highest intelligence wins among entries already filtered to the
		// affordable band; price only breaks ties.
		list.sort((a, b) => (b.coding ?? -Infinity) - (a.coding ?? -Infinity)
			|| a.blended_price_usd_per_1m - b.blended_price_usd_per_1m);
		return list;
	}
	// support: cheapest-that's-good-enough. Entries below the coding floor
	// are only considered if NOTHING clears the floor (better than nothing).
	const eligible = list.filter((p) => (p.coding ?? -Infinity) >= SUPPORT_MIN_CODING_FLOOR);
	const pool = eligible.length > 0 ? eligible : list;
	pool.sort((a, b) => a.blended_price_usd_per_1m - b.blended_price_usd_per_1m
		|| (b.coding ?? -Infinity) - (a.coding ?? -Infinity));
	return pool;
}

function reasonFor(entry, roleClass, { cheapest, affordableCeiling, bandRelaxed, noPriceData } = {}) {
	const codingLabel = entry.coding == null ? "n/a" : entry.coding;
	if (noPriceData) return `coding=${codingLabel}, nessun dato di prezzo disponibile in tutto il catalogo — scelto solo per punteggio coding (band_relaxed)`;
	if (entry.blended_price_usd_per_1m == null) return `coding=${codingLabel}, prezzo non disponibile per questo provider — non può vincere di default`;
	const blended = entry.blended_price_usd_per_1m;
	if (roleClass === "coordinator") {
		if (bandRelaxed) return `coding=${codingLabel}, prezzo=${blended.toFixed(3)} USD/1M — fuori dalla fascia economica ma migliore alternativa disponibile (band_relaxed)`;
		return `coding=${codingLabel}, entro ${AFFORDABLE_BAND_MULTIPLIER}x del più economico (${blended.toFixed(2)} vs ${cheapest.toFixed(3)} USD/1M), miglior punteggio coding nella fascia economica`;
	}
	const floorNote = (entry.coding ?? -Infinity) >= SUPPORT_MIN_CODING_FLOOR
		? `>= soglia ${SUPPORT_MIN_CODING_FLOOR}`
		: `sotto soglia ${SUPPORT_MIN_CODING_FLOOR} ma nessuna alternativa idonea disponibile`;
	return `prezzo=${blended.toFixed(3)} USD/1M, coding=${codingLabel} (${floorNote}), opzione più economica idonea`;
}

/**
 * Ranks a fetched catalog for a given role class. Never throws for a data
 * problem — an empty/unusable catalog yields `{ ranked: [], band_relaxed: false }`,
 * which callers (recommend()) treat as "use auto".
 */
export function scoreCatalog(catalog, { roleClass, requireVision = false } = {}) {
	if (roleClass !== "coordinator" && roleClass !== "support") {
		throw new Error(`yano model-advisor: roleClass non valido "${roleClass}" (ammessi: coordinator, support)`);
	}
	const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
	const pool = providers.filter((p) => p.available && (!requireVision || p.vision));
	if (pool.length === 0) return { ranked: [], band_relaxed: false };

	const withBlended = pool.map((p) => ({ ...p, blended_price_usd_per_1m: blendedPrice(p) }));
	const knownPriced = withBlended.filter((p) => p.blended_price_usd_per_1m !== null);
	const unknownPriced = withBlended.filter((p) => p.blended_price_usd_per_1m === null);

	if (knownPriced.length === 0) {
		// No usable price data anywhere in the catalog — fall back to the
		// single overall-best-by-coding entry rather than returning nothing.
		const ranked = unknownPriced
			.slice()
			.sort((a, b) => (b.coding ?? -Infinity) - (a.coding ?? -Infinity))
			.map((entry) => ({ ...entry, pinned_id: llmProxyPin(entry), reason: reasonFor(entry, roleClass, { noPriceData: true }) }));
		return { ranked, band_relaxed: ranked.length > 0 };
	}

	const cheapest = Math.min(...knownPriced.map((p) => p.blended_price_usd_per_1m));
	const affordableCeiling = cheapest * AFFORDABLE_BAND_MULTIPLIER;
	const affordable = knownPriced.filter((p) => p.blended_price_usd_per_1m <= affordableCeiling);

	// cheapest is always <= cheapest * AFFORDABLE_BAND_MULTIPLIER (multiplier
	// >= 1), so `affordable` can only be empty here if knownPriced itself was
	// empty — already handled above. This guard stays for safety/future
	// tuning (e.g. someone setting the multiplier below 1).
	const bandRelaxed = affordable.length === 0;
	const candidatePool = bandRelaxed ? knownPriced : affordable;

	const rankedPriced = rankPricedEntries(candidatePool, roleClass)
		.map((entry) => ({ ...entry, pinned_id: llmProxyPin(entry), reason: reasonFor(entry, roleClass, { cheapest, affordableCeiling, bandRelaxed }) }));
	// Unknown-priced entries are always listed as low-priority alternatives —
	// they never win by default over a priced entry.
	const rankedUnknown = unknownPriced
		.slice()
		.sort((a, b) => (b.coding ?? -Infinity) - (a.coding ?? -Infinity))
		.map((entry) => ({ ...entry, pinned_id: llmProxyPin(entry), reason: reasonFor(entry, roleClass, {}) }));

	return { ranked: [...rankedPriced, ...rankedUnknown], band_relaxed: bandRelaxed };
}

// ---------------------------------------------------------------------------
// recommend() — ties fetch + scoring together, never throws for a data
// problem (only for a genuine programmer error like an invalid roleClass).
// ---------------------------------------------------------------------------

export async function recommend({ roleClass, requireVision = false, baseUrl, apiKey, fetchFn, timeoutMs, spawnFn } = {}) {
	if (roleClass !== "coordinator" && roleClass !== "support") {
		throw new Error(`yano model-advisor: roleClass non valido "${roleClass}" (ammessi: coordinator, support)`);
	}
	const autoFallback = { pinned_id: null, model: "llmproxy", reason: "usa il routing dinamico di llmProxy (nessun pin) — dati del catalogo insufficienti o assenti" };

	const catalog = await fetchProviderCatalog({ baseUrl, apiKey, fetchFn, timeoutMs, spawnFn });
	if (!catalog.ok) {
		return {
			recommended: null,
			alternatives: [],
			auto_fallback: { ...autoFallback, reason: `llmProxy non raggiungibile: ${catalog.reason}` },
			catalog_ok: false,
		};
	}

	const { ranked, band_relaxed } = scoreCatalog(catalog, { roleClass, requireVision });
	if (ranked.length === 0) {
		return {
			recommended: null,
			alternatives: [],
			auto_fallback: { ...autoFallback, reason: "catalogo llmProxy raggiungibile ma nessun provider disponibile/idoneo — uso auto" },
			catalog_ok: true,
		};
	}

	return {
		recommended: ranked[0],
		alternatives: ranked.slice(1),
		auto_fallback: autoFallback,
		catalog_ok: true,
		band_relaxed,
		catalog_source: catalog.source,
		catalog_fetched_at: catalog.fetched_at,
	};
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
	return [
		"Uso: yano model-advisor <recommend|catalog|explain> [opzioni]",
		"",
		"  recommend --role-class coordinator|support [--vision] [--json]",
		"                        propone un pin llmProxy model@provider-id per la role-class indicata,",
		"                        in base al catalogo live di llmProxy (costo/coding/latenza).",
		"                        Senza dati utilizzabili propone sempre l'auto-routing (\"llmproxy\").",
		"  catalog [--json]      stampa il catalogo llmProxy normalizzato così com'è ora",
		"                        (utile per il planner o un umano prima di decidere).",
		"  explain --role-class coordinator|support [--vision] [--json]",
		"                        come recommend, ma stampa l'intera classifica con i motivi",
		"                        di ciascuna posizione invece della sola scelta migliore.",
		"",
		"Opzioni comuni:",
		"  --base-url <url>      default: YANO_LLMPROXY_URL oppure http://127.0.0.1:7045",
		"  --api-key <key>       default: YANO_LLMPROXY_API_KEY (yano config set YANO_LLMPROXY_API_KEY --stdin)",
		"",
		"Questo incremento è solo libreria + CLI: nessun server REST (a differenza di",
		"yano debugger/auto-improve/suggester) — vedi docs/yano-model-advisor.md.",
	].join("\n");
}

function print(value_, machine) {
	console.log(JSON.stringify(value_, null, 2));
	void machine;
}

function formatEntryLine(entry, index) {
	const coding = entry.coding == null ? "n/a" : entry.coding;
	const price = entry.blended_price_usd_per_1m == null ? "n/a" : `${entry.blended_price_usd_per_1m.toFixed(3)} USD/1M`;
	const bench = entry.bench_ms == null ? "n/a" : `${entry.bench_ms} ms`;
	return [
		`${index + 1}. ${entry.pinned_id}`,
		`   coding=${coding}  prezzo=${price}  bench=${bench}  vision=${entry.vision}`,
		`   motivo: ${entry.reason}`,
	].join("\n");
}

function printRecommend(result, json) {
	if (json) { print(result, true); return; }
	if (!result.recommended) {
		console.log(`Nessuna raccomandazione pinnata (${result.catalog_ok ? "catalogo ok ma nessun candidato idoneo" : "catalogo non raggiungibile"}).`);
		console.log(`Fallback: model=${result.auto_fallback.model} — ${result.auto_fallback.reason}`);
		return;
	}
	console.log(`Raccomandato: ${result.recommended.pinned_id}`);
	console.log(formatEntryLine(result.recommended, 0));
	if (result.band_relaxed) console.log("(band_relaxed: fascia economica non disponibile, scelta la migliore alternativa fuori fascia)");
	if (result.alternatives.length) {
		console.log("");
		console.log("Alternative:");
		for (const [index, entry] of result.alternatives.entries()) console.log(formatEntryLine(entry, index + 1));
	}
}

function printCatalog(catalog, json) {
	if (json) { print(catalog, true); return; }
	if (!catalog.ok) { console.log(`Catalogo non disponibile: ${catalog.reason}`); return; }
	console.log(`Catalogo llmProxy (source=${catalog.source}, fetched_at=${catalog.fetched_at}):`);
	for (const [index, p] of catalog.providers.entries()) {
		const coding = p.coding == null ? "n/a" : p.coding;
		const priceIn = p.price_in_usd_per_1m == null ? "n/a" : p.price_in_usd_per_1m;
		const priceOut = p.price_out_usd_per_1m == null ? "n/a" : p.price_out_usd_per_1m;
		const bench = p.bench_ms == null ? "n/a" : `${p.bench_ms} ms`;
		console.log(`${index + 1}. ${p.id}:${p.model} — coding=${coding} price(in/out)=${priceIn}/${priceOut} bench=${bench} vision=${p.vision} available=${p.available}`);
	}
}

export async function runYanoModelAdvisor({ argv = [] } = {}) {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { console.log(usage()); return; }
	const opts = {
		roleClass: value(argv, "--role-class"),
		requireVision: has(argv, "--vision"),
		json: has(argv, "--json"),
		baseUrl: value(argv, "--base-url") || undefined,
		apiKey: value(argv, "--api-key") || undefined,
	};
	if (sub === "catalog") {
		const catalog = await fetchProviderCatalog({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
		printCatalog(catalog, opts.json);
		return catalog;
	}
	if (sub === "recommend" || sub === "explain") {
		if (!opts.roleClass) throw new Error(`yano model-advisor ${sub}: --role-class è obbligatorio (coordinator|support).\n${usage()}`);
		const result = await recommend({ roleClass: opts.roleClass, requireVision: opts.requireVision, baseUrl: opts.baseUrl, apiKey: opts.apiKey });
		if (sub === "explain" && !opts.json) {
			if (!result.recommended) { printRecommend(result, false); return result; }
			console.log(`Classifica completa (${result.recommended ? [result.recommended, ...result.alternatives].length : 0} candidati):`);
			for (const [index, entry] of [result.recommended, ...result.alternatives].entries()) console.log(formatEntryLine(entry, index));
			return result;
		}
		printRecommend(result, opts.json);
		return result;
	}
	throw new Error(`yano model-advisor: comando sconosciuto "${sub}".\n${usage()}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runYanoModelAdvisor({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano model-advisor: ${error.message}`); process.exit(1); });
