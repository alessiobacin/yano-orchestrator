// Fase 4 / M3 — capability_card_* tool handlers, extracted from
// extensions/orchestrator.ts. Same mock-storage pattern as
// decision-holds.test.mjs (Fase 4/M0).
import { describe, expect, it, vi } from "vitest";
import { createCapabilityCardTools } from "./capability-cards.ts";

function makeDeps(overrides = {}) {
	const cards = new Map();
	const events = [];
	const storage = {
		binding: { run_id: "run-1", playbook_id: "pb-1", schema_version: 1, origin: "yano", checksum: "abc123", snapshot: {}, created_at: "2026-01-01T00:00:00.000Z" },
		getPlaybookBinding: vi.fn(function (runId) { return runId === this.binding.run_id ? this.binding : null; }),
		recordPlaybookEvidence: vi.fn(() => ({ created: true })),
		upsertCapabilityCard: vi.fn((input) => {
			const key = `${input.run_id}:${input.role}:${input.instance}:${input.capability}`;
			cards.set(key, input);
			return input;
		}),
		listCapabilityCards: vi.fn((runId) => [...cards.values()].filter((c) => c.run_id === runId)),
		invalidateCapabilityCard: vi.fn((runId, role, instance, capability, reason) => {
			const key = `${runId}:${role}:${instance}:${capability}`;
			const card = { ...cards.get(key), status: "blocked", reason };
			cards.set(key, card);
			return card;
		}),
		recordEvent: vi.fn((runId, type, payload) => events.push({ runId, type, payload })),
	};
	storage.getPlaybookBinding = storage.getPlaybookBinding.bind(storage);
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		...overrides,
	};
	return { deps, storage, cards, events };
}

function toolByName(deps, name) {
	return createCapabilityCardTools(deps).find((t) => t.name === name);
}

describe("capability-cards", () => {
	describe("capability_card_verify", () => {
		it("verifies a capability against a bound playbook and records a verified card + event", async () => {
			const { deps, storage } = makeDeps();
			const tool = toolByName(deps, "capability_card_verify");
			const result = await tool.execute("c1", { run_id: "run-1", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" });
			expect(result.details.card.status).toBe("verified");
			expect(storage.recordEvent).toHaveBeenCalledWith("run-1", "capability_card_verified", expect.objectContaining({ capability: "shell_exec" }));
		});

		it("throws when the run has no bound playbook", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "capability_card_verify");
			await expect(tool.execute("c1", { run_id: "run-unbound", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" })).rejects.toThrow(/has no bound Playbook/);
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			const tool = toolByName(deps, "capability_card_verify");
			await expect(tool.execute("c1", { run_id: "run-1", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" })).rejects.toThrow(/only planner/);
		});

		it("records a failed card and re-throws when the probe itself throws", async () => {
			const { deps, storage } = makeDeps();
			storage.recordPlaybookEvidence.mockImplementation(() => { throw new Error("probe unreachable"); });
			const tool = toolByName(deps, "capability_card_verify");
			await expect(tool.execute("c1", { run_id: "run-1", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" })).rejects.toThrow(/probe unreachable/);
			expect(storage.upsertCapabilityCard).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", last_error: "probe unreachable" }));
			expect(storage.recordEvent).toHaveBeenCalledWith("run-1", "capability_card_failed", expect.objectContaining({ reason: "probe unreachable" }));
		});

		it("does not double-fire the verified event on an idempotent retry (evidence.created: false)", async () => {
			const { deps, storage } = makeDeps();
			storage.recordPlaybookEvidence.mockReturnValue({ created: false });
			const tool = toolByName(deps, "capability_card_verify");
			await tool.execute("c1", { run_id: "run-1", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" });
			expect(storage.recordEvent).not.toHaveBeenCalled();
		});
	});

	describe("capability_card_list", () => {
		it("lists cards for a run without requiring identity", async () => {
			const { deps } = makeDeps({ getIdentity: () => null });
			const verify = toolByName(deps, "capability_card_verify");
			// verify itself needs identity, so use a second deps object just for setup
			const { deps: writerDeps } = makeDeps({ ensureYanoStorage: deps.ensureYanoStorage });
			await toolByName(writerDeps, "capability_card_verify").execute("c1", { run_id: "run-1", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" });
			const list = toolByName(deps, "capability_card_list");
			const result = await list.execute("c2", { run_id: "run-1" });
			expect(result.details.cards).toHaveLength(1);
		});
	});

	describe("capability_card_invalidate", () => {
		it("blocks a card with a redacted operator-visible reason and records an event", async () => {
			const { deps, storage } = makeDeps();
			await toolByName(deps, "capability_card_verify").execute("c1", { run_id: "run-1", capability: "shell_exec", source: "probe.sh", requirement: "req-1", idempotency_key: "k1" });
			const invalidate = toolByName(deps, "capability_card_invalidate");
			const result = await invalidate.execute("c2", { run_id: "run-1", role: "planner", instance: "planner-01", capability: "shell_exec", reason: "rotated credentials" });
			expect(result.details.card.status).toBe("blocked");
			expect(storage.recordEvent).toHaveBeenCalledWith("run-1", "capability_card_invalidated", expect.objectContaining({ reason: "rotated credentials" }));
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			const invalidate = toolByName(deps, "capability_card_invalidate");
			await expect(invalidate.execute("c1", { run_id: "run-1", role: "planner", instance: "planner-01", capability: "shell_exec", reason: "x" })).rejects.toThrow(/only planner/);
		});
	});
});
