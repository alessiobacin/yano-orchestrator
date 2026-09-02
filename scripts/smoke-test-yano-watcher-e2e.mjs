import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import mqtt from "mqtt";
import { appendRawTraceRecord, projectKey } from "./yano-trace-storage.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-e2e-"));
const yanoRepo = path.join(root, "yano-orchestrator");
const projectRoot = path.join(root, "focusboard-trace-test");
const genericProjectRoot = path.join(root, "ordinary-project");
const pausedProjectRoot = path.join(root, "paused-project");
const uninitializedProjectRoot = path.join(root, "uninitialized-project");
const traceRoot = path.join(root, "temp");
for (const dir of [yanoRepo, projectRoot, genericProjectRoot, pausedProjectRoot, uninitializedProjectRoot]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(yanoRepo, ".env"), `YANO_ORCHESTRATOR_REPO=${yanoRepo}\nTELEGRAM_BOT_TOKEN=e2e-token\nTELEGRAM_DESTINATION_CHAT_ID=5228139669\n`);

function seedDatabase(cwd) {
	const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
	const dbDir = path.join(cwd, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage");
	fs.mkdirSync(dbDir, { recursive: true });
	const db = new DatabaseSync(path.join(dbDir, "orchestrator.db"));
	db.exec("CREATE TABLE tickets (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, assigned_instance TEXT, run_id TEXT, title TEXT)");
	db.exec("CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, status TEXT)");
	db.close();
}

seedDatabase(projectRoot);
seedDatabase(genericProjectRoot);
seedDatabase(pausedProjectRoot);
{
	const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
	const dbPath = path.join(pausedProjectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage", "orchestrator.db");
	const db = new DatabaseSync(dbPath);
	const old = new Date(Date.now() - 3_600_000).toISOString();
	db.prepare("INSERT INTO tickets VALUES (?, 'running', ?, ?, ?, ?)").run("paused-ticket", old, "worker-01", "paused-run", "ticket intentionally paused");
	db.prepare("INSERT INTO decision_holds VALUES (?, ?, 'open')").run("paused-hold", "paused-run");
	db.close();
}
process.env.YANO_DATA_DIR = traceRoot;
process.env.YANO_ORCHESTRATOR_REPO = path.join(root, "wrong-repository");
process.env.PI_ORCH_BROKER_URL = "mqtt://127.0.0.1:1";

const yanoFailure = {
	type: "agent_send_no_live_target",
	project: "focusboard-trace-test",
	project_key: "workspace-e2e",
	run_id: "run-e2e",
	instance: "planner-01",
	task_slug: "trace-escalation",
	id: "source-yano-failure-1",
	ts: new Date().toISOString(),
};
appendRawTraceRecord({ cwd: projectRoot, project: "focusboard-trace-test", record: yanoFailure });
appendRawTraceRecord({ cwd: genericProjectRoot, project: "ordinary-project", record: {
	type: "tool_execution_end", tool: "npm test", ok: false, error: "application assertion failed", id: "project-failure-1", ts: new Date().toISOString(),
} });

const requests = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		requests.push({ url: req.url, body: JSON.parse(body) });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, result: { message_id: requests.length } }));
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
process.env.YANO_TELEGRAM_API_URL = "http://127.0.0.1:" + address.port;

