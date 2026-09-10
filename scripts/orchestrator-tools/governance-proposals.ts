// Fase 4 / M2 — governance_proposal_* tool handlers, extracted verbatim
// from extensions/orchestrator.ts. Zero cross-domain coupling — only
// touches OrchestratorStorage's own governance-proposal methods (already
// independent since Fase 2/M0) plus identity, injected as a getter (same
// pattern as scripts/orchestrator-tools/decision-holds.ts, Fase 4/M0).
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";

export type GovernanceProposalToolsDeps = {
	getIdentity: () => { role: string; cwd: string; project: string; instance: string } | null;
	ensureYanoStorage: () => OrchestratorStorage;
};

export function createGovernanceProposalTools(deps: GovernanceProposalToolsDeps) {
	const { getIdentity, ensureYanoStorage } = deps;
	return [
		{
			name: "governance_proposal_create",
			label: "Create Governance Proposal",
			description: "Create a sandboxed Playbook or role proposal with checksum and declared capabilities; never activates it.",
			parameters: Type.Object({ kind: Type.Union([Type.Literal("playbook"), Type.Literal("role")]), identifier: Type.String(), document: Type.String(), required_capabilities: Type.Optional(Type.Array(Type.String())) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || (identity.role !== "planner" && identity.role !== "playbook-author" && identity.role !== "role-definition")) throw new Error("governance_proposal_create: role is not authorised.");
				const proposal = ensureYanoStorage().createGovernanceProposal(params) as any;
				return { content: [{ type: "text" as const, text: `governance_proposal_create: ${proposal.kind}/${proposal.identifier} sandboxed.` }], details: { proposal: redactRuntimeProjection(proposal) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_create ")) + theme.fg("accent", (args as any).identifier ?? "?"), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ sandbox"), 0, 0); },
		},

		{
			name: "governance_proposal_validate",
			label: "Validate Governance Proposal",
			description: "Validate a sandboxed proposal before human approval.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("governance_proposal_validate: only planner may validate proposals.");
				const proposal = ensureYanoStorage().validateGovernanceProposal(params.id) as any;
				return { content: [{ type: "text" as const, text: `governance_proposal_validate: ${proposal.id} validated.` }], details: { proposal: redactRuntimeProjection(proposal) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_validate ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ validated"), 0, 0); },
		},

		{
			name: "governance_proposal_approve",
			label: "Approve Governance Proposal",
			description: "Approve a validated proposal as an immutable governance decision; approval does not mutate active runs.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || identity.role !== "user") throw new Error("governance_proposal_approve: explicit user approval is required.");
				const proposal = ensureYanoStorage().approveGovernanceProposal(params.id) as any;
				return { content: [{ type: "text" as const, text: `governance_proposal_approve: ${proposal.id} approved.` }], details: { proposal: redactRuntimeProjection(proposal) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_approve ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ approved"), 0, 0); },
		},

		{
			name: "governance_proposal_reject",
			label: "Reject Governance Proposal",
			description: "Reject a sandboxed or validated governance proposal with an explicit reason; no active run is changed.",
			parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), reason: Type.String() }),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity || (identity.role !== "planner" && identity.role !== "user")) throw new Error("governance_proposal_reject: role is not authorised.");
				const proposal = ensureYanoStorage().rejectGovernanceProposal(params.id, params.reason) as any;
				return { content: [{ type: "text" as const, text: `governance_proposal_reject: ${proposal.id} rejected.` }], details: { proposal: redactRuntimeProjection(proposal) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_reject ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
			renderResult(_result: unknown, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ rejected"), 0, 0); },
		},
	];
}
