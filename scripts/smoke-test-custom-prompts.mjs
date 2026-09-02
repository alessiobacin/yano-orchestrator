// REAL end-to-end test of `--custom-prompts` (Revisione 47) against the
// ACTUAL extensions/orchestrator.ts — not a hand-copied mirror (see
// scripts/e2e-full-flow.mjs's header comment for why that distinction
// matters in this project). Dynamically imports the real extension, drives
// its real session_start/before_agent_start hooks over a real local
// mosquitto broker, and inspects the REAL systemPrompt text
// before_agent_start actually returns.
//
// What this proves, against real code:
//   1. By DEFAULT (no --custom-prompts), role prompts are read from the
//      INSTALLED PACKAGE's own prompts/ folder (resolveGlobalPromptsDir(),
//      resolved from this very file's real location) — a local
//      .pi/extensions/yano-orchestrator/prompts/ copy is completely
//      IGNORED even when one exists with different content. This is the
//      actual fix for the Revisione 46 bug: a project's prompts can never
//      again silently fall behind after `yano update`.
//   2. With --custom-prompts, a role WITH a local override uses it.
//   3. With --custom-prompts, a role WITHOUT a local override (the local
//      prompts/ dir exists but doesn't have that specific <role>.md) still
//      falls back to the package's current prompt for that role — per-file
//      fallback, not all-or-nothing, so customizing one role never freezes
//      every other role's prompt at copy time.
//   4. With --custom-prompts but the local prompts/ directory missing
//      entirely (never ran `yano copy-prompts`), everything falls back to the
//      package's prompts — no crash, no missing-instructions agent.
//
// Usage: node --experimental-strip-types scripts/smoke-test-custom-prompts.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const REAL_AGENTS_DIR = path.join(PROJECT_ROOT, "agents");
const REAL_PROMPTS_DIR = path.join(PROJECT_ROOT, "prompts");
// Keep this prompt-shape test independent from the operator's persistent
// planner rules configured in the real global data root.
process.env.YANO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yano-custom-prompts-data-"));

let PASS = 0;
function ok(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	PASS++;
	console.log(`   OK — ${msg}`);
}

async function git(args, cwd) {
	return execFileP("git", args, { cwd });
}

async function makeScratchProject(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
	await git(["init", "-q", "-b", "main"], dir);
	await git(["config", "user.email", "e2e@test.local"], dir);
	await git(["config", "user.name", "E2E Harness"], dir);
	fs.writeFileSync(path.join(dir, "README.md"), "# scratch project (custom-prompts e2e harness)\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-q", "-m", "initial"], dir);
	return dir;
}

// ━━ Minimal fake pi / ctx harness (self-contained — see e2e-full-flow.mjs
// for the fuller version this mirrors; only what before_agent_start needs) ━━

function makeFakePi(flagValues) {
	const hooks = new Map();
	const appendedEntries = [];
	const pi = {
		registerFlag() {},
		getFlag(name) { return flagValues[name]; },
		registerTool() {},
		on(event, handler) { hooks.set(event, handler); },
		registerCommand() {},
		appendEntry(kind, data) { appendedEntries.push({ kind, data }); },
		sendMessage() {},
	};
	return { pi, hooks, appendedEntries };
}

function makeCtx(cwd) {
	return {
		cwd,
		hasUI: true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getBranch() { return []; } },
	};
}

let modPromise;
async function loadRealModule() {
	if (!modPromise) modPromise = import(pathToFileURL(path.join(PROJECT_ROOT, "extensions", "orchestrator.ts")).href);
	return modPromise;
}

async function getSystemPrompt({ cwd, instance, role, customPrompts, promptsDir }) {
	const flagValues = {
		instance,
		role,
		project: "custom-prompts-e2e",
		broker: BROKER_URL,
		"config-dir": REAL_AGENTS_DIR, // absolute — real roles.yaml/agents.yaml, no need to copy them per scratch dir
		...(promptsDir ? { "prompts-dir": promptsDir } : {}),
		...(customPrompts ? { "custom-prompts": true } : {}),
	};
	const harness = makeFakePi(flagValues);
	const ctx = makeCtx(cwd);
	const mod = await loadRealModule();
	mod.default(harness.pi);

	const sessionStart = harness.hooks.get("session_start");
	if (!sessionStart) throw new Error("session_start hook not registered");
	await sessionStart({}, ctx);

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (harness.appendedEntries.some((e) => e.data?.event === "connected")) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!harness.appendedEntries.some((e) => e.data?.event === "connected")) {
		throw new Error(`${instance}: never saw MQTT "connected" event within 8s — is mosquitto running on ${BROKER_URL}?`);
	}

	const beforeAgentStart = harness.hooks.get("before_agent_start");
	const result = await beforeAgentStart({}, ctx);

	const shutdown = harness.hooks.get("session_shutdown");
	if (shutdown) await shutdown({}, ctx);

	return result?.systemPrompt || "";
}

