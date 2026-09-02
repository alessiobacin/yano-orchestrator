import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
	createYanoWatcherTicket, detectYanoFindings, processYanoWatcherFindings, sendTelegramWatcherNotification,
	isTestFixtureProject, sweepStaleYanoWatcherTickets, touchExistingTicketRecurrence,
} from "./yano-watcher-findings.mjs";
import { readTraceRecords } from "./yano-trace-storage.mjs";
import { openDatabase as openDebuggerDatabase } from "./yano-debugger.mjs";

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
	assert.equal(detectYanoFindings([yanoFailure, { ...yanoFailure }], { project_key: "workspace-test" }).length, 1, "lo stesso finding ripetuto dal lookback non deve duplicare la segnalazione");
	const sameFailureOtherProject = { ...yanoFailure, project: "other-project", project_key: "workspace-other" };
	assert.notEqual(
		detectYanoFindings([yanoFailure])[0].fingerprint,
		detectYanoFindings([sameFailureOtherProject])[0].fingerprint,
		"lo stesso errore in un altro progetto non deve riusare il fingerprint del progetto osservato",
	);
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
assert.match(requests[0].body.text, /Mittente: yano-watcher/);
assert.match(requests[0].body.text, /Server:/);
assert.match(requests[0].body.text, /test watcher notification/);
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
assert.equal(withoutRepo.results[0].debuggerRouting.routed, false, "senza checkout Yano non può esserci instradamento nel registro debugger");

// A genuinely new finding (distinct fingerprint) must, in addition to the
// markdown ticket, also open a bug in the yano-debugger registry under
// mode "yano-maintenance" — additively, without touching the markdown
// mechanism verified above.
const debuggerRoutingFailure = { type: "workspace_scope_mismatch", project: "focusboard-trace-test", project_key: "workspace-test", id: "event-yano-debugger-routing", ts: new Date().toISOString() };
const routingResult = await processYanoWatcherFindings({
	records: [debuggerRoutingFailure], projectRoot, project: "focusboard-trace-test", yanoRepo, notify: false,
	traceContext: { cwd: projectRoot, project_key: "workspace-test" },
});
assert.equal(routingResult.created, 1, "un nuovo finding deve creare un nuovo ticket markdown");
assert.equal(routingResult.results[0].debuggerRouting.routed, true, "il finding nuovo deve essere instradato anche nel registro debugger");
assert.ok(routingResult.results[0].debuggerRouting.bug_id, "deve restituire il bug_id creato nel registro debugger");

const debuggerDb = openDebuggerDatabase();
const routedBug = debuggerDb.prepare("SELECT * FROM debugger_bugs WHERE bug_id = ?").get(routingResult.results[0].debuggerRouting.bug_id);
assert.ok(routedBug, "il bug instradato deve esistere nel registro debugger");
assert.equal(routedBug.source, "watcher");
const routedProject = debuggerDb.prepare("SELECT * FROM debugger_projects WHERE project_key = ?").get(routedBug.project_key);
assert.equal(routedProject.mode, "yano-maintenance", "il bug instradato dal watcher deve vivere nel progetto yano-maintenance, non nel progetto osservato");
debuggerDb.close();

// Ri-processare lo stesso finding non deve aprire un secondo bug (dedup per
// fingerprint sia nel ticket markdown, sia nel registro debugger).
const secondPass = await processYanoWatcherFindings({
	records: [debuggerRoutingFailure], projectRoot, project: "focusboard-trace-test", yanoRepo, notify: false,
	traceContext: { cwd: projectRoot, project_key: "workspace-test" },
});
assert.equal(secondPass.created, 0, "il secondo passaggio sullo stesso finding deve essere idempotente");
assert.equal(secondPass.results[0].debuggerRouting.reason, "not_a_new_ticket", "senza un nuovo ticket markdown non si deve tentare un nuovo instradamento");

// --- Real evidence (2026-09-02 resilience audit): ticket #116 -------------
// The watcher escalated `critical` workspace_scope_mismatch tickets for
// projects that were fixtures of Yano's own smoke tests
// (`context-compaction-smoke`, `watch-smoke`, `manual-e2e-08-refactor-...`),
// and 28/29 real watcher tickets were still `status: open` with no
// auto-close. Verify both fixes.

