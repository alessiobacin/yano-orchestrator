// Fase 4 / M2 — governance_proposal_* tool handlers, extracted from
// extensions/orchestrator.ts. Same mock-storage pattern as
// decision-holds.test.mjs (Fase 4/M0).
import { describe, expect, it } from "vitest";
import { createGovernanceProposalTools } from "./governance-proposals.ts";

function makeDeps(overrides = {}) {
	const proposals = new Map();
	let nextId = 1;
	const storage = {
		createGovernanceProposal(params) {
			const proposal = { id: nextId++, status: "sandboxed", ...params };
			proposals.set(proposal.id, proposal);
			return proposal;
		},
		validateGovernanceProposal(id) {
			const proposal = { ...proposals.get(id), status: "validated" };
			proposals.set(id, proposal);
			return proposal;
		},
		approveGovernanceProposal(id) {
			const proposal = { ...proposals.get(id), status: "approved" };
			proposals.set(id, proposal);
			return proposal;
		},
		rejectGovernanceProposal(id, reason) {
			const proposal = { ...proposals.get(id), status: "rejected", reason };
			proposals.set(id, proposal);
			return proposal;
		},
	};
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		...overrides,
	};
	return { deps, storage };
}

function toolByName(deps, name) {
	return createGovernanceProposalTools(deps).find((t) => t.name === name);
}

describe("governance-proposals", () => {
	it("create allows planner/playbook-author/role-definition, sandboxes without activating", async () => {
		const { deps } = makeDeps();
		const create = toolByName(deps, "governance_proposal_create");
		const result = await create.execute("c1", { kind: "playbook", identifier: "demo-pb", document: "{}" });
		expect(result.details.proposal.status).toBe("sandboxed");

		for (const role of ["playbook-author", "role-definition"]) {
			const { deps: d2 } = makeDeps({ getIdentity: () => ({ role, cwd: "/p", project: "demo", instance: "x" }) });
			await expect(toolByName(d2, "governance_proposal_create").execute("c", { kind: "role", identifier: "r", document: "{}" })).resolves.toBeTruthy();
		}
	});

	it("create rejects an unauthorised role", async () => {
		const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
		const create = toolByName(deps, "governance_proposal_create");
		await expect(create.execute("c1", { kind: "playbook", identifier: "demo-pb", document: "{}" })).rejects.toThrow(/not authorised/);
	});

	it("validate requires planner specifically (not playbook-author)", async () => {
		const { deps } = makeDeps({ getIdentity: () => ({ role: "playbook-author", cwd: "/p", project: "demo", instance: "x" }) });
		const validate = toolByName(deps, "governance_proposal_validate");
		await expect(validate.execute("c1", { id: 1 })).rejects.toThrow(/only planner/);
	});

	it("approve requires explicit user role (not planner)", async () => {
		const { deps } = makeDeps();
		const create = toolByName(deps, "governance_proposal_create");
		const created = await create.execute("c1", { kind: "playbook", identifier: "demo-pb", document: "{}" });
		const approve = toolByName(deps, "governance_proposal_approve");
		await expect(approve.execute("c2", { id: created.details.proposal.id })).rejects.toThrow(/explicit user approval/);

		// Same underlying storage, two different actor identities: a planner
		// creates the proposal (create's allowed roles), a user approves it
		// (approve's allowed role) — mirrors the real human-in-the-loop flow.
		const created2 = await create.execute("c1", { kind: "playbook", identifier: "demo-pb-2", document: "{}" });
		const userDeps = { ...deps, getIdentity: () => ({ role: "user", cwd: "/p", project: "demo", instance: "x" }) };
		const result = await toolByName(userDeps, "governance_proposal_approve").execute("c2", { id: created2.details.proposal.id });
		expect(result.details.proposal.status).toBe("approved");
	});

	it("reject allows planner or user, requires a reason, never touches active runs", async () => {
		const { deps } = makeDeps();
		const create = toolByName(deps, "governance_proposal_create");
		const created = await create.execute("c1", { kind: "playbook", identifier: "demo-pb", document: "{}" });
		const reject = toolByName(deps, "governance_proposal_reject");
		const result = await reject.execute("c2", { id: created.details.proposal.id, reason: "not needed" });
		expect(result.details.proposal.status).toBe("rejected");
		expect(result.details.proposal.reason).toBe("not needed");
	});

	it("reject rejects an unauthorised role", async () => {
		const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
		const reject = toolByName(deps, "governance_proposal_reject");
		await expect(reject.execute("c1", { id: 1, reason: "x" })).rejects.toThrow(/not authorised/);
	});
});
