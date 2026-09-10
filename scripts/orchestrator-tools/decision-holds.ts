// Fase 4 / M0 — decision_hold_* tool handlers, extracted verbatim from
// extensions/orchestrator.ts per the audit's "tools/{worktree,plan,ticket}"
// recommendation (the fifth region of point 4, section 8, left out of
// Fase 2's storage/watchdog/notifications/terminal-integration split).
//
// Zero real cross-domain code coupling: only touches OrchestratorStorage's
// own decision-hold methods (already independent since Fase 2/M0) plus
// identity/logEvent/sendNotifications/yanoPublishEvent, injected as `deps`.
// `identity` is a `let` reassigned by orchestrator_init in orchestrator.ts,
// so it is closed over via a getter — same pattern as
// scripts/watcher/watchdog-sweep.ts's WatchdogSweepDeps — while
// ensureYanoStorage/logEvent/sendNotifications/yanoPublishEvent are passed
// as direct function references: each of those already closes over
// identity/client/T internally at its own definition site in
// orchestrator.ts, so no extra wrapping is needed for them.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OrchestratorStorage, DecisionHoldStatus } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";

export type DecisionHoldToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	ensureYanoStorage: () => OrchestratorStorage;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	sendNotifications: (message: string) => Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }>;
	yanoPublishEvent: (runId: string, type: string, payload: unknown) => Promise<void>;
};

