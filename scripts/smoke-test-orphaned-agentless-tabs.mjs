// Regression test for the "un sacco di tab morte" gap found on 2026-09-05:
// cleanupCompletedAgentTabs() only ever looped over snapshot.agents — but a
// Pi process that has fully exited disappears from snapshot.agents entirely
// (Herdr keeps no "dead agent" placeholder), so its TAB lingers forever with
// no owning agent, completely invisible to that loop. Real evidence: a
// single project (article-writer) had 12 such orphaned tabs accumulated
// (duplicated coder-02/docs-sync instances whose process had long exited).
//
// This also covers the explicit new requirement: a tab conventionally
// labelled "human" (the user's own manual terminal in a project workspace)
// must never be closed by this sweep, exactly like a planner tab — even in
// the new agent-less sweep path.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupCompletedAgentTabs, doStatusForRow } from "./yano-watcher-registry.mjs";
import { projectDbPath } from "./yano-project.mjs";

console.log("Regression: orphaned agent-less tabs are swept; human/planner tabs never are");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

// The agent-less sweep path never calls paneHasLivePiProcess() (there is no
// pane to probe), but the pre-existing live-agent loop still does — a fake
// herdr on PATH is needed for the one scenario below that must prove a
// genuinely alive worker survives (same technique as
// smoke-test-planner-tab-never-closed.mjs).
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-orphan-tabs-test-bin-"));
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	'const alive = new Set((process.env.YANO_TEST_ALIVE_PANES || "").split(",").filter(Boolean));',
	'if (process.argv[2] === "pane" && process.argv[3] === "process-info") {',
	'  const paneId = process.argv[process.argv.indexOf("--pane") + 1];',
	'  const foreground = alive.has(paneId) ? [{ argv0: "pi", argv: ["pi"] }] : [];',
	'  process.stdout.write(JSON.stringify({ result: { process_info: { foreground_processes: foreground } } }));',
	"  process.exit(0);",
	"}",
	'process.stdout.write("{}");',
	"process.exit(1);",
].join("\n"));
fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.YANO_TEST_ALIVE_PANES = "p-planner,p-coder-live";

const row = { root: "/tmp/fixture-project-orphans", name: "fixture-project-orphans" };

function snapshotWith({ agents = [], tabs = [] }) {
	return { agents, tabs };
}

check("an agent-less tab whose instance has a done ticket is closed as 'orphaned_agentless_terminal_ticket'", () => {
	const tabs = [{ tab_id: "t-docs-sync", workspace_id: "w1", label: "docs-sync-01-fixture" }];
	const workspaceAgent = { name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" };
	const snapshot = snapshotWith({
		agents: [workspaceAgent],
		tabs: [{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" }, ...tabs],
	});
	snapshot.workspaces = [{ workspace_id: "w1", label: row.name }];
	snapshot.panes = [{ pane_id: "p-planner", workspace_id: "w1", cwd: row.root }];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "docs-sync-01-fixture" }] }];
	const removed = cleanupCompletedAgentTabs(snapshot, row, runs);
	const orphan = removed.find((item) => item.tab_id === "t-docs-sync");
	assert.ok(orphan, "the agent-less docs-sync tab is closed");
	assert.equal(orphan.reason, "orphaned_agentless_terminal_ticket");
	assert.equal(orphan.instance, "docs-sync-01-fixture");
});

