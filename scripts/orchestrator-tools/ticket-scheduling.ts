// Fase 4 / M5 — pure ticket-scheduling helpers, extracted verbatim from
// extensions/orchestrator.ts. Zero closure dependencies (no
// identity/pi/ctx/storage instance — pure functions of `tickets`/`deps`
// arrays passed in). Used by both the ticket_* tool handlers moved into
// scripts/orchestrator-tools/tickets.ts (this milestone) AND by
// run_status, which stays in orchestrator.ts (explicitly out of scope for
// this phase — it reads every domain's storage by design, see the Fase 4
// plan) — so this is centralized here rather than duplicated into
// tickets.ts, the same reasoning as scripts/orchestrator-tools/redact.ts
// (Fase 4/M0).
import type { TicketRecord, DependencyRecord } from "../yano-orchestrator-storage.ts";

// "Ready"/"blocked" are always COMPUTED, never stored as a ticket status,
// so there is exactly one place ticket state can drift from reality.
export function yanoComputeReadyBlocked(
	tickets: TicketRecord[],
	deps: DependencyRecord[],
): { ready: string[]; blocked: string[]; running: string[]; done: string[]; failed: string[]; cancelled: string[] } {
	const byId = new Map(tickets.map((t) => [t.id, t]));
	const depsByTicket = new Map<string, string[]>();
	for (const d of deps) {
		if (!depsByTicket.has(d.ticket_id)) depsByTicket.set(d.ticket_id, []);
		depsByTicket.get(d.ticket_id)!.push(d.depends_on_id);
	}
	const ready: string[] = [];
	const blocked: string[] = [];
	const running: string[] = [];
	const done: string[] = [];
	const failed: string[] = [];
	const cancelled: string[] = [];
	for (const t of tickets) {
		if (t.status === "done") { done.push(t.id); continue; }
		if (t.status === "failed") { failed.push(t.id); continue; }
		if (t.status === "cancelled") { cancelled.push(t.id); continue; }
		if (t.status === "running") { running.push(t.id); continue; }
		const myDeps = depsByTicket.get(t.id) || [];
		const allDepsDone = myDeps.every((depId) => byId.get(depId)?.status === "done");
		if (allDepsDone) ready.push(t.id);
		else blocked.push(t.id);
	}
	return { ready, blocked, running, done, failed, cancelled };
}

// Groups still-to-schedule tickets (pending or running) into waves: wave N
// contains every ticket whose remaining (not-yet-done) dependencies are all
// in wave < N. Throws on a dependency cycle — same "reject cycles" contract
// architecture.md §20/§0 requires of the DAG validator, applied here to
// whatever subgraph is still outstanding.
export function yanoComputeExecutionWaves(tickets: TicketRecord[], deps: DependencyRecord[]): string[][] {
	const outstanding = tickets.filter((t) => t.status === "pending" || t.status === "running");
	const outstandingIds = new Set(outstanding.map((t) => t.id));
	const doneIds = new Set(tickets.filter((t) => t.status === "done").map((t) => t.id));
	const depsByTicket = new Map<string, Set<string>>();
	for (const t of outstanding) depsByTicket.set(t.id, new Set());
	for (const d of deps) {
		if (!outstandingIds.has(d.ticket_id) || doneIds.has(d.depends_on_id)) continue;
		depsByTicket.get(d.ticket_id)?.add(d.depends_on_id);
	}
	const waves: string[][] = [];
	let remaining = new Set(outstandingIds);
	while (remaining.size > 0) {
		const wave: string[] = [];
		for (const id of remaining) {
			const myDeps = depsByTicket.get(id)!;
			let blocked = false;
			for (const d of myDeps) {
				if (remaining.has(d)) { blocked = true; break; }
			}
			if (!blocked) wave.push(id);
		}
		if (wave.length === 0) {
			throw new Error(`yanoComputeExecutionWaves: dependency cycle detected among tickets: ${[...remaining].sort().join(", ")}`);
		}
		wave.sort();
		waves.push(wave);
		for (const id of wave) remaining.delete(id);
	}
	return waves;
}
