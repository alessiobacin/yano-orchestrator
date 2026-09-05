// Regression test for Fase 4 of the cron/watcher/scheduler restructuring:
// yano-architect and yano-auto-improver are on-demand (not always-on)
// maintenance agents. Before this fix NEITHER role had any teardown logic
// at all — a proposal/audit reaching a terminal state left its Herdr
// tab/agent lingering forever. closeTerminalArchitectSessions() and
// closeTerminalAutoImproverSessions() are the cron-side half of the
// scheduler-creates/cron-closes lifecycle: called every minute from
// yano-watcher-registry's global supervise() pass.
//
// Uses a real temp YANO_DATA_DIR + real node:sqlite (both modules' own
// openDatabase()), with a stub `herdr` binary on PATH (no real Herdr
// needed) so tab-close attempts succeed deterministically.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-maintenance-teardown-"));
process.env.YANO_DATA_DIR = root;
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");

// Stub herdr: always reports a successful tab close.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-maintenance-teardown-bin-"));
const closeCalls = path.join(root, "herdr-close-calls.txt");
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	`if (process.argv[2] === "tab" && process.argv[3] === "close") { require("fs").appendFileSync(${JSON.stringify(closeCalls)}, process.argv[4] + "\\n"); process.exit(0); }`,
	"process.exit(1);",
].join("\n"));
fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;

const { closeTerminalArchitectSessions } = await import("./yano-architect.mjs");
const { closeTerminalAutoImproverSessions } = await import("./yano-auto-improver.mjs");

// ── Fixtures: insert rows directly via each module's own DB helpers ────────
function requireSqlite() { return process.getBuiltinModule?.("node:sqlite"); }

console.log("Fase 4: architect/auto-improver session teardown");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

