// Fase 3 / M2 — reading a project's own run/ticket/decision-hold state,
// extracted from scripts/yano-watcher-registry.mjs. Real on-disk SQLite at
// the exact path projectDbPath(root) resolves to, same minimal-schema
// convention already used by scripts/smoke-test-orphaned-agentless-tabs.mjs
// for this exact function.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { projectDbPath } from "../yano-project.mjs";
import { projectNeedsPlanner, projectOpenHolds, projectRuns, runNeedsPlanner } from "./project-runs.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") || require("node:sqlite");

describe("project-runs", () => {
	let root;
	let dbPath;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "project-runs-test-"));
		dbPath = projectDbPath(root);
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function seedFullSchema() {
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT);
			CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
			CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, question TEXT, status TEXT, created_at TEXT);
			CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, description TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, result_summary TEXT, updated_at TEXT);
			CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT);
			CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT);
			CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT);
			CREATE TABLE yano_recovery_pauses (run_id TEXT, status TEXT);
		`);
		return db;
	}

	it("returns available:false with no runs when the project DB does not exist yet", () => {
		expect(projectRuns(root)).toEqual({ available: false, runs: [] });
		expect(projectOpenHolds(root)).toEqual([]);
		expect(projectNeedsPlanner(root)).toBe(false);
	});

	it("lists a single active run with its ticket, dependency, and open-hold counts", () => {
		const db = seedFullSchema();
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "ship it", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?)").run("t-1", "run-1", "task one", null, "pending", null, null, null, "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("h-1", "run-1", "t-1", "quale approccio?", "open", "2026-01-01T00:00:00.000Z");
		db.close();

		const result = projectRuns(root);
		expect(result.available).toBe(true);
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]).toMatchObject({ id: "run-1", status: "active", open_holds: 1, pending_ticket_count: 1 });
	});

	it("marks a ticket as ready-pending only once every dependency is done", () => {
		const db = seedFullSchema();
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?)").run("t-a", "run-1", "A", null, "done", "coder-01", null, null, "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?)").run("t-b", "run-1", "B", null, "pending", null, null, null, "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("t-b", "t-a");
		db.close();

		const runs = projectRuns(root).runs;
		expect(runs[0].ready_pending_tickets).toEqual(["t-b"]);
	});

	it("flags ticket_out_of_order when a running/done ticket has an unfinished dependency", () => {
		const db = seedFullSchema();
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?)").run("t-a", "run-1", "A", null, "pending", null, null, null, "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?)").run("t-b", "run-1", "B", null, "running", "coder-01", null, null, "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("t-b", "t-a");
		db.close();

		const violations = projectRuns(root).runs[0].playbook_flow.violations;
		expect(violations).toContainEqual(expect.objectContaining({ kind: "ticket_out_of_order", ticket_id: "t-b" }));
	});

	it("marks a run paused when yano_recovery_pauses has an open pause row for it", () => {
		const db = seedFullSchema();
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO yano_recovery_pauses VALUES (?,?)").run("run-1", "paused");
		db.close();

		expect(projectRuns(root).runs[0].paused).toBe(true);
	});

	it("still returns runs when yano_recovery_pauses does not exist yet (older DB)", () => {
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT);
			CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
			CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, question TEXT, status TEXT, created_at TEXT);
			CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, updated_at TEXT);
			CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT);
			CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT);
			CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT);
		`);
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.close();

		const result = projectRuns(root);
		expect(result.available).toBe(true);
		expect(result.runs[0].paused).toBe(false);
	});

	it("falls back to the legacy ticket column set when description/result_summary columns are absent", () => {
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT);
			CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
			CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, question TEXT, status TEXT, created_at TEXT);
			CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, updated_at TEXT);
			CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT);
			CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT);
			CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT);
		`);
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?)").run("t-1", "run-1", "legacy ticket", "pending", null, null, "2026-01-01T00:00:00.000Z");
		db.close();

		const result = projectRuns(root);
		expect(result.available).toBe(true);
		expect(result.runs[0].tickets).toHaveLength(1);
		expect(result.runs[0].tickets[0].title).toBe("legacy ticket");
	});

	it("projectOpenHolds returns only status='open' holds, oldest first", () => {
		const db = seedFullSchema();
		db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("h-1", "run-1", "t-1", "second question", "open", "2026-01-02T00:00:00.000Z");
		db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("h-2", "run-1", "t-1", "first question", "open", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("h-3", "run-1", "t-1", "answered already", "answered", "2026-01-01T00:00:00.000Z");
		db.close();

		const holds = projectOpenHolds(root);
		expect(holds.map((h) => h.id)).toEqual(["h-2", "h-1"]);
	});

	describe("runNeedsPlanner", () => {
		it("is true only for an active, non-paused run", () => {
			expect(runNeedsPlanner({ status: "active", paused: false })).toBe(true);
			expect(runNeedsPlanner({ status: "active", paused: true })).toBe(false);
			expect(runNeedsPlanner({ status: "completed", finalization_status: "pending_finalize" })).toBe(false);
		});
	});

	describe("projectNeedsPlanner", () => {
		it("is true when a run needs a planner", () => {
			const db = seedFullSchema();
			db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
			db.close();
			expect(projectNeedsPlanner(root)).toBe(true);
		});

		it("is false for a paused run even with an open decision hold — pause always wins", () => {
			const db = seedFullSchema();
			db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "active", "not_started", "2026-01-01T00:00:00.000Z");
			db.prepare("INSERT INTO yano_recovery_pauses VALUES (?,?)").run("run-1", "paused");
			db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("h-1", "run-1", "t-1", "q", "open", "2026-01-01T00:00:00.000Z");
			db.close();
			expect(projectNeedsPlanner(root)).toBe(false);
		});

		it("is true when a run is active with no open holds but a non-paused run elsewhere has one", () => {
			const db = seedFullSchema();
			db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "completed", "finalized", "2026-01-01T00:00:00.000Z");
			db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("h-1", "run-1", "t-1", "q", "open", "2026-01-01T00:00:00.000Z");
			db.close();
			expect(projectNeedsPlanner(root)).toBe(true);
		});

		it("is false once the only run is completed", () => {
			const db = seedFullSchema();
			db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", "demo", "o", "completed", "finalized", "2026-01-01T00:00:00.000Z");
			db.close();
			expect(projectNeedsPlanner(root)).toBe(false);
		});
	});
});