check("a HUMAN tab is never closed, even with no agent and even if its label happened to match a terminal assignment", () => {
	const snapshot = snapshotWith({
		agents: [{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" }],
		tabs: [
			{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" },
			{ tab_id: "t-human", workspace_id: "w1", label: "human" },
		],
	});
	snapshot.workspaces = [{ workspace_id: "w1", label: row.name }];
	snapshot.panes = [{ pane_id: "p-planner", workspace_id: "w1", cwd: row.root }];
	// Even in the pathological case where a ticket's assigned_instance is
	// literally "human" (should never happen, but defense-in-depth matters
	// exactly because it should never happen), the human tab must survive.
	const runs = [{ tickets: [{ status: "done", assigned_instance: "human" }] }];
	const removed = cleanupCompletedAgentTabs(snapshot, row, runs);
	assert.ok(!removed.some((item) => item.tab_id === "t-human"), "the human tab is never in the closed list");
});

check("a HUMAN tab label is matched case-insensitively and trims whitespace", () => {
	const snapshot = snapshotWith({
		agents: [{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" }],
		tabs: [
			{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" },
			{ tab_id: "t-human", workspace_id: "w1", label: " Human " },
		],
	});
	snapshot.workspaces = [{ workspace_id: "w1", label: row.name }];
	snapshot.panes = [{ pane_id: "p-planner", workspace_id: "w1", cwd: row.root }];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "Human" }] }];
	const removed = cleanupCompletedAgentTabs(snapshot, row, runs);
	assert.ok(!removed.some((item) => item.tab_id === "t-human"), "human protection is case/whitespace insensitive");
});

check("an agent-less tab with NO terminal-assignment match is left alone — a freshly-launched instance is not yet in ticket history", () => {
	const snapshot = snapshotWith({
		agents: [{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" }],
		tabs: [
			{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" },
			{ tab_id: "t-fresh", workspace_id: "w1", label: "coder-03-not-yet-registered" },
		],
	});
	snapshot.workspaces = [{ workspace_id: "w1", label: row.name }];
	snapshot.panes = [{ pane_id: "p-planner", workspace_id: "w1", cwd: row.root }];
	const removed = cleanupCompletedAgentTabs(snapshot, row, []);
	assert.ok(!removed.some((item) => item.tab_id === "t-fresh"), "an unmatched agent-less tab is never closed on absence-of-evidence alone");
});

check("a LIVE agent's tab is never double-closed by the agent-less sweep path", () => {
	const snapshot = snapshotWith({
		agents: [
			{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" },
			{ name: "coder-05", cwd: row.root, tab_id: "t-coder-live", pane_id: "p-coder-live", agent_status: "working" },
		],
		tabs: [
			{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" },
			{ tab_id: "t-coder-live", workspace_id: "w1", label: "coder-05" },
		],
	});
	snapshot.workspaces = [{ workspace_id: "w1", label: row.name }];
	snapshot.panes = [{ pane_id: "p-planner", workspace_id: "w1", cwd: row.root }, { pane_id: "p-coder-live", workspace_id: "w1", cwd: row.root }];
	// coder-05 has a done ticket but is currently "working" (still alive per
	// the live-agent branch's own status gate) — must survive both passes.
	const runs = [{ tickets: [{ status: "done", assigned_instance: "coder-05" }] }];
	const removed = cleanupCompletedAgentTabs(snapshot, row, runs);
	assert.deepEqual(removed, [], "a live, working agent survives even with a stale terminal ticket on record");
});

check("an agent-less tab in a DIFFERENT project's workspace is never touched", () => {
	const snapshot = snapshotWith({
		agents: [{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" }],
		tabs: [
			{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" },
			{ tab_id: "t-other-project", workspace_id: "w-other", label: "coder-01-other-project" },
		],
	});
	snapshot.workspaces = [{ workspace_id: "w1", label: row.name }, { workspace_id: "w-other", label: "other-project" }];
	snapshot.panes = [{ pane_id: "p-planner", workspace_id: "w1", cwd: row.root }];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "coder-01-other-project" }] }];
	const removed = cleanupCompletedAgentTabs(snapshot, row, runs);
	assert.ok(!removed.some((item) => item.tab_id === "t-other-project"), "workspace scoping prevents cross-project orphan closure");
});

// Real evidence (2026-09-05): the project with 12 orphaned tabs had its
// watcher PAUSED — doStatusForRow() used to return immediately for any
// worker_status other than "running" ("respect the explicit state, nothing
// to heal"), which meant this exact cleanup never ran for it at all,
// regardless of how the sweep itself behaved. Prove the fix against a REAL
// project SQLite DB (not the bare cleanupCompletedAgentTabs() unit above).
{
	const pausedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-paused-project-"));
	const pausedRow = { root: pausedRoot, name: "paused-fixture", worker_status: "paused", worker_pane_id: "p-worker-paused" };
	const { DatabaseSync } = process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : await import("node:sqlite");
	fs.mkdirSync(path.dirname(projectDbPath(pausedRoot)), { recursive: true });
	const db = new DatabaseSync(projectDbPath(pausedRoot));
	db.exec(`
		CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT);
		CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
		CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, question TEXT, status TEXT, created_at TEXT);
		CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, updated_at TEXT);
		CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT);
		CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT);
		CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT);
	`);
	const nowIso = new Date().toISOString();
	db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "paused-fixture", "Old finished work", "done", "finalized", nowIso);
	db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?)").run("t-1", "run-1", "Old task", "done", "coder-09-paused-fixture", null, nowIso);
	db.close();

	const snapshot = {
		agents: [],
		tabs: [{ tab_id: "t-dead-in-paused", workspace_id: "w-paused", label: "coder-09-paused-fixture" }],
		workspaces: [{ workspace_id: "w-paused", label: "paused-fixture" }],
		panes: [],
	};

	check("a PAUSED project's dead agent-less tabs are still swept — pausing the watcher's polling loop must not preserve dead terminal clutter", () => {
		const result = doStatusForRow(null, pausedRow, { heal: true, snapshot });
		assert.ok(result.agent_tabs_closed?.some((item) => item.tab_id === "t-dead-in-paused"), "the dead tab in the paused project is closed");
	});

	check("a PAUSED project's worker/cadence fields are untouched by this cleanup (only agent tabs are swept, never the watcher's own state)", () => {
		const result = doStatusForRow(null, pausedRow, { heal: true, snapshot });
		assert.equal(result.worker_status, "paused", "the explicit pause is never overridden by this cleanup");
	});

	fs.rmSync(pausedRoot, { recursive: true, force: true });
}

delete process.env.YANO_TEST_ALIVE_PANES;
fs.rmSync(fakeBin, { recursive: true, force: true });
console.log(`\nsmoke-test-orphaned-agentless-tabs: ${passed} passed`);
