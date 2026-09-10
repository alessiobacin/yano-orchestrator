// Fase 4 / M4 — playbook_* tool handlers, extracted from
// extensions/orchestrator.ts. Same mock-storage pattern as
// decision-holds.test.mjs (Fase 4/M0), plus a vi.mock of
// playbook-loader.mjs's loadPlaybook for playbook_bind. Fase 5/M5 added
// the 9th handler, playbook_reconcile — it calls the real
// readPlan/requireWorktree from plan-gate.ts (not mocked, same reasoning
// as worktree.test.mjs/plan.test.mjs: these are the actual coupling being
// verified), so its own describe block below uses a real temp worktree
// directory instead of the plain mock storage identity used elsewhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const loadPlaybookMock = vi.fn();
vi.mock("../playbook-loader.mjs", () => ({ loadPlaybook: (...args) => loadPlaybookMock(...args) }));

const { createPlaybookTools } = await import("./playbooks.ts");
const { createRequireWorktree, writePlan } = await import("./plan-gate.ts");

function makeDeps(overrides = {}) {
	const storage = {
		bindPlaybook: vi.fn((runId, playbook) => ({ run_id: runId, playbook_id: playbook.id, schema_version: playbook.schema_version, origin: playbook.metadata.origin, checksum: playbook.metadata.checksum, snapshot: playbook.snapshot, created_at: "2026-01-01T00:00:00.000Z" })),
		recordEvent: vi.fn(),
		recordPlaybookEvidence: vi.fn((runId, input) => ({ created: true, run_id: runId, ...input })),
		transitionPlaybook: vi.fn((runId, input) => ({ run_id: runId, from: "draft", to: "active", transition_id: input.transition_id, generation: (input.expected_generation ?? 0) + 1, updated_at: "2026-01-01T00:00:00.000Z", effects: [] })),
		listPlaybookEvidence: vi.fn(() => [{ requirement: "run:objective_present" }]),
		listPlaybookEffects: vi.fn(() => [{ id: 1, status: "pending" }]),
		ackPlaybookEffect: vi.fn((id, input) => ({ id, status: "acknowledged", actor_role: input.actor_role })),
		claimPlaybookEffect: vi.fn((id, input) => ({ id, delivery_state: "leased", owner: input.owner })),
		failPlaybookEffect: vi.fn((id, input) => ({ id, delivery_state: "retrying", error: input.error })),
	};
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		requireWorktree: () => { throw new Error("requireWorktree not needed by this test"); },
		...overrides,
	};
	return { deps, storage };
}

function toolByName(deps, name) {
	return createPlaybookTools(deps).find((t) => t.name === name);
}

