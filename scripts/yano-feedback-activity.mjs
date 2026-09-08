// Evidence used by yano-dash to distinguish a feedback claim from real coder
// work.  A processing card is not proof of execution: the planner can have
// claimed it while no ticket has been assigned, or while the coder is idle.

const ACTIVE_TICKET_STATUSES = new Set(["pending", "running"]);
const TERMINAL_TICKET_STATUSES = new Set(["done", "failed", "cancelled"]);

function asTime(value) {
	const time = Date.parse(String(value || ""));
	return Number.isFinite(time) ? time : null;
}

function eventTimestamp(event) { return asTime(event?.ts || event?.created_at || event?.observed_at); }

function eventLabel(event) {
	if (!event) return "nessuna attività registrata";
	const labels = {
		tool_execution_start: event.tool ? `tool avviato: ${event.tool}` : "tool avviato",
		tool_execution_end: event.tool ? `tool terminato: ${event.tool}` : "tool terminato",
		yano_ticket_claimed: "ticket preso in carico",
		ticket_started: "ticket avviato",
		ticket_stalled: "ticket segnalato come lento",
	};
	return labels[event.type] || String(event.type || "evento").replaceAll("_", " ");
}

function activityForAgent(instance, role, heartbeat, events, tickets, now, heartbeatMaxAgeMs, activityMaxAgeMs) {
	const ownEvents = events.filter((event) => event.instance === instance || event.agent === instance);
	const lastEvent = ownEvents.reduce((latest, event) => !latest || (eventTimestamp(event) || 0) > (eventTimestamp(latest) || 0) ? event : latest, null);
	const lastActivityAt = eventTimestamp(lastEvent);
	const heartbeatAt = asTime(heartbeat?.observed_at || heartbeat?.last_heartbeat);
	const heartbeatAgeMs = heartbeatAt === null ? Infinity : Math.max(0, now - heartbeatAt);
	const assignedTickets = tickets.filter((ticket) => ticket.assigned_instance === instance && ACTIVE_TICKET_STATUSES.has(ticket.status));
	const runningTickets = assignedTickets.filter((ticket) => ticket.status === "running");
	const starts = ownEvents.filter((event) => event.type === "tool_execution_start").sort((a, b) => (eventTimestamp(a) || 0) - (eventTimestamp(b) || 0));
	const ends = ownEvents.filter((event) => event.type === "tool_execution_end").sort((a, b) => (eventTimestamp(a) || 0) - (eventTimestamp(b) || 0));
	const lastStart = starts.at(-1);
	const lastEnd = ends.at(-1);
	const toolActive = lastStart && (!lastEnd || (eventTimestamp(lastStart) || 0) > (eventTimestamp(lastEnd) || 0));
	const heartbeatLive = Boolean(heartbeat?.found && heartbeatAgeMs <= heartbeatMaxAgeMs);
	const recentEvidence = lastActivityAt !== null && now - lastActivityAt <= activityMaxAgeMs;
	let state = "offline";
	if (heartbeatLive && (heartbeat?.status === "busy" || (toolActive && recentEvidence))) state = "active";
	else if (heartbeatLive && heartbeat?.status === "idle") state = "idle";
	else if (heartbeatLive) state = "unknown";
	else if (assignedTickets.length) state = "offline";
	return {
		instance, role: role || "coder", state,
		heartbeat_age_ms: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
		heartbeat_at: heartbeat?.observed_at || heartbeat?.last_heartbeat || null,
		last_activity_at: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
		last_activity: eventLabel(lastEvent),
		last_event_type: lastEvent?.type || null,
		current_tool: toolActive ? (lastStart.tool || "tool") : null,
		tickets: assignedTickets.map((ticket) => ({ id: ticket.id, title: ticket.title, status: ticket.status, run_id: ticket.run_id, updated_at: ticket.updated_at })),
	};
}

/**
 * Derive a deterministic, UI-safe activity snapshot from project evidence.
 * `heartbeats` and `events` are injectable so this function can be tested
 * without Herdr, MQTT or a running project.
 */
