// Fase 4 / M1 — retention_policy_* tool handlers, extracted from
// extensions/orchestrator.ts. Same mock-storage pattern as
// decision-holds.test.mjs (Fase 4/M0).
import { describe, expect, it } from "vitest";
import { createRetentionPolicyTools } from "./retention-policy.ts";

function makeDeps(overrides = {}) {
	const storage = {
		setRetentionPolicy(params) { return { ...params }; },
		previewRetention(project) { return { project, counts: { events: 3, evidence: 1 } }; },
		applyRetention(project) { return { project, deleted: { events: 2, evidence: 1 } }; },
	};
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		...overrides,
	};
	return { deps, storage };
}

function toolByName(deps, name) {
	return createRetentionPolicyTools(deps).find((t) => t.name === name);
}

describe("retention-policy", () => {
	it("set persists a versioned policy for planner", async () => {
		const { deps } = makeDeps();
		const tool = toolByName(deps, "retention_policy_set");
		const result = await tool.execute("c1", { project: "demo", event_days: 30, evidence_days: 30, outbox_days: 7, dead_letter_days: 14, policy_version: 1 });
		expect(result.details.policy.policy_version).toBe(1);
	});

	it("set rejects a non-planner role", async () => {
		const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
		const tool = toolByName(deps, "retention_policy_set");
		await expect(tool.execute("c1", { project: "demo", event_days: 30, evidence_days: 30, outbox_days: 7, dead_letter_days: 14, policy_version: 1 })).rejects.toThrow(/only planner/);
	});

	it("preview never requires planner role and never deletes", async () => {
		const { deps } = makeDeps({ getIdentity: () => null });
		const tool = toolByName(deps, "retention_policy_preview");
		const result = await tool.execute("c1", { project: "demo" });
		expect(result.details.preview.counts).toEqual({ events: 3, evidence: 1 });
	});

	it("apply requires confirm=true even for a planner", async () => {
		const { deps } = makeDeps();
		const tool = toolByName(deps, "retention_policy_apply");
		await expect(tool.execute("c1", { project: "demo", confirm: false })).rejects.toThrow(/confirm must be true/);
	});

	it("apply requires planner role", async () => {
		const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
		const tool = toolByName(deps, "retention_policy_apply");
		await expect(tool.execute("c1", { project: "demo", confirm: true })).rejects.toThrow(/only planner/);
	});

	it("apply deletes only when planner-confirmed", async () => {
		const { deps } = makeDeps();
		const tool = toolByName(deps, "retention_policy_apply");
		const result = await tool.execute("c1", { project: "demo", confirm: true });
		expect(result.details.result.deleted).toEqual({ events: 2, evidence: 1 });
	});
});
