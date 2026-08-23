// Regression coverage for two real presence incidents:
// 1. a planner completing a worker-owned ticket used to leave the worker's
//    in-memory activeTicketIds stale, so it stayed busy forever;
// 2. a fresh planner must receive retained presence from peers that were
//    already connected before the planner started.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import mqtt from "mqtt";

const execFileP = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const PROJECT = "presence-refresh-smoke";

process.env.PI_ORCH_HEARTBEAT_MS = "100";
process.env.PI_ORCH_STALE_AFTER_MS = "500";
process.env.PI_ORCH_TEST_NO_EXIT = "1";

let pass = 0;
function ok(condition, message) {
	if (!condition) throw new Error(`PRESENCE REFRESH SMOKE FAILED: ${message}`);
	pass++;
	console.log(`ok - ${message}`);
}

async function git(args, cwd) { return execFileP("git", args, { cwd }); }

async function scratchRepo() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "yano-presence-refresh-"));
	await git(["init", "-q"], cwd);
	await git(["config", "user.email", "presence-refresh@test.local"], cwd);
	await git(["config", "user.name", "Presence Refresh Test"], cwd);
	fs.mkdirSync(path.join(cwd, "agents"), { recursive: true });
	for (const file of ["agents.yaml", "roles.yaml"]) fs.copyFileSync(path.join(PROJECT_ROOT, "agents", file), path.join(cwd, "agents", file));
	fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\nlogs/\n");
	await git(["add", "-A"], cwd);
	await git(["commit", "-q", "-m", "presence refresh fixture"], cwd);
	return cwd;
}

function fakePi(flags) {
	const tools = new Map();
	const hooks = new Map();
	const entries = [];
	const pi = {
		registerFlag() {},
		getFlag(name) { return flags[name]; },
		registerTool(def) { tools.set(def.name, def); },
		on(event, handler) { hooks.set(event, handler); },
		registerCommand() {},
		appendEntry(kind, data) { entries.push({ kind, data }); },
		sendMessage() {},
	};
	return { pi, tools, hooks, entries };
}

function fakeCtx(cwd) {
	return { cwd, hasUI: false, ui: { notify() {}, setWidget() {} }, sessionManager: { getBranch() { return []; } } };
}

let modulePromise;
class Instance {
	constructor(instance, role, cwd) {
		this.instance = instance;
		this.harness = fakePi({ instance, role, project: PROJECT, broker: BROKER_URL, "config-dir": "agents" });
		this.ctx = fakeCtx(cwd);
	}
	async start() {
		modulePromise ??= import(pathToFileURL(path.join(PROJECT_ROOT, "extensions", "orchestrator.ts")).href);
		const mod = await modulePromise;
		mod.default(this.harness.pi);
		await this.harness.hooks.get("session_start")({}, this.ctx);
		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline) {
			if (this.harness.entries.some((entry) => entry.data?.event === "connected")) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`${this.instance} did not connect to ${BROKER_URL}`);
	}
	call(name, params = {}) {
		const tool = this.harness.tools.get(name);
		if (!tool) throw new Error(`${this.instance}: missing tool ${name}`);
		return tool.execute(`presence-${Math.random()}`, params);
	}
	async shutdown() { await this.harness.hooks.get("session_shutdown")?.({}, this.ctx); }
}

async function waitUntil(predicate, message, timeout = 4_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	throw new Error(`timeout: ${message}`);
}

async function retainedStatus(instance) {
	const observer = await mqtt.connectAsync(BROKER_URL, { protocolVersion: 5 });
	const topic = `pi/${PROJECT}/agents/${instance}/status`;
	let card = null;
	const seen = new Promise((resolve) => {
		observer.on("message", (_topic, payload) => {
			try { card = JSON.parse(payload.toString()); resolve(); } catch { /* ignore */ }
		});
	});
	await observer.subscribeAsync(topic, { qos: 1 });
	await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error(`no retained card for ${instance}`)), 2_000))]);
	await observer.endAsync();
	return card;
}

async function main() {
	const cwd = await scratchRepo();
	const planner = new Instance("planner-01", "planner", cwd);
	const coder = new Instance("coder-01", "coder", cwd);
	let restartedPlanner = null;
	try {
		await coder.start();
		restartedPlanner = new Instance("planner-01", "planner", cwd);
		await restartedPlanner.start();
		await waitUntil(async () => (await restartedPlanner.call("agent_list")).details.agents.some((agent) => agent.instance === "coder-01"), "restarted planner receives coder retained presence");
		ok(true, "planner restart rebuilds its peer map from retained MQTT presence");

		const run = (await restartedPlanner.call("run_create", { objective: "presence refresh" })).details.run;
		const ticket = (await restartedPlanner.call("ticket_create", { run_id: run.id, title: "worker ticket" })).details.ticket;
		await coder.call("ticket_claim", { ticket_id: ticket.id });
		await waitUntil(async () => (await restartedPlanner.call("agent_list")).details.agents.some((agent) => agent.instance === "coder-01" && agent.status === "busy"), "coder becomes busy after ticket claim");
		ok(true, "ticket claim publishes busy presence");

		await restartedPlanner.call("ticket_complete", { ticket_id: ticket.id, status: "done", result_summary: "completed by planner after worker handoff" });
		await waitUntil(async () => (await restartedPlanner.call("agent_list")).details.agents.some((agent) => agent.instance === "coder-01" && agent.status === "idle"), "coder returns idle after planner completes its ticket");
		ok(true, "worker status is reconciled from the central SQLite ticket state");
		const card = await retainedStatus("coder-01");
		ok(card.status === "idle", "retained MQTT card is idle, not a stale busy snapshot");
		console.log(`PRESENCE REFRESH SMOKE TEST PASSED (${pass} assertions)`);
	} finally {
		await restartedPlanner?.shutdown();
		await planner.shutdown();
		await coder.shutdown();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
