// Fase 1 / M3 — Vitest scaffolding. Pins the CURRENT behavior of the two
// independent "is this ticket stalled" implementations, including their
// documented divergence, as committed, reviewable test cases. No behavior
// change here (M4 unifies them behind a shared module) — this is the
// artifact used to decide, in the open, which semantics becomes canonical.
//
// - `yanoFindStalledTickets` (extensions/orchestrator.ts): scopes to runs
//   with status === "active" only, and uses an INCLUSIVE `elapsed >= stallMs`
//   comparison.
// - `findStalledTicketsFromDb` (scripts/watch-stalls.mjs, extracted
//   mechanically in this same milestone with zero behavior change): queries
//   ALL `running` tickets globally regardless of their run's status, and
//   uses a STRICT `elapsed > stallMs` comparison.
//
// Both correctly exclude tickets whose run has an open decision hold.
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
			ticketsByRun: { "run-1": [{ id: "t-1", title: "boundary", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(15) }] },
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
			ticketsByRun: { "run-1": [{ id: "t-1", title: "waiting on user", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(60) }] },
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
			CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, status TEXT);
		`);
	});
	afterEach(() => db.close());

	function insertTicket({ id, runId, status = "running", updatedAt }) {
		db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?)").run(id, runId, `title-${id}`, status, "coder-01", updatedAt);
	}

	it("DIVERGENCE: at the exact threshold tick, the comparison is STRICT (>) — the same ticket yanoFindStalledTickets already reports as stalled is NOT yet reported here", () => {
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(15) });
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS)).toEqual([]);
		// One millisecond past the threshold, it does report it — confirming
		// this is genuinely a boundary/comparison-operator difference, not a
		// broader bug in this path.
		expect(findStalledTicketsFromDb(db, NOW + 1, STALL_MS)).toHaveLength(1);
	});

	it("DIVERGENCE: reports a stalled ticket even when its run is NOT active — there is no run-status scoping at all (a real gap vs. yanoFindStalledTickets)", () => {
		// This query never joins against a `runs` table — "run-1" here is only
		// ever referenced by decision_holds, never checked for a status.
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(60) });
		const result = findStalledTicketsFromDb(db, NOW, STALL_MS);
		expect(result.map((row) => row.id)).toEqual(["t-1"]);
	});

	it("excludes a ticket whose run has an open decision hold — same protection as yanoFindStalledTickets, this part is NOT divergent", () => {
		insertTicket({ id: "t-1", runId: "run-1", updatedAt: isoMinutesAgo(60) });
		db.prepare("INSERT INTO decision_holds VALUES (?,?,?)").run("hold-1", "run-1", "open");
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS)).toEqual([]);
	});

	it("never reports a ticket that is not status==='running'", () => {
		insertTicket({ id: "t-1", runId: "run-1", status: "done", updatedAt: isoMinutesAgo(60) });
		expect(findStalledTicketsFromDb(db, NOW, STALL_MS)).toEqual([]);
	});
});
