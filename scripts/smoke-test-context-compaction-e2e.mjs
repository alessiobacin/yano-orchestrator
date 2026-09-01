// E2E context telemetry + watcher-driven native Pi compaction.
//
// This exercises the real extensions/orchestrator.ts over a real MQTT broker
// and the real external watcher. The fake Pi host only supplies the minimum
// ExtensionContext surface; compaction, trace, presence and watcher routing
// all go through production code.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readTraceRecords } from "./yano-trace-storage.mjs";
import { runWatch } from "./watch-stalls.mjs";

const PACKAGE_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const project = "context-compaction-smoke";
let PASS = 0;

function ok(condition, message) {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
	PASS++;
	console.log(`   OK — ${message}`);
}

function makeHarness(flagValues) {
	const hooks = new Map();
	const tools = new Map();
	const appendedEntries = [];
	const pi = {
		registerFlag() {},
		getFlag(name) { return flagValues[name]; },
		registerTool(definition) { tools.set(definition.name, definition); },
		registerCommand() {},
		on(name, handler) { hooks.set(name, handler); },
		appendEntry(kind, data) { appendedEntries.push({ kind, data }); },
		sendMessage() {},
	};
	const ctx = {
		cwd: flagValues.cwd,
		hasUI: false,
		model: { contextWindow: 1000 },
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getBranch: () => ctx._branch },
		_branch: [],
		_usage: { tokens: 950, contextWindow: 1000, percent: 95 },
		getContextUsage: () => ctx._usage,
		compact(options = {}) {
			ctx._compactCalls++;
			const tokensBefore = ctx._usage.tokens;
			ctx._branch = [
				{ type: "compaction", id: "compact-1", summary: "Obiettivo e decisioni preservati; riprendere il task dal prossimo passo.", tokensBefore },
				{ type: "message", message: { role: "user", content: "Continua dal riepilogo compattato." } },
			];
			ctx._usage = { tokens: 180, contextWindow: 1000, percent: 18 };
			const result = { summary: "Obiettivo e decisioni preservati; riprendere il task dal prossimo passo.", firstKeptEntryId: "compact-1", tokensBefore, estimatedTokensAfter: 180 };
			if (options.onComplete) options.onComplete(result);
			const compactHook = hooks.get("session_compact");
			if (compactHook) void compactHook({ reason: "manual", fromExtension: false, willRetry: false, compactionEntry: result }, ctx);
		},
		_compactCalls: 0,
	};
	return { pi, ctx, hooks, tools, appendedEntries };
}

async function call(harness, name, params = {}) {
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`tool non registrato: ${name}`);
	return tool.execute(`context-smoke-${name}`, params);
}

async function waitFor(predicate, message, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timeout: ${message}`);
}

async function main() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-context-data-"));
	process.env.YANO_DATA_DIR = dataDir;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "yano-context-project-"));
	fs.mkdirSync(path.join(cwd, "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: project }, null, 2));
	fs.writeFileSync(path.join(cwd, "agents", "roles.yaml"), "roles:\n  planner: {}\n");

	const harness = makeHarness({ instance: "planner-01", role: "planner", project, cwd, broker: BROKER_URL, "config-dir": "agents", "prompts-dir": "prompts" });
	const module = await import(pathToFileURL(path.join(PACKAGE_ROOT, "extensions", "orchestrator.ts")).href);
	module.default(harness.pi);
	await harness.hooks.get("session_start")({}, harness.ctx);
	await waitFor(() => harness.appendedEntries.some((entry) => entry.data?.event === "connected"), "planner MQTT connected");

	console.log("Context compaction E2E — telemetry, watcher request, native restart.\n");
	await call(harness, "orchestrator_init");
	const turnEnd = harness.hooks.get("turn_end");
	harness.ctx._branch = [{ type: "message", message: { role: "assistant", content: "x".repeat(4000) } }];
	await turnEnd({ turnIndex: 1 }, harness.ctx);

	const before = readTraceRecords({ cwd, project, limit: 1000 });
	const high = before.filter((record) => record.type === "context_usage" && record.point === "turn_end").at(-1);
	ok(high?.context_tokens === 950, "la sessione registra i token di contesto effettivi");
	ok(high?.context_window_tokens === 1000 && high?.context_ratio === 0.95, "il log registra finestra e rapporto del contesto");
	ok(high?.context_chars > 4000 && high?.context_entries === 1, "il log registra anche dimensione serializzata e numero entry");

	const firstScan = await runWatch({ cwd, argv: ["--project-root", cwd, "--project", project, "--once", "--lookback-ms", "3600000", "--context-compact-ratio", "0.8"], packageRoot: PACKAGE_ROOT });
	ok(firstScan.status === "finding", "il watcher classifica il contesto oltre soglia come finding");
	await waitFor(() => harness.ctx._compactCalls === 1, "richiesta MQTT di compaction ricevuta dall'agente");

	const after = readTraceRecords({ cwd, project, limit: 1000 });
	ok(after.some((record) => record.type === "yano_watcher_context_check" && record.status === "high"), "il watcher registra il controllo context high");
	ok(after.some((record) => record.type === "yano_watcher_notification_route" && record.signal === "context_compaction_requested" && record.route === "agent"), "il watcher registra il routing diretto all'agente");
	ok(after.some((record) => record.type === "context_compaction_completed" && record.restart_mode === "pi_native_compaction"), "la summarization termina con restart nativo Pi tracciato");
	const compacted = after.filter((record) => record.type === "context_usage" && record.point === "compact_completed").at(-1);
	ok(compacted?.effective_context_tokens === 180 && compacted?.context_ratio === 0.18, "dopo compaction il contesto osservato è più basso");

	const secondScan = await runWatch({ cwd, argv: ["--project-root", cwd, "--project", project, "--once", "--lookback-ms", "3600000", "--context-compact-ratio", "0.8"], packageRoot: PACKAGE_ROOT });
	ok(secondScan.status === "healthy", "una scansione successiva non riapre la compaction già completata");
	ok(harness.ctx._compactCalls === 1, "la compaction è idempotente e non viene ripetuta inutilmente");

	const shutdown = harness.hooks.get("session_shutdown");
	if (shutdown) await shutdown({}, harness.ctx);
	console.log(`\nsmoke-test-context-compaction-e2e: OK (${PASS} assertions)`);
}

main().catch((error) => {
	console.error(`smoke-test-context-compaction-e2e: FAIL — ${error.stack || error.message}`);
	process.exitCode = 1;
});

