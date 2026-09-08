import { html } from "htm/preact";
import { dateIt } from "../columns.js";

const LABELS = { active: "CODER ATTIVO", idle: "CODER IDLE", offline: "CODER OFFLINE", unknown: "ATTIVITÀ INCERTA", not_linked: "NESSUN TICKET CODER" };
const COLORS = { active: "border-emerald-500/50 bg-emerald-950/40 text-emerald-200", idle: "border-amber-500/50 bg-amber-950/30 text-amber-200", offline: "border-red-500/50 bg-red-950/30 text-red-200", unknown: "border-slate-500 bg-slate-950/40 text-slate-300", not_linked: "border-amber-500/50 bg-amber-950/30 text-amber-200" };
function activityText(execution) {
	if (execution.state === "not_linked") return "Nessun ticket coder collegato: processing indica solo la presa in carico del planner";
	if (execution.state === "active") return `${execution.coder?.current_tool || execution.coder?.last_activity || "attività recente"}`;
	if (execution.state === "idle") return "coder idle";
	if (execution.state === "offline") return "heartbeat scaduto";
	return "attività non determinabile";
}

export function ActivityIndicator({ execution, compact = false }) {
	if (!execution) return null;
	const state = execution.state || "unknown";
	const coder = execution.coder;
	return html`
		<div class=${`mt-2 rounded border px-2 py-1.5 text-[10px] ${COLORS[state] || COLORS.unknown}`} title="Evidenza tecnica dell'attività reale del coder">
			<div class="flex items-center justify-between gap-2 font-bold tracking-wide">
				<span>${LABELS[state] || state.toUpperCase()}</span>
				${coder ? html`<span>${coder.instance}</span>` : null}
			</div>
			${!compact ? html`
				<div class="mt-1 break-words leading-snug">${activityText(execution)}</div>
				${execution.ticket ? html`<div class="mt-1 break-words opacity-80">Ticket: ${execution.ticket.title || execution.ticket.id} · ${execution.ticket.status}</div>` : null}
				${coder?.last_activity_at ? html`<div class="mt-1 opacity-70">Ultimo evento: ${dateIt(coder.last_activity_at)}</div>` : null}
			` : null}
		</div>
	`;
}