try {
	const { runWatch } = await import(pathToFileURL(path.join(process.cwd(), "scripts", "watch-stalls.mjs")).href);

	await runWatch({ cwd: projectRoot, argv: ["--once", "--project", "focusboard-trace-test"], packageRoot: yanoRepo });
	const issueDir = path.join(yanoRepo, ".scratch", "optimize-orchestrator", "issues");
	let tickets = fs.readdirSync(issueDir).filter((file) => file.endsWith(".md"));
	assert.deepEqual(tickets, ["01-yano-watcher-no-live-target.md"]);
	const ticket = fs.readFileSync(path.join(issueDir, tickets[0]), "utf8");
	assert.match(ticket, /Status: open/);
	assert.match(ticket, /^type: debugger$/m);
	assert.match(ticket, /^Type: debugger$/m);
	assert.match(ticket, /^Kind: task$/m);
	assert.match(ticket, /focusboard-trace-test/);
	assert.doesNotMatch(ticket, /e2e-token/);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "/bote2e-token/sendMessage");
	assert.equal(requests[0].body.chat_id, "5228139669");
	assert.match(requests[0].body.text, /trace-escalation|no_live_target/);

	// Same trace twice: one ticket and one notification only.
	await runWatch({ cwd: projectRoot, argv: ["--once", "--project", "focusboard-trace-test"], packageRoot: yanoRepo });
	tickets = fs.readdirSync(issueDir).filter((file) => file.endsWith(".md"));
	assert.deepEqual(tickets, ["01-yano-watcher-no-live-target.md"]);
	assert.equal(requests.length, 1);

	// Ordinary project failure: no Yano ticket and no Telegram escalation.
	await runWatch({ cwd: genericProjectRoot, argv: ["--once", "--project", "ordinary-project"], packageRoot: yanoRepo });
	assert.equal(fs.readdirSync(issueDir).filter((file) => file.endsWith(".md")).length, 1);
	assert.equal(requests.length, 1);

	// An open human gate is intentional waiting, not a stall: the observer must
	// remain healthy even when the assigned worker's ticket is old.
	const paused = await runWatch({ cwd: pausedProjectRoot, argv: ["--once", "--project", "paused-project"], packageRoot: yanoRepo });
	assert.equal(paused.status, "healthy");

	// Conversation mode may intentionally have no operational DB yet. An
	// ordinary watcher pass waits quietly; it must not manufacture a validation
	// error or page Telegram. Explicit validation is tested immediately below.
	const conversationWaiting = await runWatch({ cwd: uninitializedProjectRoot, argv: ["--once", "--project", "uninitialized-project"], packageRoot: yanoRepo });
	assert.equal(conversationWaiting.status, "waiting");
	assert.equal(conversationWaiting.reason, "not_initialized");
	assert.equal(conversationWaiting.route.route, "not_applicable");
	assert.equal(requests.length, 1);

	// A validation watcher must not silently exit when the project has no DB:
	// it must escalate the blocked precondition to Telegram when no live planner
	// is present. This is the exact Sales Companion failure mode.
	const blocked = await runWatch({ cwd: uninitializedProjectRoot, argv: ["--once", "--project", "uninitialized-project", "--validation-run", "validation-uninitialized"], packageRoot: yanoRepo });
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.reason, "not_initialized");
	assert.equal(requests.length, 2);
	assert.match(requests[1].body.text, /validation_blocked|non è inizializzato/i);

	// With a live planner presence, a new Yano finding is routed to its command
	// topic instead of paging Telegram.
	const broker = "mqtt://127.0.0.1:1883";
	const observer = mqtt.connect(broker, { reconnectPeriod: 0 });
	const plannerCommands = [];
	await new Promise((resolve, reject) => { observer.once("connect", resolve); observer.once("error", reject); });
	// watch-stalls.mjs's runWatch() resolves its own topic scope as
	// projectKey(cwd, project) (a workspace-<hash>), not the raw project
	// string, whenever PI_ORCH_TEST_NO_EXIT is unset (see runWatch's
	// `topicScope = ... projectKey(watchCwd, project)`). Publishing/
	// subscribing on the raw "focusboard-trace-test" name means the real
	// watcher never discovers this fake planner as live at all.
	const scope = projectKey(projectRoot, "focusboard-trace-test");
	await observer.subscribeAsync(`pi/${scope}/agents/planner-01/commands`, { qos: 1 });
	observer.on("message", (_topic, payload) => { try { plannerCommands.push(JSON.parse(payload.toString())); } catch { /* ignore */ } });
	await observer.publishAsync(`pi/${scope}/agents/planner-01/status`, JSON.stringify({
		instance: "planner-01", role: "planner", project: "focusboard-trace-test", status: "idle", last_heartbeat: new Date().toISOString(),
	}), { qos: 1, retain: true });
	appendRawTraceRecord({ cwd: projectRoot, project: "focusboard-trace-test", record: {
		type: "trace_preflight", ok: false, expected: "full", actual: "events", id: "source-yano-failure-2", ts: new Date().toISOString(),
	} });
	process.env.PI_ORCH_BROKER_URL = broker;
	await runWatch({ cwd: projectRoot, argv: ["--once", "--project", "focusboard-trace-test"], packageRoot: yanoRepo });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.ok(plannerCommands.some((command) => command.type === "command" && command.sender_instance === "yano-watcher" && /trace_preflight_mismatch/.test(command.prompt)));
	assert.equal(requests.length, 2, "un planner live evita il Telegram duplicato per il nuovo finding");
	await observer.publishAsync(`pi/${scope}/agents/planner-01/status`, JSON.stringify({ instance: "planner-01", role: "planner", project: "focusboard-trace-test", status: "offline", last_heartbeat: new Date().toISOString() }), { qos: 1, retain: true });
	observer.end(true);

	console.log("smoke-test-yano-watcher-e2e: ok");
} finally {
	await new Promise((resolve) => server.close(resolve));
}
