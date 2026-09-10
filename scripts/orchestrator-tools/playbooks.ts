// Fase 4 / M4 — playbook_* tool handlers, extracted verbatim from
// extensions/orchestrator.ts. 8 of the 9 playbook_* handlers: `bind`,
// `evidence_record`, `transition`, `evidence_list`, `effect_list`,
// `effect_ack`, `effect_claim`, `effect_fail`. `playbook_reconcile` stays
// in orchestrator.ts — unlike its 8 siblings, it calls `readPlan`/
// `requireWorktree` from the "plan-gate" helper cluster that is still
// inline there (not yet extracted, out of scope for this phase — see the
// Fase 4 plan's "Fuori scope" section). All 8 here only touch
// OrchestratorStorage's own playbook methods (already independent since
// Fase 2/M0) plus identity/loadPlaybook/path, so this is zero real code
// coupling, same as the other Fase 4 milestones.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import { loadPlaybook } from "../playbook-loader.mjs";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";

export type PlaybookToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	ensureYanoStorage: () => OrchestratorStorage;
};

export function createPlaybookTools(deps: PlaybookToolsDeps) {
	const { getIdentity, ensureYanoStorage } = deps;
	return [
		{
			name: "playbook_bind",
			label: "Bind Playbook",
			description: "Load, validate and immutably bind a versioned Playbook to a run. Planner-only; the runtime persists origin, checksum and snapshot in SQLite.",
			parameters: Type.Object({ run_id: Type.String(), source: Type.String(), expected_checksum: Type.Optional(Type.String()) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") throw new Error(`playbook_bind: only the planner role may bind a Playbook (this instance is "${identity.role}").`);
				const storage = ensureYanoStorage();
				const playbook = loadPlaybook(path.resolve(identity.cwd, params.source), { expectedChecksum: params.expected_checksum });
				const binding = storage.bindPlaybook(params.run_id, { id: playbook.id, schema_version: playbook.schema_version, metadata: playbook.metadata, snapshot: playbook });
				storage.recordEvent(params.run_id, "playbook_bound", { playbook_id: binding.playbook_id, checksum: binding.checksum, origin: binding.origin });
				return { content: [{ type: "text" as const, text: `playbook_bind: "${binding.playbook_id}" bound to run ${binding.run_id} (${binding.checksum.slice(0, 12)}…).` }], details: { binding: redactRuntimeProjection(binding) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_bind ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.binding?.playbook_id ?? "?"), 0, 0); },
		},

		{
			name: "playbook_evidence_record",
			label: "Record Playbook Evidence",
			description: "Persist idempotent evidence for a declared Playbook guard. Supported verified sources are run:objective_present, ticket:<id>:done, hold:<id>:answered, capability:cli:<name>:available, capability:mcp:<name>:handshake, capability:credential:<name>:present and capability:skill:<name>:loadable; transitions never consume a caller-supplied assertion list.",
			parameters: Type.Object({ run_id: Type.String(), requirement: Type.String(), source: Type.String(), idempotency_key: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") throw new Error(`playbook_evidence_record: only the planner role may record Playbook evidence (this instance is "${identity.role}").`);
				const storage = ensureYanoStorage();
				const evidence = storage.recordPlaybookEvidence(params.run_id, { ...params, cwd: identity.cwd });
				if ((evidence as any).created) storage.recordEvent(params.run_id, "playbook_evidence_recorded", { requirement: params.requirement, source: params.source, idempotency_key: params.idempotency_key });
				return { content: [{ type: "text" as const, text: `playbook_evidence_record: evidence recorded for run ${params.run_id}.` }], details: { evidence: redactRuntimeProjection(evidence) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_evidence_record ")) + theme.fg("accent", (args as any).requirement ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.evidence?.requirement ?? "recorded"), 0, 0); },
		},

		{
			name: "playbook_transition",
			label: "Playbook Transition",
			description: "Apply one declared Playbook transition with identity-bound actor, persisted-evidence guard and generation enforcement. The state update and audit event are atomic.",
			parameters: Type.Object({ run_id: Type.String(), transition_id: Type.String(), actor: Type.String(), expected_generation: Type.Optional(Type.Integer({ minimum: 0 })) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const role = identity.role.trim().toLowerCase();
				const actor = params.actor.trim().toLowerCase();
				const teamRole = role !== "planner" && role !== "user";
				const actorAllowed = actor === "planner" || actor === "runtime"
					? role === "planner"
					: actor === "human"
						? role === "user"
						: actor === "team"
							? teamRole
							: actor === "planner_or_reviewer"
								? role === "planner" || role === "reviewer"
								: actor === "planner_and_team"
									? role === "planner" || teamRole
									: actor === "coder_or_specialist"
										? role === "coder" || role === "frontend-developer" || (teamRole && role !== "reviewer")
										: actor === role;
				if (!actorAllowed) throw new Error(`playbook_transition: actor "${params.actor}" is not authorised for runtime role "${identity.role}".`);
				const result = ensureYanoStorage().transitionPlaybook(params.run_id, params);
				return { content: [{ type: "text" as const, text: `playbook_transition: ${result.from} → ${result.to} (${result.transition_id}, generation ${result.generation}).` }], details: { transition: redactRuntimeProjection(result) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_transition ")) + theme.fg("accent", (args as any).transition_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.transition?.to ?? "?"), 0, 0); },
		},

		{
			name: "playbook_evidence_list",
			label: "List Playbook Evidence",
			description: "Read persisted Playbook guard evidence for a run.",
			parameters: Type.Object({ run_id: Type.String() }),
			async execute(_callId, params) {
				const evidence = ensureYanoStorage().listPlaybookEvidence(params.run_id).map((item) => redactRuntimeProjection(item));
				return { content: [{ type: "text" as const, text: `${evidence.length} Playbook evidence record(s) for run ${params.run_id}.` }], details: { evidence } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_evidence_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.evidence ?? []).length)), 0, 0); },
		},

		{
			name: "playbook_effect_list",
			label: "List Playbook Effects",
			description: "Read the explicit Playbook effect outbox for a run. This tool never executes an external effect.",
			parameters: Type.Object({ run_id: Type.String(), status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("dispatched")])) }),
			async execute(_callId, params) {
				const effects = ensureYanoStorage().listPlaybookEffects(params.run_id, params.status).map((effect) => redactRuntimeProjection(effect));
				return { content: [{ type: "text" as const, text: `${effects.length} Playbook effect(s) for run ${params.run_id}.` }], details: { effects } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.effects ?? []).length)), 0, 0); },
		},

		{
			name: "playbook_effect_ack",
			label: "Acknowledge Playbook Effect",
			description: "Acknowledge one pending Playbook effect after an authorized adapter delivered it. Planner may acknowledge audit/approval effects; external notification/MQTT effects require the effect-adapter role. Idempotent and generation-fenced; never executes arbitrary commands.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), generation: Type.Integer({ minimum: 0 }), idempotency_key: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner" && identity.role !== "effect-adapter") throw new Error(`playbook_effect_ack: role "${identity.role}" is not authorised.`);
				const effect = ensureYanoStorage().ackPlaybookEffect(params.id, { ...params, actor_role: identity.role });
				return { content: [{ type: "text" as const, text: `playbook_effect_ack: effect ${effect.id} is ${effect.status}.` }], details: { effect: redactRuntimeProjection(effect) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_ack ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.effect?.status ?? "?"), 0, 0); },
		},

		{
			name: "playbook_effect_claim",
			label: "Claim Playbook Effect",
			description: "Acquire a durable, fenced lease for an external Playbook effect. Only effect-adapter may claim delivery work.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), owner: Type.String(), token: Type.String(), lease_until: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "effect-adapter") throw new Error("playbook_effect_claim: only effect-adapter may claim effects.");
				const effect = ensureYanoStorage().claimPlaybookEffect(params.id, params);
				return { content: [{ type: "text" as const, text: `playbook_effect_claim: effect ${effect.id} leased.` }], details: { effect: redactRuntimeProjection(effect) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_claim ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.effect?.delivery_state ?? "?"), 0, 0); },
		},

		{
			name: "playbook_effect_fail",
			label: "Fail Playbook Effect",
			description: "Record a fenced external effect failure and move it to bounded retry or dead-letter.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), owner: Type.String(), token: Type.String(), error: Type.String(), max_attempts: Type.Integer({ minimum: 1 }), next_attempt_at: Type.Optional(Type.String()) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "effect-adapter") throw new Error("playbook_effect_fail: only effect-adapter may fail effects.");
				const effect = ensureYanoStorage().failPlaybookEffect(params.id, params);
				return { content: [{ type: "text" as const, text: `playbook_effect_fail: effect ${effect.id} is ${effect.delivery_state}.` }], details: { effect: redactRuntimeProjection(effect) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_fail ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.effect?.delivery_state ?? "?"), 0, 0); },
		},
	];
}
