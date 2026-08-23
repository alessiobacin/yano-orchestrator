#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const broker = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
let passed = 0;

function ok(value, message) {
	if (!value) throw new Error(`ASSERTION FAILED: ${message}`);
	passed++;
	console.log(`   OK — ${message}`);
}

async function git(args, cwd) {
	return execFileP("git", args, { cwd });
}

function fakePi(flags) {
	const tools = new Map();
	const hooks = new Map();
	const entries = [];
	return {
		tools,
		hooks,
		entries,
		pi: {
			registerFlag() {},
			getFlag(name) { return flags[name]; },
			registerTool(definition) { tools.set(definition.name, definition); },
			on(name, handler) { hooks.set(name, handler); },
			registerCommand() {},
			appendEntry(kind, data) { entries.push({ kind, data }); },
			sendMessage() {},
		},
	};
}

function fakeContext(cwd) {
	return { cwd, hasUI: false, ui: { notify() {}, setWidget() {} }, sessionManager: { getBranch() { return []; } } };
}

async function main() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "moa-presence-warning-"));
	await git(["init", "-q", "-b", "main"], cwd);
	await git(["config", "user.email", "smoke@test.local"], cwd);
	await git(["config", "user.name", "Smoke Test"], cwd);
	fs.mkdirSync(path.join(cwd, "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "agents", "roles.yaml"), "roles:\n  planner:\n    teams: [core]\n");
	fs.writeFileSync(path.join(cwd, "agents", "agents.yaml"), "agents:\n  planner-01:\n    role: planner\n");
	await git(["add", "-A"], cwd);
	await git(["commit", "-q", "-m", "init"], cwd);

	const harness = fakePi({ instance: "planner-01", role: "planner", broker, "config-dir": "agents" });
	const mod = await import(pathToFileURL(path.join(root, "extensions", "orchestrator.ts")).href);
	mod.default(harness.pi);
	await harness.hooks.get("session_start")({}, fakeContext(cwd));
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !harness.entries.some((entry) => entry.data?.event === "connected")) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	ok(harness.entries.some((entry) => entry.data?.event === "connected"), "planner connected to the real broker");

	const result = await harness.tools.get("agent_send").execute("presence-warning", {
		target_instance: "coder-not-launched",
		prompt: "test presence warning",
	});
	ok(result.details.no_live_target === true, "agent_send reports no live target immediately");
	ok(result.content[0].text.includes("Nessuna istanza online"), "warning is visible in the tool result");

	await harness.hooks.get("session_shutdown")({}, fakeContext(cwd));
	console.log(`\n${passed} assertions passed.`);
	console.log("AGENT-SEND PRESENCE WARNING SMOKE TEST PASSED");
}

main().catch((error) => {
	console.error(error.stack || error.message || String(error));
	process.exitCode = 1;
});