async function main() {
	const realCoderMd = fs.readFileSync(path.join(REAL_PROMPTS_DIR, "coder.md"), "utf8");
	const realReviewerMd = fs.readFileSync(path.join(REAL_PROMPTS_DIR, "reviewer.md"), "utf8");
	const realPlannerMd = fs.readFileSync(path.join(REAL_PROMPTS_DIR, "planner.md"), "utf8");
	const CUSTOM_CODER_MARKER = "CUSTOM-CODER-MARKER-CONTENT-{{INSTANCE}}-{{PROJECT}}";

	console.log("\n=== Setup — two scratch projects: one with a local custom prompts/ copy, one with none at all ===");
	const projectWithLocal = await makeScratchProject("custom-prompts-with-local");
	const localPromptsDir = path.join(projectWithLocal, ".pi", "extensions", "yano-orchestrator", "prompts");
	fs.mkdirSync(localPromptsDir, { recursive: true });
	// Deliberately customize ONLY coder.md — reviewer.md/planner.md are NOT
	// present locally, to prove the per-file fallback (point 3 above).
	fs.writeFileSync(path.join(localPromptsDir, "coder.md"), CUSTOM_CODER_MARKER);
	const projectNoLocal = await makeScratchProject("custom-prompts-no-local");
	ok(!fs.existsSync(path.join(projectNoLocal, ".pi")), "sanity check: the second scratch project has no .pi/ at all (matches `yano init`'s new default, Revisione 47)");

	console.log("\n=== Scenario 1 — DEFAULT (no --custom-prompts): the local override is completely ignored, global package prompt wins ===");
	const promptDefault = await getSystemPrompt({ cwd: projectWithLocal, instance: "coder-e2e-01", role: "coder", customPrompts: false });
	ok(!promptDefault.includes("CUSTOM-CODER-MARKER-CONTENT"), "local coder.md customization is NOT used without --custom-prompts, even though the file exists");
	ok(promptDefault === renderTemplate(realCoderMd, "coder-e2e-01", "custom-prompts-e2e"), "systemPrompt matches the package's real coder.md, rendered — this is the actual fix for the Revisione 46 staleness bug");

	console.log("\n=== Scenario 2 — --custom-prompts with a local override present: the local version is used ===");
	const promptCustomHit = await getSystemPrompt({ cwd: projectWithLocal, instance: "coder-e2e-02", role: "coder", customPrompts: true });
	ok(promptCustomHit.includes("CUSTOM-CODER-MARKER-CONTENT"), "with --custom-prompts, the project's own local coder.md IS used");
	ok(promptCustomHit.includes("coder-e2e-02"), "{{INSTANCE}} still gets rendered into the custom prompt template");

	console.log("\n=== Scenario 3 — --custom-prompts but THIS role has no local file (per-file fallback, not all-or-nothing) ===");
	const promptCustomMiss = await getSystemPrompt({ cwd: projectWithLocal, instance: "reviewer-e2e-01", role: "reviewer", customPrompts: true });
	ok(promptCustomMiss === renderTemplate(realReviewerMd, "reviewer-e2e-01", "custom-prompts-e2e"), "reviewer.md was never customized locally — falls back to the package's current reviewer.md, even though --custom-prompts is on and the local prompts/ dir exists (just without this file)");

	console.log("\n=== Scenario 4 — --custom-prompts but the local prompts/ directory doesn't exist AT ALL (never ran `yano copy-prompts`) ===");
	const promptNoLocalDir = await getSystemPrompt({ cwd: projectNoLocal, instance: "planner-e2e-01", role: "planner", customPrompts: true });
	ok(promptNoLocalDir === renderTemplate(realPlannerMd, "planner-e2e-01", "custom-prompts-e2e"), "with no local prompts/ directory at all, --custom-prompts falls back fully to the package's planner.md — no crash, no missing instructions");

	console.log(`\n${PASS} assertions passed.`);
	console.log("CUSTOM-PROMPTS E2E TEST PASSED");
	process.exit(0);
}

// Revisione 49 — extensions/orchestrator.ts also fills 5 shared-fragment
// placeholders (SLUG_REMINDER, WORKER_TOOLS_INTRO, DIAGRAM_TIP,
// TURN_CLOSE_NOTE, TICKET_CLAIM_STEP0) on every role's prompt, coder.md and
// reviewer.md included — mirrored here verbatim (not imported, same reason
// as below) so the exact-render comparisons below still match byte-for-byte.
const SLUG_REMINDER =
	"**Passa sempre `slug` a `agent_send`**: aggiunge in automatico una riga di\n" +
	"evento al report con orario e stato di tutti gli agenti in quel momento —\n" +
	"non serve che tu scriva nulla per questo, ma serve che tu passi `slug`.";