export function deriveCoderActivity({ runs = [], heartbeats = [], events = [], now = Date.now(), heartbeatMaxAgeMs = 120_000, activityMaxAgeMs = 120_000 } = {}) {
	const tickets = runs.flatMap((run) => (run.tickets || []).map((ticket) => ({ ...ticket, run_id: ticket.run_id || run.id })));
	const byInstance = new Map();
	for (const heartbeat of heartbeats) {
		if (String(heartbeat.role || "").toLowerCase() === "coder") byInstance.set(heartbeat.instance, heartbeat);
	}
	for (const ticket of tickets) if (ticket.assigned_instance && /^coder(?:-|$)/i.test(ticket.assigned_instance) && !byInstance.has(ticket.assigned_instance)) byInstance.set(ticket.assigned_instance, { instance: ticket.assigned_instance, role: "coder", found: false });
	for (const event of events) if (String(event.role || "").toLowerCase() === "coder" && event.instance && !byInstance.has(event.instance)) byInstance.set(event.instance, { instance: event.instance, role: "coder", found: false });
	const coders = [...byInstance.entries()].map(([instance, heartbeat]) => activityForAgent(instance, "coder", heartbeat, events, tickets, now, heartbeatMaxAgeMs, activityMaxAgeMs));
	const active = coders.filter((coder) => coder.state === "active");
	const assigned = coders.filter((coder) => coder.tickets.length);
	return {
		observed_at: new Date(now).toISOString(),
		state: active.length ? "active" : assigned.some((coder) => coder.state === "offline") ? "offline" : coders.length ? "idle" : "none",
		coders,
		tickets: tickets.filter((ticket) => ACTIVE_TICKET_STATUSES.has(ticket.status)).map((ticket) => ({ id: ticket.id, run_id: ticket.run_id, title: ticket.title, description: ticket.description, status: ticket.status, assigned_instance: ticket.assigned_instance, result_summary: ticket.result_summary, updated_at: ticket.updated_at })),
		active_coder_count: active.length,
		running_ticket_count: tickets.filter((ticket) => ticket.status === "running").length,
	};
}

function searchableTicket(ticket) { return [ticket.id, ticket.title, ticket.description, ticket.result_summary].filter(Boolean).join(" ").toLowerCase(); }

/** Add the per-card link, without guessing when a legacy card has no ticket. */
export function executionForFeedback(item, projectActivity) {
	const linked = (projectActivity?.tickets || []).find((ticket) => searchableTicket(ticket).includes(String(item?.id || "").toLowerCase()));
	const coders = projectActivity?.coders || [];
	const coder = linked?.assigned_instance ? coders.find((candidate) => candidate.instance === linked.assigned_instance) : null;
	if (linked && coder) return { state: coder.state, evidence: "ticket+heartbeat", coder, ticket: linked, observed_at: projectActivity.observed_at };
	if (linked) return { state: "unknown", evidence: "ticket_without_heartbeat", ticket: linked, observed_at: projectActivity.observed_at };
	return {
		state: "not_linked", evidence: "planner_claim_only", observed_at: projectActivity?.observed_at || null,
		project_state: projectActivity?.state || "none", coders: coders.map((candidate) => ({ instance: candidate.instance, state: candidate.state, last_activity: candidate.last_activity })),
	};
}

export function activityText(execution) {
	if (!execution) return "";
	if (execution.state === "not_linked") return "Nessun ticket coder collegato: processing indica solo la presa in carico del planner";
	if (execution.state === "active") return `${execution.coder.instance} · ${execution.coder.current_tool ? execution.coder.current_tool : execution.coder.last_activity}`;
	if (execution.state === "idle") return `${execution.coder.instance} · coder idle`;
	if (execution.state === "offline") return `${execution.coder?.instance || execution.ticket?.assigned_instance || "coder"} · heartbeat scaduto`;
	return execution.coder?.instance || "attività non determinabile";
}
