// Fase 4 / M4 — playbook_* tool handlers, extracted verbatim from
// extensions/orchestrator.ts. Originally 8 of the 9 playbook_* handlers
// (bind/evidence_record/transition/evidence_list/effect_list/effect_ack/
// effect_claim/effect_fail); Fase 5/M5 completes "8 of 9" to "9 of 9" by
// adding `playbook_reconcile` here too, now that plan-gate.ts (Fase 5/M1)
// exists — it needs `readPlan`/`requireWorktree` from that cluster, both
// imported directly (pure functions; requireWorktree is already built once
// in orchestrator.ts via createRequireWorktree, passed as a direct
// reference). The other 8 only touch OrchestratorStorage's own playbook
// methods (already independent since Fase 2/M0) plus identity/
// loadPlaybook/path, so this remains zero real code coupling between them.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import { loadPlaybook } from "../playbook-loader.mjs";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";
import { readPlan } from "./plan-gate.ts";

export type PlaybookToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	ensureYanoStorage: () => OrchestratorStorage;
	requireWorktree: (slug: string) => { path: string; branch: string };
};

export function createPlaybookTools(deps: PlaybookToolsDeps) {
	const { getIdentity, ensureYanoStorage, requireWorktree } = deps;
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

		{
			name: "playbook_reconcile",
			label: "Reconcile Playbook",
			description: "Compare a bound Playbook with its structured plan and ticket DAG. Persists a deterministic diff and never invents or mutates work.",
			parameters: Type.Object({
				run_id: Type.String(),
				slug: Type.String(),
				idempotency_key: Type.String(),
				mappings: Type.Array(Type.Object({ state_id: Type.String(), phase: Type.Integer({ minimum: 1 }), ticket_ids: Type.Array(Type.String()) })),
			}),
			async execute(_callId: string, params: { run_id: string; slug: string; idempotency_key: string; mappings: Array<{ state_id: string; phase: number; ticket_ids: string[] }> }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("playbook_reconcile: only planner may reconcile a run.");
				if (!params.idempotency_key.trim()) throw new Error("playbook_reconcile: idempotency_key is required.");
				const storage = ensureYanoStorage();
				const binding = storage.getPlaybookBinding(params.run_id);
				if (!binding) throw new Error(`playbook_reconcile: run "${params.run_id}" has no bound Playbook.`);
				const plan = readPlan(requireWorktree(params.slug).path, params.slug);
				if (!plan) throw new Error(`playbook_reconcile: no structured plan for "${params.slug}".`);
				const states = (binding.snapshot as any)?.states ?? [];
				const stateIds = new Set(states.map((state: any) => state.id));
				const seenStates = new Set<string>();
				const seenTickets = new Set<string>();
				const diff: any[] = [];
				for (const mapping of params.mappings) {
					if (!stateIds.has(mapping.state_id)) diff.push({ kind: "unknown_state", state_id: mapping.state_id });
					if (seenStates.has(mapping.state_id)) diff.push({ kind: "duplicate_state", state_id: mapping.state_id });
					seenStates.add(mapping.state_id);
					if (!plan.phases.some((phase) => phase.phase === mapping.phase)) diff.push({ kind: "unknown_phase", state_id: mapping.state_id, phase: mapping.phase });
					for (const ticketId of mapping.ticket_ids) {
						if (seenTickets.has(ticketId)) diff.push({ kind: "duplicate_ticket", ticket_id: ticketId });
						seenTickets.add(ticketId);
						const ticket = storage.getTicket(ticketId);
						if (!ticket || ticket.run_id !== params.run_id) diff.push({ kind: "ticket_not_in_run", ticket_id: ticketId });
					}
				}
				for (const state of states) if (!seenStates.has(state.id)) diff.push({ kind: "unmapped_state", state_id: state.id });
				const tickets = storage.listTickets(params.run_id);
				for (const ticket of tickets) if (!seenTickets.has(ticket.id)) diff.push({ kind: "unmapped_ticket", ticket_id: ticket.id, status: ticket.status });
				const phaseByTicket = new Map<string, number>();
				for (const mapping of params.mappings) for (const ticketId of mapping.ticket_ids) phaseByTicket.set(ticketId, mapping.phase);
				for (const dependency of storage.listDependencies(params.run_id)) {
					const dependentPhase = phaseByTicket.get(dependency.ticket_id);
					const prerequisitePhase = phaseByTicket.get(dependency.depends_on_id);
					if (dependentPhase !== undefined && prerequisitePhase !== undefined && prerequisitePhase > dependentPhase) diff.push({ kind: "dependency_phase_inversion", ticket_id: dependency.ticket_id, depends_on_id: dependency.depends_on_id });
				}
				const outcome = diff.length ? "needs_replan" : "coherent";
				const payload = { outcome, run_id: params.run_id, slug: params.slug, playbook_checksum: binding.checksum, generation: storage.getPlaybookRuntimeState(params.run_id)?.generation ?? 0, idempotency_key: params.idempotency_key, diff };
				const prior = storage.listCheckpoints(params.run_id).find((checkpoint: any) => checkpoint.label === "playbook_reconciliation" && checkpoint.payload?.idempotency_key === params.idempotency_key);
				if (!prior) { storage.createCheckpoint(params.run_id, "playbook_reconciliation", payload); storage.recordEvent(params.run_id, "playbook_reconciliation", payload); }
				return { content: [{ type: "text" as const, text: `playbook_reconcile: ${outcome} (${diff.length} finding(s)).` }], details: { reconciliation: payload, idempotent: !!prior } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_reconcile ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.reconciliation?.outcome ?? "?"), 0, 0); },
		},
	];
}
