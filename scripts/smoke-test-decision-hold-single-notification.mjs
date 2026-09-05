// Real test for Fase 3 of the cron/watcher/scheduler restructuring: a
// decision_hold ("the planner is waiting for the user's answer") must send
// AT MOST ONE "waiting for your reply" notification for its entire
// lifetime, never once per decision_hold_create call. Before this fix there
// was no guard at all — a retried/duplicated decision_hold_create call (the
// tool is deliberately idempotent by (run_id, idempotency_key), exactly so
// a flaky agent turn can safely retry it) would have sent the notification
// again on every retry.
//
// Uses the REAL extensions/orchestrator.ts against a real local mosquitto
// broker and real SQLite, same technique as smoke-test-ticket-engine.mjs —
// trimmed to only what decision_hold_create needs (no ticket/DAG setup).
//
// Usage: node scripts/smoke-test-decision-hold-single-notification.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { readTraceRecords } from "./yano-trace-storage.mjs";

const execFileP = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
// Isolate from the REAL machine's global Yano config. Fase 0 made
// sendNotifications() fall back to the global notification channel when a
// project has no local .env — on a real developer machine with real
// Telegram/WhatsApp credentials configured globally, an unisolated test
// that exercises a decision_hold notification WILL send a real message.
// This must be set before extensions/orchestrator.ts is imported below.
process.env.YANO_CONFIG_FILE = path.join(os.tmpdir(), "yano-decision-hold-notify-no-such-config.env");

const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";

let PASS = 0;
function ok(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	PASS++;
	console.log(`   OK — ${msg}`);
}

async function git(args, cwd) { return execFileP("git", args, { cwd }); }

async function bootstrapScratchRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-decision-hold-notify-"));
	await git(["init", "-q"], dir);
	await git(["config", "user.email", "decision-hold-test@test.local"], dir);
	await git(["config", "user.name", "Decision Hold Test"], dir);
	fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
	for (const f of ["agents.yaml", "roles.yaml"]) fs.copyFileSync(path.join(PROJECT_ROOT, "agents", f), path.join(dir, "agents", f));
	fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nlogs/\n.pi/\n");
	// Deliberately NO .env and no global config: every channel resolves to
	// "not configured" so sendNotifications() returns immediately with no
	// real network call — fast and deterministic — while still exercising the
	// exact same logEvent("notification_dispatch", ...) call this test checks.
	await git(["add", "-A"], dir);
	await git(["commit", "-q", "-m", "initial scratch repo"], dir);
	return dir;
}

function makeFakePi(flagValues) {
	const tools = new Map();
	const hooks = new Map();
	const appendedEntries = [];
	const pi = {
		registerFlag() {},
		getFlag(name) { return flagValues[name]; },
		registerTool(def) { tools.set(def.name, def); },
		on(event, handler) { hooks.set(event, handler); },
		registerCommand() {},
		appendEntry(kind, data) { appendedEntries.push({ kind, data }); },
		sendMessage() {},
	};
	return { pi, tools, hooks, appendedEntries };
}
function makeCtx(cwd) {
	return { cwd, hasUI: false, ui: { notify() {}, setWidget() {} }, sessionManager: { getBranch() { return []; } } };
}

let modPromiseCache = null;
const ALL_INSTANCES = [];
class FakeInstance {
	constructor(label, flagValues, cwd) {
		this.label = label;
		this.harness = makeFakePi(flagValues);
		this.ctx = makeCtx(cwd);
	}
	async start() {
		const modUrl = pathToFileURL(path.join(PROJECT_ROOT, "extensions", "orchestrator.ts")).href;
		if (!modPromiseCache) modPromiseCache = import(modUrl);
		const mod = await modPromiseCache;
		mod.default(this.harness.pi);
		const sessionStart = this.harness.hooks.get("session_start");
		await sessionStart({}, this.ctx);
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			if (this.harness.appendedEntries.some((e) => e.data?.event === "connected")) return this;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`${this.label}: never saw MQTT "connected" — is mosquitto running on ${BROKER_URL}?`);
	}
	tool(name) {
		const t = this.harness.tools.get(name);
		if (!t) throw new Error(`${this.label}: no tool registered named "${name}"`);
		return t;
	}
	async call(name, params = {}) { return this.tool(name).execute("call-" + Math.random().toString(36).slice(2), params); }
	async shutdown() { const hook = this.harness.hooks.get("session_shutdown"); if (hook) await hook({}, this.ctx); }
}
async function makeInstance(label, instance, role, cwd, project) {
	const fi = new FakeInstance(label, { instance, role, project, broker: BROKER_URL, "config-dir": "agents", "prompts-dir": "prompts" }, cwd);
	ALL_INSTANCES.push(fi);
	await fi.start();
	return fi;
}

