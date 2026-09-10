// Fase 4 / M5 — pure ticket-scheduling helpers, extracted from
// extensions/orchestrator.ts. Used by scripts/orchestrator-tools/tickets.ts
// (this milestone) and by run_status (stays in orchestrator.ts, out of
// scope for this phase).
import { describe, expect, it } from "vitest";
import { yanoComputeReadyBlocked, yanoComputeExecutionWaves } from "./ticket-scheduling.ts";

function ticket(id, status, run_id = "run-1") {
	return { id, status, run_id };
}
function dep(ticket_id, depends_on_id) {
	return { ticket_id, depends_on_id };
}

describe("yanoComputeReadyBlocked", () => {
	it("a ticket with no dependencies is ready", () => {
		const result = yanoComputeReadyBlocked([ticket("t1", "pending")], []);
		expect(result.ready).toEqual(["t1"]);
	});

	it("a ticket blocked on a not-done dependency is blocked", () => {
		const tickets = [ticket("t1", "pending"), ticket("t2", "pending")];
		const result = yanoComputeReadyBlocked(tickets, [dep("t2", "t1")]);
		expect(result.ready).toEqual(["t1"]);
		expect(result.blocked).toEqual(["t2"]);
	});

	it("a ticket becomes ready once all its dependencies are done", () => {
		const tickets = [ticket("t1", "done"), ticket("t2", "pending")];
		const result = yanoComputeReadyBlocked(tickets, [dep("t2", "t1")]);
		expect(result.ready).toEqual(["t2"]);
	});

	it("buckets running/done/failed/cancelled tickets by status, never re-evaluating readiness for them", () => {
		const tickets = [ticket("t1", "running"), ticket("t2", "done"), ticket("t3", "failed"), ticket("t4", "cancelled")];
		const result = yanoComputeReadyBlocked(tickets, []);
		expect(result.running).toEqual(["t1"]);
		expect(result.done).toEqual(["t2"]);
		expect(result.failed).toEqual(["t3"]);
		expect(result.cancelled).toEqual(["t4"]);
	});
});

describe("yanoComputeExecutionWaves", () => {
	it("independent pending tickets are all in wave 1", () => {
		const tickets = [ticket("t1", "pending"), ticket("t2", "pending")];
		const waves = yanoComputeExecutionWaves(tickets, []);
		expect(waves).toEqual([["t1", "t2"]]);
	});

	it("a dependency chain produces sequential waves", () => {
		const tickets = [ticket("t1", "pending"), ticket("t2", "pending"), ticket("t3", "pending")];
		const deps = [dep("t2", "t1"), dep("t3", "t2")];
		const waves = yanoComputeExecutionWaves(tickets, deps);
		expect(waves).toEqual([["t1"], ["t2"], ["t3"]]);
	});

	it("a dependency on an already-done ticket does not block the wave", () => {
		const tickets = [ticket("t1", "done"), ticket("t2", "pending")];
		const waves = yanoComputeExecutionWaves(tickets, [dep("t2", "t1")]);
		expect(waves).toEqual([["t2"]]);
	});

	it("throws on a genuine dependency cycle among outstanding tickets", () => {
		const tickets = [ticket("t1", "pending"), ticket("t2", "pending")];
		const deps = [dep("t1", "t2"), dep("t2", "t1")];
		expect(() => yanoComputeExecutionWaves(tickets, deps)).toThrow(/dependency cycle detected/);
	});

	it("a running ticket with no further dependents forms its own wave", () => {
		const tickets = [ticket("t1", "running")];
		const waves = yanoComputeExecutionWaves(tickets, []);
		expect(waves).toEqual([["t1"]]);
	});
});
