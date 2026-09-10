// Fase 4 / M0 — shared redaction helper, extracted verbatim from
// extensions/orchestrator.ts. Zero closure dependencies (no
// identity/pi/ctx/mqttClient) — pure function of its own two constants,
// used by every one of the 65 tool handlers' `details` payload, so it is
// extracted once here rather than duplicated into each new
// scripts/orchestrator-tools/*.ts module.
const SENSITIVE_PROJECTION_KEY = /(?:secret|password|token|authorization|api[_-]?key|private[_-]?key)/i;
// These are numeric/context-catalog fields, not credentials. They must remain
// visible in forensic logs even though the generic redactor quite correctly
// treats the word "token" as sensitive elsewhere.
const SAFE_CONTEXT_PROJECTION_KEYS = new Set([
	"context_tokens",
	"effective_context_tokens",
	"estimated_context_tokens",
	"context_window_tokens",
	"context_tokens_source",
]);

export function redactRuntimeProjection(value: unknown, key?: string): unknown {
	if (key && SENSITIVE_PROJECTION_KEY.test(key) && !SAFE_CONTEXT_PROJECTION_KEYS.has(key)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map((item) => redactRuntimeProjection(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactRuntimeProjection(childValue, childKey)]));
	}
	return value;
}