function notificationDispatchEvents(cwd, project, hold_id) {
	return readTraceRecords({ cwd, project, limit: 10000 }).filter((record) => record.type === "notification_dispatch" && record.reason === "decision_hold_waiting_for_user" && record.hold_id === hold_id);
}

async function main() {
	const cwd = await bootstrapScratchRepo();
	const project = "decision-hold-notify-test";
	const planner = await makeInstance("planner", "planner-01", "planner", cwd, project);
	try {
		await planner.call("orchestrator_init", {});
		const run = await planner.call("run_create", { objective: "Test single notification on decision hold", domain: "software" });
		const runId = run.details.run.id;

		console.log("\n=== decision_hold_create sends exactly one notification, even across idempotent retries ===");
		const first = await planner.call("decision_hold_create", { run_id: runId, question: "Confermi il piano?", owner: "user", idempotency_key: "wait-v1" });
		ok(first.details.hold.status === "open", "hold is created open");
		let events = notificationDispatchEvents(cwd, project, first.details.hold.id);
		ok(events.length === 1, `exactly one notification_dispatch event after the FIRST create (got ${events.length})`);
		ok(events[0].detail?.includes("non configurato") || events[0].ok === false, "with no channel configured, the attempt is recorded as not-sent, not silently skipped");

		// Same (run_id, idempotency_key) — this is the idempotent-retry path a
		// flaky agent turn is expected to safely use. Must NOT notify again.
		const retry1 = await planner.call("decision_hold_create", { run_id: runId, question: "Confermi il piano?", owner: "user", idempotency_key: "wait-v1" });
		ok(retry1.details.hold.id === first.details.hold.id, "the idempotent retry resolves to the SAME hold");
		events = notificationDispatchEvents(cwd, project, first.details.hold.id);
		ok(events.length === 1, `still exactly one notification_dispatch event after an idempotent retry (got ${events.length}) — this is the regression the 2026-09 investigation flagged as missing`);

		const retry2 = await planner.call("decision_hold_create", { run_id: runId, question: "Confermi il piano?", owner: "user", idempotency_key: "wait-v1" });
		ok(retry2.details.hold.id === first.details.hold.id, "a second idempotent retry also resolves to the same hold");
		events = notificationDispatchEvents(cwd, project, first.details.hold.id);
		ok(events.length === 1, `still exactly one notification_dispatch event after a SECOND idempotent retry (got ${events.length})`);

		console.log("\n=== a genuinely NEW hold (different idempotency_key) gets its own, separate single notification ===");
		const second = await planner.call("decision_hold_create", { run_id: runId, question: "Confermi anche il budget?", owner: "user", idempotency_key: "wait-v2" });
		ok(second.details.hold.id !== first.details.hold.id, "a different idempotency_key produces a genuinely different hold");
		const secondEvents = notificationDispatchEvents(cwd, project, second.details.hold.id);
		ok(secondEvents.length === 1, `the second, distinct hold gets exactly one notification of its own (got ${secondEvents.length})`);
		events = notificationDispatchEvents(cwd, project, first.details.hold.id);
		ok(events.length === 1, "the first hold's notification count is unaffected by the second hold's creation");

		console.log(`\n${PASS} assertions passed.`);
		console.log("DECISION HOLD SINGLE-NOTIFICATION SMOKE TEST PASSED");
	} finally {
		for (const instance of ALL_INSTANCES) { try { await instance.shutdown(); } catch { /* best effort */ } }
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
