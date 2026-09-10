// Fase 4 / M3 — capability_card_* tool handlers, extracted verbatim from
// extensions/orchestrator.ts. `capability_card_verify` calls
// storage.getPlaybookBinding()/recordPlaybookEvidence() — public methods
// of the already-shared OrchestratorStorage class, not local functions
// from the (not-yet-extracted) playbook_* tool handlers, so this is zero
// real code coupling, same as scripts/orchestrator-tools/decision-holds.ts
// (Fase 4/M0). `nowIso()` is duplicated locally (trivial one-liner, 32
// call sites across orchestrator.ts, most outside this domain — not worth
// centralizing, same call as decision-holds.ts's redactRuntimeProjection
// vs. this).
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";

function nowIso(): string {
	return new Date().toISOString();
}

export type CapabilityCardToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	ensureYanoStorage: () => OrchestratorStorage;
};

export function createCapabilityCardTools(deps: CapabilityCardToolsDeps) {
	const { getIdentity, ensureYanoStorage } = deps;
	return [
		{
			name: "capability_card_verify",
			label: "Verify Capability Card",
			description: "Run a bounded, redacted capability probe and persist its verified card for this run, role and instance.",
			parameters: Type.Object({ run_id: Type.String(), capability: Type.String(), source: Type.String(), requirement: Type.String(), idempotency_key: Type.String(), scope: Type.Optional(Type.String()), expires_at: Type.Optional(Type.String()) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("capability_card_verify: only planner may verify run capability cards.");
				const storage = ensureYanoStorage();
				const binding = storage.getPlaybookBinding(params.run_id);
				if (!binding) throw new Error(`capability_card_verify: run "${params.run_id}" has no bound Playbook.`);
				const scope = params.scope ?? `project:${identity.project}:run:${params.run_id}`;
				const fingerprint = crypto.createHash("sha256").update(`${params.source}|${scope}|${identity.cwd}|${process.version}|${binding.checksum}`).digest("hex");
				try {
					const evidence = storage.recordPlaybookEvidence(params.run_id, { requirement: params.requirement, source: params.source, idempotency_key: params.idempotency_key, cwd: identity.cwd }) as any;
					const card = storage.upsertCapabilityCard({ run_id: params.run_id, role: identity.role, instance: identity.instance, capability: params.capability, source: params.source, scope, fingerprint, playbook_checksum: binding.checksum, status: "verified", verified_at: nowIso(), expires_at: params.expires_at ?? null });
					if (evidence.created) storage.recordEvent(params.run_id, "capability_card_verified", { capability: params.capability, role: identity.role, instance: identity.instance, scope, fingerprint });
					return { content: [{ type: "text" as const, text: `capability_card_verify: ${params.capability} verified for ${identity.role}/${identity.instance}.` }], details: { card: redactRuntimeProjection(card) } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const card = storage.upsertCapabilityCard({ run_id: params.run_id, role: identity.role, instance: identity.instance, capability: params.capability, source: params.source, scope, fingerprint, playbook_checksum: binding.checksum, status: "failed", last_error: message });
					storage.recordEvent(params.run_id, "capability_card_failed", { capability: params.capability, role: identity.role, instance: identity.instance, scope, reason: message });
					throw error;
				}
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("capability_card_verify ")) + theme.fg("accent", (args as any).capability ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.card?.status ?? "?"), 0, 0); },
		},

		{
			name: "capability_card_list",
			label: "List Capability Cards",
			description: "Read redacted capability cards persisted for a run.",
			parameters: Type.Object({ run_id: Type.String() }),
			async execute(_callId, params) {
				const cards = ensureYanoStorage().listCapabilityCards(params.run_id).map((card) => redactRuntimeProjection(card));
				return { content: [{ type: "text" as const, text: `${cards.length} capability card(s) for run ${params.run_id}.` }], details: { cards } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("capability_card_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.cards ?? []).length)), 0, 0); },
		},

		{
			name: "capability_card_invalidate",
			label: "Invalidate Capability Card",
			description: "Mark a persisted capability card blocked with a redacted operator-visible reason.",
			parameters: Type.Object({ run_id: Type.String(), role: Type.String(), instance: Type.String(), capability: Type.String(), reason: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("capability_card_invalidate: only planner may invalidate cards.");
				const card = ensureYanoStorage().invalidateCapabilityCard(params.run_id, params.role, params.instance, params.capability, params.reason);
				ensureYanoStorage().recordEvent(params.run_id, "capability_card_invalidated", { role: params.role, instance: params.instance, capability: params.capability, reason: params.reason });
				return { content: [{ type: "text" as const, text: `capability_card_invalidate: ${params.capability} is blocked.` }], details: { card: redactRuntimeProjection(card) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("capability_card_invalidate ")) + theme.fg("accent", (args as any).capability ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.card?.status ?? "?"), 0, 0); },
		},
	];
}
