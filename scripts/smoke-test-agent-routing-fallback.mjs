#!/usr/bin/env node

// Verifies the common routing contract used by every playbook:
//   live target -> target;
//   missing target + live planner -> planner;
//   missing target + no live planner -> persistent watcher channel.
// The final watcher->planner spawn is exercised by the real continuous watcher
// in production; this test keeps the control-plane boundary deterministic by
// inspecting the retained fallback envelope instead of opening a Herdr pane.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import mqtt from "mqtt";
import { projectKey } from "./yano-trace-storage.mjs";

const execFileP = promisify(execFile);
const packageRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
const broker = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const previousTestFlag = process.env.PI_ORCH_TEST_NO_EXIT;
process.env.PI_ORCH_TEST_NO_EXIT = "1";
let passed = 0;

function ok(condition, message) {
	assert.ok(condition, message);
	passed++;
	console.log(`   OK — ${message}`);
}

async function git(args, cwd) { return execFileP("git", args, { cwd }); }

function fakePi(flags) {
	const tools = new Map();
	const hooks = new Map();
	const entries = [];
	const sent = [];
	return {
		tools,
		hooks,
		entries,
		sent,
		pi: {
			registerFlag() {},
			getFlag(name) { return flags[name]; },
			registerTool(definition) { tools.set(definition.name, definition); },
			on(name, handler) { hooks.set(name, handler); },
			registerCommand() {},
			appendEntry(kind, data) { entries.push({ kind, data }); },
			sendMessage(message) { sent.push(message); },
		},
	};
}

function fakeContext(cwd) {
	return { cwd, hasUI: false, ui: { notify() {}, setWidget() {} }, sessionManager: { getBranch() { return []; } } };
}

async function waitUntil(predicate, label) {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	throw new Error(`timeout: ${label}`);
}

async function instance(mod, cwd, project, instance, role) {
	const harness = fakePi({ instance, role, project, broker, "config-dir": "agents" });
	mod.default(harness.pi);
	await harness.hooks.get("session_start")({}, fakeContext(cwd));
	await waitUntil(() => harness.entries.some((entry) => entry.data?.event === "connected"), `${instance} connected`);
	return harness;
}

async function main() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "yano-routing-fallback-"));
	const project = "routing-fallback-" + path.basename(cwd);
	const scope = project;
	await git(["init", "-q"], cwd);
	fs.mkdirSync(path.join(cwd, "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "agents", "roles.yaml"), "roles:\n  planner: { teams: [core] }\n  coder: { teams: [core] }\n");
	fs.writeFileSync(path.join(cwd, "agents", "agents.yaml"), "agents:\n  planner-01: { role: planner }\n  coder-01: { role: coder }\n");

	const mod = await import(pathToFileURL(path.join(packageRoot, "extensions", "orchestrator.ts")).href);
	const watcher = await import(pathToFileURL(path.join(packageRoot, "scripts", "watch-stalls.mjs")).href);
	const planner = await instance(mod, cwd, project, "planner-01", "planner");
	const coder = await instance(mod, cwd, project, "coder-01", "coder");
	const routeObserver = mqtt.connect(broker, { reconnectPeriod: 0 });
	const plannerCommands = [];
	await new Promise((resolve, reject) => { routeObserver.once("connect", resolve); routeObserver.once("error", reject); });
	await routeObserver.subscribeAsync(`pi/${scope}/agents/planner-01/commands`, { qos: 1 });
	routeObserver.on("message", (_topic, payload) => { try { plannerCommands.push(JSON.parse(payload.toString())); } catch { /* ignore */ } });

	console.log("\n=== TEST 1 — target offline, planner live: route to planner ===");
	const routed = await coder.tools.get("agent_send").execute("route-1", { target_instance: "debugger-01", prompt: "diagnosi QA non consegnata" });
	ok(routed.details.route === "planner", "agent_send routes an unavailable target to the live planner");
	ok(routed.details.fallback_target === "planner-01", "fallback records the exact planner instance");
	ok(coder.entries.some((entry) => entry.data?.event === "outbound_command"), "sender keeps an assignment id for the original delegation");
	await waitUntil(() => plannerCommands.length > 0, `planner command published (messages=${JSON.stringify(planner.sent)}, entries=${JSON.stringify(planner.entries.slice(-4))})`);
	ok(plannerCommands[0].target_instance === "planner-01", "fallback command addresses planner on its per-instance topic");
	await waitUntil(() => planner.sent.some((message) => message.customType === "orchestrator-inbound"), "planner receives fallback");
	ok(planner.sent.some((message) => message.content.includes("Destinatario originale offline")), "planner receives the original intent with routing context");
	await watcher.handleAgentFallback({ client: routeObserver, cwd, project, packageRoot, payload: {
		type: "agent_route_fallback",
		fallback_id: "watcher-forward-1",
		project,
		original_target: "debugger-01",
		original: { type: "command", assignment_id: "watcher-forward-1", sender_instance: "worker-01", sender_role: "coder", project, project_key: scope, target_instance: "debugger-01", prompt: "messaggio conservato dal watcher", reply_to: `pi/${scope}/agents/worker-01/responses`, hops: 0 },
	} });
	ok(plannerCommands.some((message) => message.fallback_for === "debugger-01" && message.assignment_id === "watcher-forward-1"), "watcher forwards a retained fallback to the live planner with original correlation");

	console.log("\n=== TEST 2 — target offline, no planner live: publish watcher fallback ===");
	await planner.hooks.get("session_shutdown")({}, fakeContext(cwd));
	await coder.hooks.get("session_shutdown")({}, fakeContext(cwd));
	const sender = await instance(mod, cwd, project + "-watcher", "worker-01", "coder");
	const observer = mqtt.connect(broker, { reconnectPeriod: 0 });
	const received = [];
	await new Promise((resolve, reject) => { observer.once("connect", resolve); observer.once("error", reject); });
	await observer.subscribeAsync(`pi/${project}-watcher/system/agent-fallback`, { qos: 1 });
	observer.on("message", (_topic, payload) => { try { received.push(JSON.parse(payload.toString())); } catch { /* clear retained */ } });
	const fallback = await sender.tools.get("agent_send").execute("route-2", { target_instance: "debugger-01", prompt: "delega da recuperare" });
	ok(fallback.details.route === "watcher", "agent_send routes to the watcher when no planner is live");
	await waitUntil(() => received.some((message) => message.type === "agent_route_fallback"), "watcher fallback envelope");
	const envelope = received.find((message) => message.type === "agent_route_fallback");
	ok(envelope.original_target === "debugger-01", "fallback preserves the intended recipient");
	ok(envelope.original?.assignment_id === fallback.details.assignment_id, "fallback preserves assignment correlation");
	ok(envelope.original?.sender_instance === "worker-01", "fallback preserves the original sender");

	await sender.hooks.get("session_shutdown")({}, fakeContext(cwd));
	await new Promise((resolve) => observer.end(true, resolve));
	await new Promise((resolve) => routeObserver.end(true, resolve));
	console.log(`\n${passed} assertions passed.`);
}

try {
	await main();
	console.log("AGENT-ROUTING-FALLBACK SMOKE TEST PASSED");
} catch (error) {
	console.error(error.stack || error.message || String(error));
	process.exitCode = 1;
} finally {
	if (previousTestFlag === undefined) delete process.env.PI_ORCH_TEST_NO_EXIT;
	else process.env.PI_ORCH_TEST_NO_EXIT = previousTestFlag;
}