console.log("\n=== ticket #116 — test-fixture projects do not escalate ===");
assert.equal(isTestFixtureProject("context-compaction-smoke"), true, "trailing -smoke must match");
assert.equal(isTestFixtureProject("watch-smoke"), true, "trailing -smoke must match");
assert.equal(isTestFixtureProject("manual-e2e-08-refactor-playbook"), true, "manual-e2e- prefix must match");
assert.equal(isTestFixtureProject("Manual E2E 08 Refactor Playbook"), true, "space-separated E2E must match case-insensitively");
assert.equal(isTestFixtureProject("focusboard-trace-test"), false, "an ordinary project name must never be treated as a fixture");
assert.equal(isTestFixtureProject("llmproxy"), false, "a real user project must never be treated as a fixture");
assert.equal(isTestFixtureProject("context-compaction-smoke", { YANO_WATCHER_SKIP_TEST_FIXTURES: "0" }), false, "the whole heuristic must be disable-able via env");

const fixtureFinding = { type: "workspace_scope_mismatch", project: "watch-smoke", project_key: "workspace-fixture", id: "event-fixture-1", ts: new Date().toISOString() };
const fixtureResult = await processYanoWatcherFindings({
	records: [fixtureFinding], projectRoot, project: "watch-smoke", yanoRepo, notify: false,
	traceContext: { cwd: projectRoot, project_key: "workspace-fixture" },
});
assert.equal(fixtureResult.created, 0, "a test-fixture project must never create a maintenance ticket");
assert.equal(fixtureResult.results[0].skipped, true);
assert.equal(fixtureResult.results[0].reason, "test_fixture_project");
assert.equal(fixtureResult.results[0].debuggerRouting.routed, false, "a suppressed finding must never reach the debugger registry either");
assert.ok(
	readTraceRecords({ cwd: projectRoot, project: "watch-smoke" }).some((record) => record.type === "yano_watcher_finding_suppressed"),
	"the suppression itself remains observable in the project trace, even though no ticket/alert is produced",
);

console.log("   OK — a workspace_scope_mismatch on a *-smoke/manual-e2e-* fixture project is detected but never escalated");

console.log("\n=== ticket #116 — stale watcher tickets auto-close and reopen on recurrence ===");
const staleTicketsDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-stale-"));
const staleFinding = detectYanoFindings([{ ...yanoFailure, id: "event-stale-1" }])[0];
const staleTicket = createYanoWatcherTicket({ finding: staleFinding, yanoRepo, projectRoot, project: "focusboard-trace-test", ticketsDir: staleTicketsDir });
assert.equal(staleTicket.created, true);
const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days later
const sweep = sweepStaleYanoWatcherTickets({ ticketsDir: staleTicketsDir, now: farFuture, staleDays: 14 });
assert.equal(sweep.swept, 1, "a watcher ticket with no recurrence for 30 days must auto-close under a 14-day threshold");
let staleContent = fs.readFileSync(staleTicket.path, "utf8");
assert.match(staleContent, /^status: auto-closed-stale$/m);
assert.match(staleContent, /^Status: auto-closed-stale$/m);
assert.match(staleContent, /Auto-chiusura per assenza di recidiva/);

const freshSweep = sweepStaleYanoWatcherTickets({ ticketsDir: staleTicketsDir, now: farFuture, staleDays: 14 });
assert.equal(freshSweep.swept, 0, "an already auto-closed ticket must not be swept again");

const secondSweep = sweepStaleYanoWatcherTickets({ ticketsDir: staleTicketsDir, now: new Date(farFuture.getTime() + 60_000), staleDays: 14 });
assert.equal(secondSweep.swept, 0, "sweep only ever touches status: open watcher tickets");

const reopened = touchExistingTicketRecurrence(staleTicket.path, new Date(farFuture.getTime() + 120_000));
assert.equal(reopened.touched, true);
assert.equal(reopened.reopened, true, "recurrence of the same fingerprint must reopen an auto-closed ticket");
staleContent = fs.readFileSync(staleTicket.path, "utf8");
assert.match(staleContent, /^status: open$/m);
assert.match(staleContent, /^Status: open$/m);
assert.match(staleContent, /Riaperto/);

console.log("   OK — a watcher ticket auto-closes after the staleness window and reopens the moment the same fault recurs");

console.log("smoke-test-yano-watcher-findings: ok");
