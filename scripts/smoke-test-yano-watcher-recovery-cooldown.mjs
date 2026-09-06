// Regression for the article-writer / multi-project recovery storm (2026-09-04):
// `ensureRegisteredPlanner` used to call `recoverPlanner` on every single
// one-minute supervisor pass whenever the heartbeat read looked unhealthy —
// with no cooldown at all, unlike `reconcileProjectRun`'s equivalent path.
// A transient heartbeat blip (snapshot lag after Mac sleep/Herdr restart, or
// a just-launched planner that has not published its first heartbeat yet)
// made it close and relaunch the planner tab again and again, once a
// minute, each relaunch paying for a fresh multi-hundred-MB recovery
// snapshot. This test proves the cooldown gate now short-circuits that path
// without touching Herdr/the planner tab at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRegisteredPlanner } from "./yano-watcher-registry.mjs";
import { projectDbPath } from "./yano-project.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-recovery-cooldown-"));
try {
	// ensureRegisteredPlanner()'s FIRST check is projectNeedsPlanner(root),
	// which requires an active run in the project's own SQLite DB — with no
	// DB at all (the original state of this fixture) it returns "no_active_run"
	// before ever reaching the cooldown branch this test exists to prove.
	// Real active work is exactly the scenario the actual incident (a
	// planner mid-task, heartbeat read as unhealthy) was about.
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
	db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "article-writer", "In-progress work", "active", "not_started", new Date().toISOString());
	db.close();

	const row = {
		project_key: "workspace-test",
		name: "article-writer",
		root,
		// Simulates the exact state left by a supervisor pass a few seconds
		// ago: the same reason, well inside the 10-minute cooldown window.
		last_recovery_reason: "planner_missing_or_stale_heartbeat",
		last_recovery_at: new Date().toISOString(),
	};
	// No planner agent present at all, so the "no healthy planner found"
	// branch is reached — this is what used to trigger an unconditional
	// recovery (close tab + relaunch) on every pass.
	const snapshot = {
		workspaces: [{ workspace_id: "w1", label: "article-writer" }],
		panes: [{ pane_id: "p1", workspace_id: "w1", cwd: root }],
		tabs: [],
		agents: [],
	};

	const result = ensureRegisteredPlanner(row, snapshot);
	assert.equal(result.recovery, "recovery_cooldown", "a recovery attempt within the 10-minute cooldown must be skipped, not repeated every supervisor pass");
	assert.equal(result.recovery_reason, "planner_missing_or_stale_heartbeat");
	assert.equal(result.last_recovery_at, row.last_recovery_at);

	// A different reason must not be shielded by an unrelated cooldown —
	// confirms the gate is keyed on (row, reason), matching
	// reconcileProjectRun's existing cooldown semantics exactly.
	const rowDifferentReason = { ...row, last_recovery_reason: "planner_stalled" };
	// Root does not exist here on purpose: it exercises the reason-mismatch
	// branch of recoveryCoolingDown while still short-circuiting before any
	// real Herdr call, keeping this test hermetic.
	rowDifferentReason.root = path.join(root, "does-not-exist");
	const resultDifferentReason = ensureRegisteredPlanner(rowDifferentReason, snapshot);
	assert.equal(resultDifferentReason.recovery, "project_unavailable", "unrelated cooldown reasons must not mask a genuinely unavailable project");

	console.log("smoke-test-yano-watcher-recovery-cooldown: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
