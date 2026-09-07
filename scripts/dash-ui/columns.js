export const BUG_STATUSES = ["received", "processing", "awaiting_user_confirmation", "paused", "retry", "resolved", "failed", "cancelled"];
export const SUGGESTION_STATUSES = ["received", "processing", "awaiting_user_confirmation", "paused", "retry", "processed", "cancelled"];
export const ALL_STATUSES = ["received", "processing", "awaiting_user_confirmation", "paused", "retry", "resolved", "processed", "failed", "cancelled"];

export function columnsForType(type) {
	if (type === "bug") return BUG_STATUSES;
	if (type === "suggestion") return SUGGESTION_STATUSES;
	return ALL_STATUSES;
}

// "queued"/"pending_planner" are legacy resting statuses: createFeedback()
// lands new records there whenever no planner happens to be subscribed in
// the ~250ms notify window — essentially always. Both map onto the
// "received" column so a freshly filed record is never invisible.
export function canonicalStatus(status) {
	return status === "queued" || status === "pending_planner" ? "received" : status;
}

export function titleOf(item) {
	if (item.title) return item.title;
	const firstLine = String(item.message || "").split(/\n/).find(Boolean) || "";
	return firstLine.replace(/^#+\s*/, "").slice(0, 120) || item.id;
}

export function dateIt(value) {
	try {
		return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
	} catch {
		return value || "";
	}
}

export function screenshotSrc(item) {
	const shot = (item.screenshots || []).find((candidate) => candidate && !candidate.unavailable && (candidate.preview_url || candidate.data || candidate.url || (candidate.kind === "file" && candidate.name)));
	if (!shot) return null;
	let src = shot.preview_url || shot.data || shot.url || "";
	const markdown = String(src).match(/^!?\[[^\]]*\]\(([^)]+)\)$/);
	if (markdown) src = markdown[1];
	if (!src && shot.kind === "file" && shot.name) src = `/attachments/${encodeURIComponent(item.id)}/${encodeURIComponent(shot.name)}`;
	const visible = /^https?:/i.test(src) || src.startsWith("data:image/") || src.startsWith("/attachments/");
	return visible ? src : null;
}

export function typeIcon(type) {
	return type === "bug" ? "🪲" : "💡";
}
