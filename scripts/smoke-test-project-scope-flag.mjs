// Regression test for BUG-20260902-317715D8 (fix-workspace-scope-mismatch):
// `--project-scope` was REGISTERED but never READ by readCliFlags(), so
// scheduler-service (launched with --project-scope yano-local-pc) silently
// degraded to the canonical project_key scope, producing
// `presence_ignored_scope_mismatch` between scheduler and projects.
//
// This drives the REAL extensions/orchestrator.ts through a real session_start
// against a real local mosquitto broker (same approach as
// smoke-test-project-scoping.mjs) with --project-scope yano-local-pc, then reads
// back the ACTUAL retained MQTT status topic the instance published to
// (`pi/<scope>/agents/<instance>/status`). With the fix, the scope segment is
// exactly "yano-local-pc" — NOT projectKey(cwd).
//
// RED contract (written BEFORE the fix): the assertion below fails on the
// unfixed code (scope === projectKey) and passes once readCliFlags() surrogates
// project-scope.
//
// Usage: node --experimental-strip-types scripts/smoke-test-project-scope-flag.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import mqtt from "mqtt";
import { projectKey } from "./yano-trace-storage.mjs";

// Isolate from the REAL machine's global Yano config. Fase 0 made
// sendNotifications() fall back to the global notification channel when a
// project has no local .env — on a real developer machine with real
// Telegram/WhatsApp credentials configured globally, an unisolated test
// that reaches a notification code path WILL send a real message. Must be
// set before extensions/orchestrator.ts is imported anywhere below.
// (Dependency-free: does not assume node:path/node:os are imported here.)
if (!process.env.YANO_CONFIG_FILE) process.env.YANO_CONFIG_FILE = `${process.env.TMPDIR || "/tmp"}/yano-test-isolation-no-such-config.env`;


const PROJECT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";

let PASS = 0;
function ok(cond, msg) {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	PASS++;
	console.log(`   OK — ${msg}`);
}

// ━━ Minimal fake pi/ctx harness (same shape as smoke-test-project-scoping.mjs) ━━
function makeFakePi(flagValues) {
	const hooks = new Map();
	const appendedEntries = [];
	const pi = {
		registerFlag() {},
		getFlag(name) {
			return flagValues[name];
		},
		registerTool() {},
		on(event, handler) {
			hooks.set(event, handler);
		},
		registerCommand() {},
		appendEntry(kind, data) {
			appendedEntries.push({ kind, data });
		},
		sendMessage() {},
	};
	return { pi, hooks, appendedEntries };
}

function makeCtx(cwd) {
	return {
		cwd,
		hasUI: false,
		ui: undefined,
		sessionManager: { getBranch() { return []; } },
	};
}

class FakeInstance {
	constructor(flagValues, cwd) {
		this.flagValues = flagValues;
		this.cwd = cwd;
		this.harness = makeFakePi(flagValues);
		this.ctx = makeCtx(cwd);
	}

	async start() {
		const modUrl = pathToFileURL(path.join(PROJECT_ROOT, "extensions", "orchestrator.ts")).href;
		if (!FakeInstance._modPromise) FakeInstance._modPromise = import(modUrl);
		const mod = await FakeInstance._modPromise;
		mod.default(this.harness.pi);
		const sessionStart = this.harness.hooks.get("session_start");
		if (!sessionStart) throw new Error("session_start hook not registered");
		await sessionStart({}, this.ctx);
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			if (this.harness.appendedEntries.some((e) => e.data?.event === "connected")) return this;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`never saw MQTT "connected" event within 8s — is mosquitto running on ${BROKER_URL}?`);
	}

	async shutdown() {
		const hook = this.harness.hooks.get("session_shutdown");
		if (hook) await hook({}, this.ctx);
	}
}

function scratchDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// Starts `instance` in `cwd` with the given flagValues, then watches a fresh
// raw MQTT subscriber on `pi/#` for the FIRST status topic whose instance
// matches — returns the `<scope>` segment actually used on the wire.
async function resolvedScopeFor(cwd, instance, flagValues) {
	const observer = await mqtt.connectAsync(BROKER_URL, { protocolVersion: 5 });
	await observer.subscribeAsync("pi/+/agents/+/status");
	let resolved = null;
	const seen = new Promise((resolve) => {
		observer.on("message", (topic) => {
			const m = topic.match(/^pi\/(.+)\/agents\/([^/]+)\/status$/);
			if (m && m[2] === instance) {
				resolved = m[1];
				resolve();
			}
		});
	});

	const fi = new FakeInstance(flagValues, cwd);
	await fi.start();
	await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error(`never saw a status publish for "${instance}" within 8s`)), 8000))]);
	await fi.shutdown();
	await observer.endAsync();
	return resolved;
}

async function main() {
	// Use the production routing branch (the same root-derived topic scope as
	// real Yano processes): under PI_ORCH_TEST_NO_EXIT=1 the extension short-
	// circuits the scope to `project`, which would mask the project-scope flag.
	delete process.env.PI_ORCH_TEST_NO_EXIT;

	console.log("\n=== TEST 1 — --project-scope yano-local-pc overrides the canonical scope ===");
	const dir = scratchDir("yano-scope-flag");
	const instance = "scope-flag-01";
	const scopeFlagged = await resolvedScopeFor(dir, instance, {
		instance,
		role: "planner",
		broker: BROKER_URL,
		"project-scope": "yano-local-pc",
	});
	ok(scopeFlagged === "yano-local-pc", `--project-scope yano-local-pc puts the MQTT scope on the wire as "yano-local-pc" (got "${scopeFlagged}")`);
	ok(scopeFlagged !== projectKey(dir, "scope-flag"), `the scope is NOT the canonical projectKey "${projectKey(dir, "scope-flag")}" — the flag is actually read`);

	console.log("\n=== TEST 2 — without --project-scope the canonical root scope still applies ===");
	const dirBare = scratchDir("yano-scope-flag-bare");
	const instanceBare = "scope-flag-bare-01";
	const scopeBare = await resolvedScopeFor(dirBare, instanceBare, {
		instance: instanceBare,
		role: "planner",
		broker: BROKER_URL,
	});
	const expectedBare = projectKey(dirBare, "scope-flag-bare");
	ok(scopeBare === expectedBare, `no flag → root-derived scope "${expectedBare}" (got "${scopeBare}") — no regression on the default path`);

	console.log(`\n${PASS} assertions passed.`);
}

main()
	.then(() => {
		console.log("PROJECT-SCOPE-FLAG SMOKE TEST PASSED");
		process.exit(0);
	})
	.catch((err) => {
		console.error("\nPROJECT-SCOPE-FLAG SMOKE TEST FAILED:", err);
		process.exit(1);
	});