const WORKER_TOOLS_INTRO =
	"Hai a disposizione i tool `agent_list`, `agent_send`, `agent_get`, `agent_await`,\n" +
	"`agent_publish_event`, `agent_activity` per comunicare con gli altri agenti via MQTT,\n" +
	"il tool `worktree_create` per creare/riusare il worktree git isolato di un task,\n" +
	"`report_append` per aggiungere sezioni al file di report senza rischiare di\n" +
	"cancellare quelle di altri agenti, e `file_claim`/`file_release` per coordinarti sui\n" +
	"file quando altri agenti lavorano lo stesso worktree in parallelo (vedi sotto),\n" +
	"oltre ai normali tool per leggere/scrivere file.";
const DIAGRAM_TIP =
	"## Prima di iniziare: leggi il diagramma, se esiste (Revisione 28)\n\n" +
	"Prima di esplorare il codice esistente da zero, controlla se esiste\n" +
	"`.pi/extensions/yano-orchestrator/diagrams/architecture.mmd` (nella\n" +
	"directory principale del progetto, non nel worktree — è uno stato\n" +
	"persistente cross-task, aggiornato da `architecture-diagrammer` o da\n" +
	"`docs-sync`) e leggilo: ti dà un'orientamento immediato sull'architettura\n" +
	"corrente senza dover ricostruirla leggendo ogni file — risparmia token. Non\n" +
	"è garantito che esista — se manca, procedi come sempre.";
const TURN_CLOSE_NOTE =
	"## Prima di concludere il turno: dillo sempre (Revisione 48)\n\n" +
	"Richiesta esplicita dell'operatore: nella tua ULTIMA risposta di questo\n" +
	"turno — quella visibile nel pannello/terminale di questa istanza, non solo\n" +
	"nel messaggio MQTT che mandi con `agent_send` o nella sezione che aggiungi\n" +
	"con `report_append` — di' sempre, in una riga o poche righe, cosa hai appena\n" +
	"fatto. Chi guarda il pannello di questa istanza deve poter capire l'esito\n" +
	"senza dover aprire i log MQTT o il file di report.";
const TICKET_CLAIM_STEP0 =
	"0. **Se il messaggio che ti ha coinvolto include anche un `ticket_id`\n" +
	"   (Revisione 26 — layer ticket/DAG persistente)**, chiama subito\n" +
	"   `ticket_claim({ ticket_id })` prima di iniziare — registra questa\n" +
	"   istanza come assegnataria sul layer persistente, non solo sul piano a\n" +
	"   fasi del planner. Se rifiuta (ticket già claimato, o capability\n" +
	"   mancanti), fermati e segnalalo nel report invece di procedere. **Non\n" +
	"   chiamare mai tu `ticket_complete`**: è il planner a deciderlo, quando\n" +
	"   giudica il tuo contributo concluso (vedi `prompts/planner.md`), non\n" +
	"   appena hai finito. Se il messaggio non include un `ticket_id`, procedi\n" +
	"   normalmente: quel layer resta opzionale dal tuo punto di vista.";

// Same placeholder substitution the extension itself does, so assertions can
// compare against an exact expected render rather than a loose substring —
// intentionally duplicated (not imported) since the real replaceAll chain
// lives inside the extension's closure, not exported.
function renderTemplate(text, instance, project) {
	return text
		.replaceAll("{{INSTANCE}}", instance)
		.replaceAll("{{ROLE}}", "") // roleCfg is looked up per real role in the extension; planner/coder/reviewer templates don't use {{ROLE}}/{{ROLE_LABEL}}/{{BRIEF}}
		.replaceAll("{{ROLE_LABEL}}", "")
		.replaceAll("{{BRIEF}}", "")
		.replaceAll("{{PROJECT}}", project)
		// An explicit --role now resolves the role defaults even when the
		// instance has no agents.yaml entry (including its team membership).
		.replaceAll("{{TEAM}}", "core")
		.replaceAll("{{SLUG_REMINDER}}", SLUG_REMINDER)
		.replaceAll("{{WORKER_TOOLS_INTRO}}", WORKER_TOOLS_INTRO)
		.replaceAll("{{DIAGRAM_TIP}}", DIAGRAM_TIP)
		.replaceAll("{{TURN_CLOSE_NOTE}}", TURN_CLOSE_NOTE)
		.replaceAll("{{TICKET_CLAIM_STEP0}}", TICKET_CLAIM_STEP0);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : String(err));
	process.exit(1);
});
