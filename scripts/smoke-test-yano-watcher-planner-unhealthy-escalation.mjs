// Regression for the 2026-09-12/13 incident: ensureRegisteredPlanner()
// deferred to a stale-but-OS-process-present planner FOREVER — a wedged/
// hung Pi process (event loop dead, MQTT connection dropped, but the node
// process itself never exited) looks identical to a genuine transient blip
// on every single one-minute supervisor pass, with no upper bound. The
// planner that crashed overnight sat unrecovered for 12+ hours until a
// manual `yano repair --force`, because the watcher kept returning
// "planner_process_present_stale_heartbeat" every minute without ever
// escalating to an actual close+relaunch.
//
// This proves: (1) the existing deferral behavior is unchanged for a fresh
// or recent unhealthy observation (no regression on the legitimate
// transient-blip protection), and (2) once the SAME unhealthy state has
// persisted longer than PLANNER_UNHEALTHY_ESCALATION_MS, it stops deferring
// and actually attempts recovery (closeHerdrTab gets invoked) instead of
// returning the deferred status again.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRegisteredPlanner } from "./yano-watcher-registry.mjs";
import { projectDbPath } from "./yano-project.mjs";

console.log("Regression: a stale-but-present planner eventually escalates past deferral");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-unhealthy-escalation-"));
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-unhealthy-escalation-bin-"));
const closedTabsMarker = path.join(fakeBin, "closed-tabs.log");

try {
	const { DatabaseSync } = process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : await import("node:sqlite");
	fs.mkdirSync(path.dirname(projectDbPath(root)), { recursive: true });
	const db = new DatabaseSync(projectDbPath(root));
	db.exec(`
		CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT);
		CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
		CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, question TEXT, status TEXT, created_at TEXT);
		CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, updated_at TEXT);
		CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT);
		CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT);
		CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT);
	`);
	db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "escalation-fixture", "In-progress work", "active", "not_started", new Date().toISOString());
	db.close();

	const row = { project_key: "workspace-test", name: "escalation-fixture", root };
	const snapshot = {
		workspaces: [{ workspace_id: "w1", label: "escalation-fixture" }],
		tabs: [{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" }],
		panes: [{ pane_id: "p-planner", tab_id: "t-planner", workspace_id: "w1", cwd: root }],
		// agent_status "offline" short-circuits plannerHeartbeatHealthy()'s very
		// first check (only "idle"/"working" can be healthy) without needing to
		// mock `herdr agent explain` at all — this is the "stale heartbeat" half
		// of the scenario. paneHasLivePiProcess() (the "OS process still there"
		// half) is driven separately below via YANO_TEST_ALIVE_PANES.
		agents: [{ name: "planner-01", cwd: root, workspace_id: "w1", tab_id: "t-planner", pane_id: "p-planner", agent_status: "offline" }],
	};

	// Minimal fake herdr: reports the fixed pane as alive, serves a static
	// `api snapshot` (recoverPlanner()'s own internal re-check sees the same
	// still-alive pane and returns its own deferred result gracefully — this
	// test only needs to prove ensureRegisteredPlanner() actually reaches and
	// calls closeHerdrTab(), not that the full multi-step recovery completes),
	// and records every `tab close` invocation to a marker file.
	fs.writeFileSync(path.join(fakeBin, "herdr"), [
		"#!/usr/bin/env node",
		"const fs=require('node:fs');",
		"const args=process.argv.slice(2);",
		'const alive = new Set((process.env.YANO_TEST_ALIVE_PANES || "").split(",").filter(Boolean));',
		'if (args[0] === "pane" && args[1] === "process-info") {',
		'  const paneId = args[args.indexOf("--pane") + 1];',
		'  const foreground = alive.has(paneId) ? [{ argv0: "pi", argv: ["pi"] }] : [];',
		'  process.stdout.write(JSON.stringify({ result: { process_info: { foreground_processes: foreground } } }));',
		"  process.exit(0);",
		"}",
		'if (args[0] === "api" && args[1] === "snapshot") {',
		"  process.stdout.write(" + JSON.stringify(JSON.stringify({ result: { snapshot } })) + ");",
		"  process.exit(0);",
		"}",
		'if (args[0] === "tab" && args[1] === "close") {',
		'  fs.appendFileSync(' + JSON.stringify(closedTabsMarker) + ', args[2] + "\\n");',
		"  process.exit(0);",
		"}",
		'process.stdout.write("{}");',
		"process.exit(0);",
	].join("\n"));
	fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
	process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;
	process.env.YANO_TEST_ALIVE_PANES = "p-planner";

	check("a FRESH stale-but-present observation still defers, unchanged from before this fix", () => {
		const result = ensureRegisteredPlanner({ ...row }, snapshot);
		assert.equal(result.recovery, "planner_process_present_stale_heartbeat");
		assert.ok(!fs.existsSync(closedTabsMarker), "closeHerdrTab must not be called on the very first observation");
	});

	check("a RECENT (5 minutes) unhealthy observation still defers — no false-positive escalation", () => {
		const recentRow = { ...row, planner_unhealthy_since: new Date(Date.now() - 5 * 60_000).toISOString() };
		const result = ensureRegisteredPlanner(recentRow, snapshot);
		assert.equal(result.recovery, "planner_process_present_stale_heartbeat");
		assert.ok(!fs.existsSync(closedTabsMarker), "closeHerdrTab must not be called before the escalation threshold is reached");
	});

	check("an unhealthy observation older than PLANNER_UNHEALTHY_ESCALATION_MS (30 min) stops deferring and attempts recovery", () => {
		const staleRow = { ...row, planner_unhealthy_since: new Date(Date.now() - 31 * 60_000).toISOString() };
		const result = ensureRegisteredPlanner(staleRow, snapshot);
		assert.notEqual(result.recovery, "planner_process_present_stale_heartbeat", "must stop returning the indefinite-deferral status once past the threshold");
		assert.ok(fs.existsSync(closedTabsMarker), "closeHerdrTab must actually be invoked once escalated");
		assert.equal(fs.readFileSync(closedTabsMarker, "utf8").trim(), "t-planner");
	});

	console.log(`\nsmoke-test-yano-watcher-planner-unhealthy-escalation: ${passed} passed`);
} finally {
	delete process.env.YANO_TEST_ALIVE_PANES;
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(fakeBin, { recursive: true, force: true });
}