export function createDecisionHoldTools(deps: DecisionHoldToolsDeps) {
	const { getIdentity, ensureYanoStorage, logEvent, sendNotifications, yanoPublishEvent } = deps;
	return [
		{
			name: "decision_hold_create",
			label: "Create Decision Hold",
			description: "Create or retrieve an idempotent human decision hold. Only planner/user authority may create holds; execution remains paused until answer, cancel, or expiry.",
			parameters: Type.Object({
				run_id: Type.String(), ticket_id: Type.Optional(Type.String()), generation: Type.Optional(Type.Integer({ minimum: 0 })),
				question: Type.String(), context: Type.Optional(Type.Unknown()), owner: Type.String(),
				expires_at: Type.Optional(Type.String()), idempotency_key: Type.String(),
			}),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_create: role "${identity.role}" is not authorised.`);
				const storage = ensureYanoStorage();
				const hold = storage.createDecisionHold({ ...params, ticket_id: params.ticket_id ?? null, context: params.context ?? {}, idempotency_key: params.idempotency_key });
				storage.recordEvent(hold.run_id, "decision_hold_created", { hold_id: hold.id, generation: hold.generation, owner: hold.owner, expires_at: hold.expires_at }, hold.ticket_id);
				// Exactly one "I'm waiting for your reply" notification per hold, ever
				// — gated on storage-level `created` (true only the one time this
				// call actually inserted a new row), never on anything the calling
				// agent could retry into firing twice. Silent (never throws) if no
				// channel is configured, same contract as every other notification
				// path in this file.
				if (hold.created) {
					const notifyText = `❓ Il progetto "${identity.project}" ha una domanda in attesa di risposta: "${hold.question}" (hold ${hold.id}). Non serve fare nulla finché non rispondi — nessun altro processo interverrà su questo hold.`;
					const notifyResult = await sendNotifications(notifyText);
					logEvent("notification_dispatch", { hold_id: hold.id, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels, reason: "decision_hold_waiting_for_user" });
				}
				return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: ${hold.status} (generation ${hold.generation})` }], details: { hold: redactRuntimeProjection(hold) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_create ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.hold?.status ?? "?"), 0, 0); },
		},

		{
			name: "decision_hold_get",
			label: "Get Decision Hold",
			description: "Read one persisted decision hold by id.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_callId, params) {
				const hold = ensureYanoStorage().getDecisionHold(params.id);
				if (!hold) throw new Error(`decision_hold_get: no hold "${params.id}".`);
				return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: ${hold.status}` }], details: { hold: redactRuntimeProjection(hold) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_get ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.hold?.status ?? "?"), 0, 0); },
		},

		{
			name: "decision_hold_list",
			label: "List Decision Holds",
			description: "List persisted decision holds for a run, optionally filtered by status.",
			parameters: Type.Object({ run_id: Type.String(), status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("expired"), Type.Literal("cancelled"), Type.Literal("blocked")])) }),
			async execute(_callId, params) {
				const holds = ensureYanoStorage().listDecisionHolds(params.run_id, params.status as DecisionHoldStatus | undefined).map((hold) => redactRuntimeProjection(hold));
				return { content: [{ type: "text" as const, text: `${holds.length} decision hold(s) for run ${params.run_id}.` }], details: { holds } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.holds ?? []).length)), 0, 0); },
		},

		{
			name: "decision_hold_answer",
			label: "Answer Decision Hold",
			description: "Answer an open decision hold with generation fencing and retry-safe idempotency.",
			parameters: Type.Object({ id: Type.String(), generation: Type.Integer({ minimum: 0 }), answer: Type.String(), idempotency_key: Type.String(), resolution_metadata: Type.Optional(Type.Unknown()), expected_checksum: Type.Optional(Type.String()), principal: Type.Optional(Type.String()) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_answer: role "${identity.role}" is not authorised.`);
				const storage = ensureYanoStorage();
				const hold = storage.answerDecisionHold(params.id, params);
				storage.recordEvent(hold.run_id, "decision_hold_answered", { hold_id: hold.id, generation: hold.generation, idempotency_key: params.idempotency_key }, hold.ticket_id);
				await yanoPublishEvent(hold.run_id, "decision_hold_answered", { hold_id: hold.id, generation: hold.generation });
				return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: answered` }], details: { hold: redactRuntimeProjection(hold) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_answer ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ answered"), 0, 0); },
		},

		{
			name: "decision_hold_cancel",
			label: "Cancel Decision Hold",
			description: "Cancel an open decision hold with generation fencing and retry-safe idempotency.",
			parameters: Type.Object({ id: Type.String(), generation: Type.Integer({ minimum: 0 }), reason: Type.Optional(Type.String()), idempotency_key: Type.String(), expected_checksum: Type.Optional(Type.String()), principal: Type.Optional(Type.String()) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_cancel: role "${identity.role}" is not authorised.`);
				const storage = ensureYanoStorage();
				const hold = storage.cancelDecisionHold(params.id, params);
				storage.recordEvent(hold.run_id, "decision_hold_cancelled", { hold_id: hold.id, generation: hold.generation, idempotency_key: params.idempotency_key, reason_provided: Boolean(params.reason) }, hold.ticket_id);
				await yanoPublishEvent(hold.run_id, "decision_hold_cancelled", { hold_id: hold.id, generation: hold.generation });
				return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: cancelled` }], details: { hold: redactRuntimeProjection(hold) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_cancel ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ cancelled"), 0, 0); },
		},

		{
			name: "decision_hold_escalate",
			label: "Escalate Decision Hold",
			description: "Escalate an open decision hold to another principal with generation and idempotency fencing.",
			parameters: Type.Object({ id: Type.String(), generation: Type.Integer({ minimum: 0 }), escalated_to: Type.String(), idempotency_key: Type.String(), expected_checksum: Type.Optional(Type.String()) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_escalate: role "${identity.role}" is not authorised.`);
				const hold = ensureYanoStorage().escalateDecisionHold(params.id, params);
				ensureYanoStorage().recordEvent(hold.run_id, "decision_hold_escalated", { hold_id: hold.id, generation: hold.generation, escalated_to: hold.escalated_to, escalation_version: hold.escalation_version }, hold.ticket_id);
				return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: escalated to ${hold.escalated_to}` }], details: { hold: redactRuntimeProjection(hold) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_escalate ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.hold?.escalated_to ?? "?"), 0, 0); },
		},
	];
}