describe("playbooks", () => {
	beforeEach(() => {
		loadPlaybookMock.mockReset();
		loadPlaybookMock.mockReturnValue({ id: "demo-pb", schema_version: 1, metadata: { origin: "local", checksum: "abc123" }, snapshot: {} });
	});

	describe("playbook_bind", () => {
		it("loads, binds and records a playbook_bound event for a planner", async () => {
			const { deps, storage } = makeDeps();
			const tool = toolByName(deps, "playbook_bind");
			const result = await tool.execute("c1", { run_id: "run-1", source: "playbook.md" });
			expect(result.details.binding.playbook_id).toBe("demo-pb");
			expect(storage.recordEvent).toHaveBeenCalledWith("run-1", "playbook_bound", expect.objectContaining({ playbook_id: "demo-pb" }));
		});

		it("rejects a non-planner role without ever loading the playbook file", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			const tool = toolByName(deps, "playbook_bind");
			await expect(tool.execute("c1", { run_id: "run-1", source: "playbook.md" })).rejects.toThrow(/only the planner role/);
			expect(loadPlaybookMock).not.toHaveBeenCalled();
		});
	});

	describe("playbook_evidence_record", () => {
		it("records evidence and fires the event only when newly created", async () => {
			const { deps, storage } = makeDeps();
			const tool = toolByName(deps, "playbook_evidence_record");
			await tool.execute("c1", { run_id: "run-1", requirement: "run:objective_present", source: "run:objective_present", idempotency_key: "k1" });
			expect(storage.recordEvent).toHaveBeenCalledWith("run-1", "playbook_evidence_recorded", expect.objectContaining({ requirement: "run:objective_present" }));

			storage.recordPlaybookEvidence.mockReturnValueOnce({ created: false });
			storage.recordEvent.mockClear();
			await tool.execute("c2", { run_id: "run-1", requirement: "run:objective_present", source: "run:objective_present", idempotency_key: "k1" });
			expect(storage.recordEvent).not.toHaveBeenCalled();
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			const tool = toolByName(deps, "playbook_evidence_record");
			await expect(tool.execute("c1", { run_id: "run-1", requirement: "x", source: "y", idempotency_key: "k" })).rejects.toThrow(/only the planner role/);
		});
	});

	describe("playbook_transition", () => {
		it("allows a planner to act as actor 'planner' or 'runtime'", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "playbook_transition");
			const result = await tool.execute("c1", { run_id: "run-1", transition_id: "start", actor: "runtime" });
			expect(result.details.transition.to).toBe("active");
		});

		it("allows a team role to act as actor 'team' but not as 'planner'", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			const tool = toolByName(deps, "playbook_transition");
			await expect(tool.execute("c1", { run_id: "run-1", transition_id: "start", actor: "team" })).resolves.toBeTruthy();
			await expect(tool.execute("c2", { run_id: "run-1", transition_id: "start", actor: "planner" })).rejects.toThrow(/not authorised/);
		});

		it("rejects an actor claim the identity's role does not satisfy", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "reviewer", cwd: "/p", project: "demo", instance: "reviewer-01" }) });
			const tool = toolByName(deps, "playbook_transition");
			await expect(tool.execute("c1", { run_id: "run-1", transition_id: "start", actor: "coder_or_specialist" })).rejects.toThrow(/not authorised/);
		});
	});

	describe("playbook_evidence_list / playbook_effect_list", () => {
		it("list evidence and effects without requiring identity", async () => {
			const { deps } = makeDeps({ getIdentity: () => null });
			const evidence = await toolByName(deps, "playbook_evidence_list").execute("c1", { run_id: "run-1" });
			expect(evidence.details.evidence).toHaveLength(1);
			const effects = await toolByName(deps, "playbook_effect_list").execute("c2", { run_id: "run-1" });
			expect(effects.details.effects).toHaveLength(1);
		});
	});

	describe("playbook_effect_ack / claim / fail", () => {
		it("ack allows planner and effect-adapter, nobody else", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "playbook_effect_ack").execute("c1", { id: 1, generation: 0, idempotency_key: "k1" })).resolves.toBeTruthy();
			const { deps: adapterDeps } = makeDeps({ getIdentity: () => ({ role: "effect-adapter", cwd: "/p", project: "demo", instance: "x" }) });
			await expect(toolByName(adapterDeps, "playbook_effect_ack").execute("c2", { id: 1, generation: 0, idempotency_key: "k1" })).resolves.toBeTruthy();
			const { deps: coderDeps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "x" }) });
			await expect(toolByName(coderDeps, "playbook_effect_ack").execute("c3", { id: 1, generation: 0, idempotency_key: "k1" })).rejects.toThrow(/not authorised/);
		});

		it("claim requires effect-adapter specifically (planner is not enough)", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "playbook_effect_claim").execute("c1", { id: 1, owner: "o", token: "t", lease_until: "2026-01-01T00:10:00.000Z" })).rejects.toThrow(/only effect-adapter/);
			const { deps: adapterDeps } = makeDeps({ getIdentity: () => ({ role: "effect-adapter", cwd: "/p", project: "demo", instance: "x" }) });
			const result = await toolByName(adapterDeps, "playbook_effect_claim").execute("c2", { id: 1, owner: "o", token: "t", lease_until: "2026-01-01T00:10:00.000Z" });
			expect(result.details.effect.delivery_state).toBe("leased");
		});

		it("fail requires effect-adapter specifically", async () => {
			const { deps: adapterDeps } = makeDeps({ getIdentity: () => ({ role: "effect-adapter", cwd: "/p", project: "demo", instance: "x" }) });
			const result = await toolByName(adapterDeps, "playbook_effect_fail").execute("c1", { id: 1, owner: "o", token: "t", error: "timeout", max_attempts: 3 });
			expect(result.details.effect.delivery_state).toBe("retrying");
			const { deps } = makeDeps();
			await expect(toolByName(deps, "playbook_effect_fail").execute("c2", { id: 1, owner: "o", token: "t", error: "timeout", max_attempts: 3 })).rejects.toThrow(/only effect-adapter/);
		});
	});

	describe("playbook_reconcile", () => {
		let cwd;

		beforeEach(() => {
			cwd = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-reconcile-test-"));
			fs.mkdirSync(path.join(cwd, ".worktrees", "demo"), { recursive: true });
		});
		afterEach(() => {
			fs.rmSync(cwd, { recursive: true, force: true });
		});

		function makeReconcileDeps(overrides = {}) {
			const identity = { role: "planner", cwd, project: "demo", instance: "planner-01" };
			const { deps, storage } = makeDeps({
				getIdentity: () => identity,
				requireWorktree: createRequireWorktree({ getIdentity: () => identity }),
				...overrides,
			});
			Object.assign(storage, {
				getPlaybookBinding: vi.fn(() => ({ checksum: "abc123", snapshot: { states: [{ id: "s1" }] } })),
				getTicket: vi.fn((id) => (id === "t1" ? { id: "t1", run_id: "run-1" } : null)),
				listTickets: vi.fn(() => [{ id: "t1", status: "done" }]),
				listDependencies: vi.fn(() => []),
				getPlaybookRuntimeState: vi.fn(() => ({ generation: 2 })),
				listCheckpoints: vi.fn(() => []),
				createCheckpoint: vi.fn(),
			});
			return { deps, storage };
		}

		it("reports coherent and persists a checkpoint when the plan/ticket mapping lines up", async () => {
			const wtPath = path.join(cwd, ".worktrees", "demo");
			writePlan(wtPath, "demo", { slug: "demo", phases: [{ phase: 1, roles: ["coder"], status: "unlocked" }], created_at: "t0", updated_at: "t0" });
			const { deps, storage } = makeReconcileDeps();
			const result = await toolByName(deps, "playbook_reconcile").execute("c1", {
				run_id: "run-1",
				slug: "demo",
				idempotency_key: "k1",
				mappings: [{ state_id: "s1", phase: 1, ticket_ids: ["t1"] }],
			});
			expect(result.details.reconciliation.outcome).toBe("coherent");
			expect(storage.createCheckpoint).toHaveBeenCalledTimes(1);
		});

		it("reports needs_replan for an unknown state and an unmapped ticket", async () => {
			const wtPath = path.join(cwd, ".worktrees", "demo");
			writePlan(wtPath, "demo", { slug: "demo", phases: [{ phase: 1, roles: ["coder"], status: "unlocked" }], created_at: "t0", updated_at: "t0" });
			const { deps } = makeReconcileDeps();
			const result = await toolByName(deps, "playbook_reconcile").execute("c1", {
				run_id: "run-1",
				slug: "demo",
				idempotency_key: "k1",
				mappings: [{ state_id: "unknown-state", phase: 1, ticket_ids: [] }],
			});
			expect(result.details.reconciliation.outcome).toBe("needs_replan");
			const kinds = result.details.reconciliation.diff.map((d) => d.kind);
			expect(kinds).toContain("unknown_state");
			expect(kinds).toContain("unmapped_ticket");
		});

		it("throws when the run has no structured plan", async () => {
			const { deps } = makeReconcileDeps();
			await expect(
				toolByName(deps, "playbook_reconcile").execute("c1", { run_id: "run-1", slug: "demo", idempotency_key: "k1", mappings: [] }),
			).rejects.toThrow(/no structured plan/);
		});

		it("is idempotent: a repeated idempotency_key does not create a second checkpoint", async () => {
			const wtPath = path.join(cwd, ".worktrees", "demo");
			writePlan(wtPath, "demo", { slug: "demo", phases: [{ phase: 1, roles: ["coder"], status: "unlocked" }], created_at: "t0", updated_at: "t0" });
			const { deps, storage } = makeReconcileDeps();
			storage.listCheckpoints = vi.fn(() => [{ label: "playbook_reconciliation", payload: { idempotency_key: "k1" } }]);
			const result = await toolByName(deps, "playbook_reconcile").execute("c1", { run_id: "run-1", slug: "demo", idempotency_key: "k1", mappings: [] });
			expect(result.details.idempotent).toBe(true);
			expect(storage.createCheckpoint).not.toHaveBeenCalled();
		});

		it("rejects a non-planner caller", async () => {
			const { deps } = makeReconcileDeps({ getIdentity: () => ({ role: "coder", cwd, project: "demo", instance: "coder-01" }) });
			await expect(
				toolByName(deps, "playbook_reconcile").execute("c1", { run_id: "run-1", slug: "demo", idempotency_key: "k1", mappings: [] }),
			).rejects.toThrow(/only planner/);
		});
	});
});
