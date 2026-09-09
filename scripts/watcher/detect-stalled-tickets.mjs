// Fase 1 / M4 — the single source of truth for "is this ticket stalled",
// replacing two independent implementations that had drifted apart:
//   - extensions/orchestrator.ts's yanoFindStalledTickets() (in-process
//     watchdog, only runs while a planner session is alive)
//   - scripts/watch-stalls.mjs's inline SQL query (standalone zero-token
//     watcher, runs even with no live session)
// scripts/watcher/detect-stalled-tickets.test.mjs (M3) documents the exact
// divergence found between them; scripts/watcher/
// detect-stalled-tickets-shared.test.mjs pins the canonical semantics
// adopted here — the in-process version's, confirmed by the user as more
// correct: active-run scoping, and an INCLUSIVE `elapsed >= stallMs`
// comparison.
//
// Pure and dependency-injected on purpose: it never touches SQLite, MQTT,
// or Date.now() itself, so both callers (one backed by the
// OrchestratorStorage abstraction, one backed by raw sqlite rows) can adapt
// their own data shape into { tickets, runs, openHoldRunIds } and get the
// exact same verdict — see the two thin adapters in orchestrator.ts and
// watch-stalls.mjs.

/**
 * @typedef {{ id: string, run_id: string, status: string, title: string, assigned_instance: string | null, updated_at: string }} TicketRow
 * @typedef {{ id: string, status: string }} RunRow
 * @typedef {{ run_id: string, ticket_id: string, title: string, assigned_instance: string | null, running_since: string, elapsed_ms: number }} StalledTicketInfo
 */

/**
 * @param {{ tickets: TicketRow[], runs: RunRow[], openHoldRunIds: Set<string> }} input
 * @param {number} nowMs
 * @param {number} stallMs
 * @returns {StalledTicketInfo[]}
 */
export function detectStalledTickets({ tickets, runs, openHoldRunIds }, nowMs, stallMs) {
	const activeRunIds = new Set((runs || []).filter((run) => run.status === "active").map((run) => run.id));
	const stalled = [];
	for (const ticket of tickets || []) {
		if (ticket.status !== "running") continue;
		if (!activeRunIds.has(ticket.run_id)) continue;
		if (openHoldRunIds?.has(ticket.run_id)) continue;
		const elapsed = nowMs - Date.parse(ticket.updated_at);
		if (elapsed >= stallMs) {
			stalled.push({ run_id: ticket.run_id, ticket_id: ticket.id, title: ticket.title, assigned_instance: ticket.assigned_instance, running_since: ticket.updated_at, elapsed_ms: elapsed });
		}
	}
	return stalled;
}
