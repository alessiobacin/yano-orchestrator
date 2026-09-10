// Fase 4 / M1 — retention_policy_* tool handlers, extracted verbatim from
// extensions/orchestrator.ts. Zero cross-domain coupling — only touches
// OrchestratorStorage's own retention methods (already independent since
// Fase 2/M0) plus identity, injected as a getter (same pattern as
// scripts/orchestrator-tools/decision-holds.ts, Fase 4/M0).
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";

export type RetentionPolicyToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	ensureYanoStorage: () => OrchestratorStorage;
};

export function createRetentionPolicyTools(deps: RetentionPolicyToolsDeps) {
	const { getIdentity, ensureYanoStorage } = deps;
	return [
		{
			name: "retention_policy_set",
			label: "Set Retention Policy",
			description: "Persist a versioned, explicit retention policy for project storage. This tool never deletes data.",
			parameters: Type.Object({ project: Type.String(), event_days: Type.Integer({ minimum: 1 }), evidence_days: Type.Integer({ minimum: 1 }), outbox_days: Type.Integer({ minimum: 1 }), dead_letter_days: Type.Integer({ minimum: 1 }), policy_version: Type.Integer({ minimum: 1 }) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("retention_policy_set: only planner may set policy.");
				const policy = ensureYanoStorage().setRetentionPolicy(params);
				return { content: [{ type: "text" as const, text: `retention_policy_set: version ${policy.policy_version} for ${policy.project}.` }], details: { policy: redactRuntimeProjection(policy) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("retention_policy_set ")) + theme.fg("accent", (args as any).project ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String((result.details as any)?.policy?.policy_version ?? "?")), 0, 0); },
		},

		{
			name: "retention_policy_preview",
			label: "Preview Retention",
			description: "Preview retention candidates and counts without deleting audit, evidence or effect data.",
			parameters: Type.Object({ project: Type.String() }),
			async execute(_callId, params) {
				const preview = ensureYanoStorage().previewRetention(params.project);
				return { content: [{ type: "text" as const, text: `retention_policy_preview: ${JSON.stringify(preview.counts)}.` }], details: { preview: redactRuntimeProjection(preview) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("retention_policy_preview ")) + theme.fg("accent", (args as any).project ?? "?"), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ preview"), 0, 0); },
		},

		{
			name: "retention_policy_apply",
			label: "Apply Retention",
			description: "Delete only expired, non-active audit/evidence/outbox records after an explicit preview and confirmation. Pending outbox work and active-run events are never deleted.",
			parameters: Type.Object({ project: Type.String(), confirm: Type.Boolean({ description: "Must be true after reviewing retention_policy_preview for the same project." }) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("retention_policy_apply: only planner may apply retention.");
				if (!params.confirm) throw new Error("retention_policy_apply: confirm must be true after reviewing retention_policy_preview.");
				const result = ensureYanoStorage().applyRetention(params.project);
				return { content: [{ type: "text" as const, text: `retention_policy_apply: deleted ${JSON.stringify(result.deleted)} for ${params.project}.` }], details: { result: redactRuntimeProjection(result) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("retention_policy_apply ")) + theme.fg("accent", (args as any).project ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", JSON.stringify((result.details as any)?.result?.deleted ?? {})), 0, 0); },
		},
	];
}