// yano-architect.mjs's DB path: <YANO_DATA_DIR>/architect/architect.sqlite
const architectDb = path.join(root, "architect", "architect.sqlite");
fs.mkdirSync(path.dirname(architectDb), { recursive: true });
{
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(architectDb);
	db.exec(`CREATE TABLE IF NOT EXISTS architect_proposals (
		proposal_id TEXT PRIMARY KEY, project_key TEXT, project_root TEXT, project_name TEXT, task TEXT, status TEXT,
		version TEXT, base_playbook TEXT, playbook_id TEXT, role_id TEXT, ephemeral_dir TEXT, playbook_path TEXT, manifest_path TEXT,
		workspace_id TEXT, tab_id TEXT, pane_id TEXT, architect_instance TEXT, watcher_workspace_id TEXT, watcher_tab_id TEXT, watcher_pane_id TEXT,
		validation_run_id TEXT, created_at TEXT, updated_at TEXT)`);
	const insert = (id, status, tab, watcherTab) => db.prepare(
		"INSERT INTO architect_proposals (proposal_id, project_key, project_root, project_name, task, status, version, base_playbook, playbook_id, role_id, ephemeral_dir, playbook_path, manifest_path, tab_id, watcher_tab_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(id, "k", "/tmp/p", "p", "t", status, "1", "default", "role-1", "role-1", "/tmp/e", "/tmp/e/p.yaml", "/tmp/e/m.json", tab, watcherTab, "now", "now");
	insert("prop-persistent", "persistent", "tab-architect-1", "tab-watcher-1");
	insert("prop-blocked", "blocked", "tab-architect-2", null);
	insert("prop-active", "active", "tab-architect-3", "tab-watcher-3");
	db.close();
}

// A single pass processes every pending terminal proposal at once — the two
// terminal fixtures (persistent, blocked) are both torn down in this one call.
const architectClosed = closeTerminalArchitectSessions();

check("a PERSISTENT proposal's architect + validation-watcher tabs are both closed and nulled out", () => {
	const entry = architectClosed.find((item) => item.proposal_id === "prop-persistent");
	assert.ok(entry, "prop-persistent appears in the teardown result");
	assert.equal(entry.results.length, 2, "both the architect tab and the paired validation-watcher tab were attempted");
	assert.ok(entry.results.every((r) => r.closed), "both tabs report closed:true from the stub herdr");
	const calls = fs.readFileSync(closeCalls, "utf8").trim().split("\n");
	assert.ok(calls.includes("tab-architect-1") && calls.includes("tab-watcher-1"), "herdr tab close was actually invoked for both tab ids");
});

check("a BLOCKED proposal (rejected, no validation-watcher tab) has its single tab closed in the SAME pass", () => {
	const entry = architectClosed.find((item) => item.proposal_id === "prop-blocked");
	assert.ok(entry, "prop-blocked appears in the same teardown result");
	assert.equal(entry.results.length, 1, "only the architect tab exists for a blocked proposal (no paired watcher)");
});

check("an ACTIVE (non-terminal) proposal is never touched", () => {
	assert.ok(!architectClosed.some((item) => item.proposal_id === "prop-active"), "an in-progress proposal's tabs are left alone");
});

check("re-running teardown is a safe no-op once everything is already closed", () => {
	const closed = closeTerminalArchitectSessions();
	assert.deepEqual(closed, [], "nothing left to close — idempotent by construction (columns already NULL)");
});

// yano-auto-improver.mjs's DB path: <YANO_DATA_DIR>/auto-improver/auto-improver.sqlite
const autoImproverDb = path.join(root, "auto-improver", "auto-improver.sqlite");
fs.mkdirSync(path.dirname(autoImproverDb), { recursive: true });
{
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(autoImproverDb);
	db.exec(`CREATE TABLE IF NOT EXISTS auto_projects (
		project_key TEXT PRIMARY KEY, name TEXT, root TEXT, interval_ms INTEGER, notify TEXT,
		workspace_id TEXT, worker_tab_id TEXT, worker_pane_id TEXT, worker_instance TEXT, worker_status TEXT,
		last_started_at TEXT, last_completed_at TEXT, next_run_at TEXT, created_at TEXT, updated_at TEXT)`);
	const insert = (key, status, tab) => db.prepare(
		"INSERT INTO auto_projects (project_key, name, root, interval_ms, notify, worker_tab_id, worker_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
	).run(key, key, `/tmp/${key}`, 1000, "auto", tab, status, "now", "now");
	insert("proj-just-finished", "idle", "tab-worker-1");
	insert("proj-running", "working", "tab-worker-2");
	insert("proj-never-started", "idle", null);
	db.close();
}

const autoImproverClosed = closeTerminalAutoImproverSessions();

check("a project whose worker just went idle (completed) has its tab closed and columns nulled", () => {
	const entry = autoImproverClosed.find((item) => item.project_key === "proj-just-finished");
	assert.ok(entry, "proj-just-finished appears in the teardown result");
	assert.ok(entry.closed, "the tab close reports success from the stub herdr");
	const calls = fs.readFileSync(closeCalls, "utf8").trim().split("\n");
	assert.ok(calls.includes("tab-worker-1"), "herdr tab close was actually invoked for the finished worker's tab");
});

check("a project whose worker is still WORKING is never touched", () => {
	assert.ok(!autoImproverClosed.some((item) => item.project_key === "proj-running"), "an actively-running audit's tab is left alone");
});

check("a project registered but never actually started (idle, no tab) is never touched", () => {
	assert.ok(!autoImproverClosed.some((item) => item.project_key === "proj-never-started"), "idle-and-never-started is not mistaken for idle-and-just-finished");
});

check("re-running auto-improver teardown is also a safe no-op once closed", () => {
	assert.deepEqual(closeTerminalAutoImproverSessions(), [], "nothing left to close on a second pass");
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(fakeBin, { recursive: true, force: true });
console.log(`\nsmoke-test-maintenance-session-teardown: ${passed} passed`);
