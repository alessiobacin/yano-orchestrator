// Fase 1 / M4 — unit tests for the shared, canonical stalled-ticket detector
// (scripts/watcher/detect-stalled-tickets.mjs), written BEFORE the module
// exists. Canonical semantics were confirmed with the user after
// scripts/watcher/detect-stalled-tickets.test.mjs (M3) pinned the divergence
// between the two pre-existing implementations: adopt the in-process
// watchdog's behavior (active-run scoping + inclusive `>=`) as the one
// source of truth both callers delegate to from here on.
import { describe, expect, it } from "vitest";
import { detectStalledTickets } from "./detect-stalled-tickets.mjs";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const STALL_MS = 15 * 60 * 1000;

function isoMinutesAgo(minutes) {
	return new Date(NOW - minutes * 60_000).toISOString();
}

function ticket(overrides = {}) {
	return { id: "t-1", run_id: "run-1", title: "fixture", status: "running", assigned_instance: "coder-01", updated_at: isoMinutesAgo(60), ...overrides };
}

describe("detectStalledTickets — canonical semantics (formerly only in orchestrator.ts)", () => {
	it("finds a ticket exactly at the threshold — INCLUSIVE (>=), matching the orchestrator.ts behavior chosen as canonical", () => {
		const result = detectStalledTickets(
			{ tickets: [ticket({ updated_at: isoMinutesAgo(15) })], runs: [{ id: "run-1", status: "active" }], openHoldRunIds: new Set() },
			NOW,
			STALL_MS,
		);
		expect(result.map((item) => item.ticket_id)).toEqual(["t-1"]);
	});

	it("does NOT report a ticket one millisecond before the threshold", () => {
		const result = detectStalledTickets(
			{ tickets: [ticket({ updated_at: new Date(NOW - STALL_MS + 1).toISOString() })], runs: [{ id: "run-1", status: "active" }], openHoldRunIds: new Set() },
			NOW,
			STALL_MS,
		);
		expect(result).toEqual([]);
	});

	it("RESOLVED DIVERGENCE: never reports a ticket whose run is not status==='active' — this is the scoping bug watch-stalls.mjs's raw SQL never had", () => {
		const result = detectStalledTickets(
			{ tickets: [ticket({ updated_at: isoMinutesAgo(60) })], runs: [{ id: "run-1", status: "completed" }], openHoldRunIds: new Set() },
			NOW,
			STALL_MS,
		);
		expect(result).toEqual([]);
	});

	it("excludes a ticket whose run has an open decision hold", () => {
		const result = detectStalledTickets(
			{ tickets: [ticket({ updated_at: isoMinutesAgo(60) })], runs: [{ id: "run-1", status: "active" }], openHoldRunIds: new Set(["run-1"]) },
			NOW,
			STALL_MS,
		);
		expect(result).toEqual([]);
	});

	it("never reports a ticket that is not status==='running'", () => {
		const result = detectStalledTickets(
			{ tickets: [ticket({ status: "done", updated_at: isoMinutesAgo(60) })], runs: [{ id: "run-1", status: "active" }], openHoldRunIds: new Set() },
			NOW,
			STALL_MS,
		);
		expect(result).toEqual([]);
	});

	it("reports the full StalledTicketInfo shape both callers already depend on", () => {
		const result = detectStalledTickets(
			{ tickets: [ticket({ id: "t-9", assigned_instance: "coder-05", updated_at: isoMinutesAgo(30) })], runs: [{ id: "run-1", status: "active" }], openHoldRunIds: new Set() },
			NOW,
			STALL_MS,
		);
		expect(result).toEqual([{ run_id: "run-1", ticket_id: "t-9", title: "fixture", assigned_instance: "coder-05", running_since: isoMinutesAgo(30), elapsed_ms: 30 * 60_000 }]);
	});

	it("handles multiple runs/tickets independently, only flagging the ones that qualify", () => {
		const tickets = [
			ticket({ id: "t-active-stalled", run_id: "run-a", updated_at: isoMinutesAgo(60) }),
			ticket({ id: "t-active-fresh", run_id: "run-a", updated_at: isoMinutesAgo(1) }),
			ticket({ id: "t-inactive-run", run_id: "run-b", updated_at: isoMinutesAgo(60) }),
		];
		const runs = [{ id: "run-a", status: "active" }, { id: "run-b", status: "completed" }];
		const result = detectStalledTickets({ tickets, runs, openHoldRunIds: new Set() }, NOW, STALL_MS);
		expect(result.map((item) => item.ticket_id)).toEqual(["t-active-stalled"]);
	});
});
