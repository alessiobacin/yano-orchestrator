import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createYanoWatcherTicket, detectYanoFindings, processYanoWatcherFindings, sendTelegramWatcherNotification } from "./yano-watcher-findings.mjs";
import { readTraceRecords } from "./yano-trace-storage.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-findings-"));
const yanoRepo = path.join(root, "yano-orchestrator");
const projectRoot = path.join(root, "focusboard");
fs.mkdirSync(yanoRepo, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(yanoRepo, ".env"), "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_DESTINATION_CHAT_ID=5228139669\n");

const yanoFailure = {
	type: "agent_send_no_live_target",
	project: "focusboard-trace-test",
	project_key: "workspace-test",
	run_id: "run-1",
	instance: "planner-01",
	task_slug: "implement-feature",
	message: "no live target",
	id: "event-yano-1",
	ts: new Date().toISOString(),
};
const projectFailure = { type: "tool_execution_end", tool: "npm test", ok: false, error: "assertion failed" };
assert.equal(detectYanoFindings([yanoFailure], { project_key: "workspace-test" }).length, 1);
assert.equal(detectYanoFindings([projectFailure]).length, 0, "un test del progetto non deve diventare un ticket Yano");

const first = createYanoWatcherTicket({ finding: detectYanoFindings([yanoFailure])[0], yanoRepo, projectRoot, project: "focusboard-trace-test" });
assert.equal(first.created, true);
assert.equal(path.dirname(first.path), path.join(yanoRepo, ".scratch", "optimize-orchestrator", "issues"));
const duplicate = createYanoWatcherTicket({ finding: detectYanoFindings([yanoFailure])[0], yanoRepo, projectRoot, project: "focusboard-trace-test" });
assert.equal(duplicate.created, false);
assert.equal(duplicate.path, first.path);
const ticket = fs.readFileSync(first.path, "utf8");
assert.match(ticket, /agent_send_no_live_target/);
assert.match(ticket, /focusboard-trace-test/);
assert.match(ticket, /^type: debugger$/m);
assert.match(ticket, /^Type: debugger$/m);
assert.match(ticket, /^Kind: task$/m);
assert.doesNotMatch(ticket, /test-token/);

const requests = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		requests.push({ url: req.url, body: JSON.parse(body) });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const telegram = await sendTelegramWatcherNotification({ yanoRepo, message: "test watcher notification", apiBaseUrl: `http://127.0.0.1:${address.port}` });
assert.equal(telegram.ok, true);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, "/bottest-token/sendMessage");
assert.equal(requests[0].body.chat_id, "5228139669");
assert.equal(requests[0].body.text, "test watcher notification");
await new Promise((resolve) => server.close(resolve));

process.env.YANO_DATA_DIR = path.join(root, "trace-data");
const processed = await processYanoWatcherFindings({
	records: [yanoFailure], projectRoot, project: "focusboard-trace-test", yanoRepo, notify: false,
	traceContext: { cwd: projectRoot, project_key: "workspace-test" },
});
assert.equal(processed.findings.length, 1);
assert.equal(processed.created, 0, "il secondo passaggio deve essere idempotente");
assert.equal(processed.results[0].path, first.path);

const withoutRepo = await processYanoWatcherFindings({
	records: [{ ...yanoFailure, id: "event-yano-no-repo" }], projectRoot, project: "no-yano-repo", yanoRepo: null, notify: false,
	traceContext: { cwd: projectRoot, project_key: "workspace-no-repo" },
});
assert.equal(withoutRepo.results[0].skipped, true);
assert.ok(readTraceRecords({ cwd: projectRoot, project: "no-yano-repo" }).some((record) => record.type === "yano_watcher_finding"), "anche senza checkout Yano il finding resta nel trace");

console.log("smoke-test-yano-watcher-findings: ok");
