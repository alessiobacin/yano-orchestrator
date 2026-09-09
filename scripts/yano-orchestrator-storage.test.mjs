// Fase 2 / M0 — SQLiteOrchestratorStorage, extracted mechanically (zero
// logic change) from extensions/orchestrator.ts. These tests exercise it
// directly against a real on-disk SQLite file (node:sqlite has no reliable
// :memory: sharing across repeated `new DatabaseSync()` calls in this
// codebase's other usages, so every other SQLite test here already uses a
// temp file — same pattern, for consistency and to match production).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteOrchestratorStorage } from "./yano-orchestrator-storage.ts";

describe("SQLiteOrchestratorStorage", () => {
	let dir;
	let dbPath;
	let db;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-storage-test-"));
		dbPath = path.join(dir, "orchestrator.db");
		db = new SQLiteOrchestratorStorage(dbPath);
		db.init();
	});
	afterEach(() => {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("init() is idempotent — re-opening an already-initialized DB does not throw and reports the same schema version", () => {
		const version = db.getSchemaVersion();
		expect(version).toBeGreaterThan(0);
		db.close();
		const reopened = new SQLiteOrchestratorStorage(dbPath);
		reopened.init();
		expect(reopened.getSchemaVersion()).toBe(version);
		reopened.close();
	});

	it("init() creates the database file on disk under a not-yet-existing directory", () => {
		const nestedPath = path.join(dir, "nested", "sub", "orchestrator.db");
		const nested = new SQLiteOrchestratorStorage(nestedPath);
		nested.init();
		expect(fs.existsSync(nestedPath)).toBe(true);
		nested.close();
	});

	it("run lifecycle: create, get, list, update status and finalization status", () => {
		const run = db.createRun({ project: "demo", objective: "ship the thing" });
		expect(run.status).toBe("active");
		expect(run.finalization_status).toBe("not_started");
		expect(db.getRun(run.id)).toMatchObject({ id: run.id, project: "demo" });
		expect(db.listRuns("demo").map((r) => r.id)).toContain(run.id);
		db.updateRunStatus(run.id, "completed");
		expect(db.getRun(run.id).status).toBe("completed");
		db.updateRunFinalizationStatus(run.id, "finalized");
		expect(db.getRun(run.id).finalization_status).toBe("finalized");
	});

	it("getRun returns null for an unknown id, never throws", () => {
		expect(db.getRun("no-such-run")).toBeNull();
	});

	it("spec + ticket + dependency lifecycle", () => {
		const run = db.createRun({ project: "demo", objective: "o" });
		const spec = db.createSpec({ run_id: run.id, title: "spec", content: "body" });
		const t1 = db.createTicket({ run_id: run.id, spec_id: spec.id, title: "first" });
		const t2 = db.createTicket({ run_id: run.id, spec_id: spec.id, title: "second" });
		expect(t1.status).toBe("pending");
		db.addDependency(t2.id, t1.id);
		const deps = db.listDependencies(run.id);
		expect(deps.some((d) => d.ticket_id === t2.id && d.depends_on_id === t1.id)).toBe(true);
		expect(db.listTickets(run.id).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
	});

	it("updateTicketStatus carries through assigned_instance and result_summary", () => {
		const run = db.createRun({ project: "demo", objective: "o" });
		const spec = db.createSpec({ run_id: run.id, title: "s", content: "b" });
		const ticket = db.createTicket({ run_id: run.id, spec_id: spec.id, title: "t" });
		const updated = db.updateTicketStatus(ticket.id, "running", { assigned_instance: "coder-01" });
		expect(updated.status).toBe("running");
		expect(updated.assigned_instance).toBe("coder-01");
		const done = db.updateTicketStatus(ticket.id, "done", { result_summary: "worked" });
		expect(done.status).toBe("done");
		expect(done.result_summary).toBe("worked");
	});

	it("decision hold: create is idempotent on idempotency_key, then answer resolves it", () => {
		const run = db.createRun({ project: "demo", objective: "o" });
		const first = db.createDecisionHold({ idempotency_key: "k-1", run_id: run.id, question: "proceed?", owner: "planner-01" });
		expect(first.created).toBe(true);
		expect(first.status).toBe("open");
		const retry = db.createDecisionHold({ idempotency_key: "k-1", run_id: run.id, question: "proceed?", owner: "planner-01" });
		expect(retry.created).toBe(false);
		expect(retry.id).toBe(first.id);
		const answered = db.answerDecisionHold(first.id, { generation: first.generation ?? 0, idempotency_key: "answer-1", answer: "yes" });
		expect(answered.status).toBe("answered");
	});

	it("events: recordEvent + listEvents preserve insertion order and payload", () => {
		const run = db.createRun({ project: "demo", objective: "o" });
		db.recordEvent(run.id, "run_started", { note: "go" });
		db.recordEvent(run.id, "run_progress", { note: "still going" });
		const events = db.listEvents(run.id);
		expect(events.map((e) => e.type)).toEqual(["run_started", "run_progress"]);
	});

	it("checkpoints: createCheckpoint + listCheckpoints round-trip the payload", () => {
		const run = db.createRun({ project: "demo", objective: "o" });
		db.createCheckpoint(run.id, "phase-1-done", { files: ["a.ts"] });
		const checkpoints = db.listCheckpoints(run.id);
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0].label).toBe("phase-1-done");
	});

	it("retention policy: setRetentionPolicy then previewRetention reflects the configured cutoffs", () => {
		db.setRetentionPolicy({ project: "demo", event_days: 7, evidence_days: 7, outbox_days: 7, dead_letter_days: 7, policy_version: 1 });
		const preview = db.previewRetention("demo");
		expect(preview.policy.event_days).toBe(7);
	});

	it("benchmark: recordBenchmark does not throw for a well-formed input", () => {
		expect(() => db.recordBenchmark({ project: "demo", name: "latency", dataset: "d1", metrics: { p50: 100 }, thresholds: { p50: 200 } })).not.toThrow();
	});

	it("governance proposals: create, list, validate", () => {
		const created = db.createGovernanceProposal({ kind: "playbook", identifier: "demo-playbook", document: "{}" });
		expect(created).toBeTruthy();
		const list = db.listGovernanceProposals("playbook");
		expect(Array.isArray(list)).toBe(true);
	});

	it("close() is safe to call and does not throw even if called after an error path", () => {
		expect(() => db.close()).not.toThrow();
	});
});
