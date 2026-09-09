// Fase 1 / M3+M4 — adapter-level coverage for the two callers of the shared,
// canonical stalled-ticket detector (scripts/watcher/detect-stalled-
// tickets.mjs — its own logic is covered independently in
// scripts/watcher/detect-stalled-tickets-shared.test.mjs).
//
// History: M3 first pinned the CURRENT behavior of two independent
// implementations, including a real divergence between them (documented
// below, in the commit history, and in the Fase 1 technical review). M4
// unified both behind the shared module, adopting the in-process watchdog's
// semantics as canonical (active-run scoping, inclusive `elapsed >=
// stallMs`). The two tests that used to prove the divergence now prove it is
// RESOLVED — `findStalledTicketsFromDb` matches `yanoFindStalledTickets`
// exactly on both axes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { yanoFindStalledTickets } from "../../extensions/orchestrator.ts";
import { findStalledTicketsFromDb } from "../watch-stalls.mjs";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const STALL_MS = 15 * 60 * 1000; // 15 minutes, this project's real default

function isoMinutesAgo(minutes) {
	return new Date(NOW - minutes * 60_000).toISOString();
}

// A minimal in-memory stand-in for OrchestratorStorage — only the three
// methods yanoFindStalledTickets actually calls (listRuns, listDecisionHolds,
// listTickets). Vitest/esbuild strips TypeScript types without
// type-checking, so a plain object satisfying the interface at runtime is
// sufficient; no `import type` gymnastics needed for a test double.
function makeStorage({ runs, ticketsByRun, openHoldRunIds = new Set() }) {
	return {
		listRuns: () => runs,
		listDecisionHolds: (runId, status) => (status === "open" && openHoldRunIds.has(runId) ? [{ id: "hold-1", run_id: runId, status: "open" }] : []),
		listTickets: (runId) => ticketsByRun[runId] || [],
	};
}

describe("yanoFindStalledTickets (orchestrator.ts, in-process watchdog)", () => {
	it("finds a ticket exactly at the threshold — the comparison is INCLUSIVE (>=)", () => {
		const storage = makeStorage({
			runs: [{ id: "run-1", status: "active" }],
			ticketsByRun: { "run-1": [{ id: "t-1", run_id: "run-1", title: "boundary", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(15) }] },
		});
		const result = yanoFindStalledTickets(storage, "demo", NOW, STALL_MS);
		expect(result.map((item) => item.ticket_id)).toEqual(["t-1"]);
	});

	it("never reports a ticket belonging to a run that is not status==='active'", () => {
		const storage = makeStorage({
			runs: [{ id: "run-1", status: "completed" }],
			ticketsByRun: { "run-1": [{ id: "t-1", title: "stale but completed run", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(60) }] },
		});
		expect(yanoFindStalledTickets(storage, "demo", NOW, STALL_MS)).toEqual([]);
	});

	it("excludes a ticket whose run has an open decision hold", () => {
		const storage = makeStorage({
			runs: [{ id: "run-1", status: "active" }],
			ticketsByRun: { "run-1": [{ id: "t-1", run_id: "run-1", title: "waiting on user", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(60) }] },
			openHoldRunIds: new Set(["run-1"]),
		});
		expect(yanoFindStalledTickets(storage, "demo", NOW, STALL_MS)).toEqual([]);
	});
});

describe("findStalledTicketsFromDb (watch-stalls.mjs, standalone zero-token watcher)", () => {
	let db;
	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, status TEXT, assigned_instance TEXT, updated_at TEXT);
			CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT);
			CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, status TEXT);
		`);
	});
	afterEach(() => db.close());

	function insertTicket({ id, runId, status = "running", updatedAt }) {
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?)").run(id, runId, `title-${id}`, status, "coder-01", updatedAt);
	}
	function insertRun({ id, status = "active" }) {
		db.prepare("INSERT INTO runs VALUES (?,?)").run(id, status);
	}

	it("UNIFIED (Fase 1/M4, was DIVERGENT in M3): at the exact threshold tick, the comparison is now INCLUSIVE (>=) — matches yanoFindStalledTickets exactly", () => {
		insertRun({ id: "run-1" });
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(15) });
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS).map((row) => row.id)).toEqual(["t-1"]);
	});

	it("UNIFIED (Fase 1/M4, was DIVERGENT in M3): a ticket belonging to a NON-active run is no longer reported — run-status scoping now matches yanoFindStalledTickets exactly", () => {
		insertRun({ id: "run-1", status: "completed" });
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(60) });
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS)).toEqual([]);
	});

	it("excludes a ticket whose run has an open decision hold — unchanged, both implementations always agreed on this", () => {
		insertRun({ id: "run-1" });
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(60) });
		db.prepare("INSERT INTO decision_holds VALUES (?,?,?)").run("hold-1", "run-1", "open");
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS)).toEqual([]);
	});

	it("never reports a ticket that is not status==='running'", () => {
		insertRun({ id: "run-1" });
		insertTicket({ id: "t-1", runId: "run-1", status: "done", updatedAt: isoMinutesAgo(60) });
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS)).toEqual([]);
	});

	it("preserves its original public shape — full raw ticket rows in updated_at order, not the shared module's StalledTicketInfo shape", () => {
		insertRun({ id: "run-1" });
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(60) });
		const result = findStalledTicketsFromDb(db, NOW, STALL_MS);
		expect(result).toEqual([{ id: "t-1", run_id: "run-1", title: "title-t-1", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(60) }]);
	});
});
