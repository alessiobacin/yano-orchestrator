// Fase 4 / M0 — decision_hold_* tool handlers, extracted from
// extensions/orchestrator.ts. Mocks OrchestratorStorage's decision-hold
// methods (same pattern as scripts/yano-orchestrator-storage.test.mjs,
// Fase 2/M0) plus sendNotifications/yanoPublishEvent/logEvent as plain
// spies, exercised through the createDecisionHoldTools(deps) factory.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionHoldTools } from "./decision-holds.ts";

function makeDeps(overrides = {}) {
	const holds = new Map();
	const events = [];
	const storage = {
		createDecisionHold(input) {
			const key = input.idempotency_key;
			for (const existing of holds.values()) {
				if (existing.idempotency_key === key) return { ...existing, created: false };
			}
			const hold = { id: `hold-${holds.size + 1}`, status: "open", generation: 0, created: true, ...input };
			holds.set(hold.id, hold);
			return hold;
		},
		getDecisionHold(id) { return holds.get(id) ?? null; },
		listDecisionHolds(runId, status) {
			return [...holds.values()].filter((h) => h.run_id === runId && (!status || h.status === status));
		},
		answerDecisionHold(id, params) {
			const hold = holds.get(id);
			const updated = { ...hold, status: "answered", generation: params.generation + 1 };
			holds.set(id, updated);
			return updated;
		},
		cancelDecisionHold(id, params) {
			const hold = holds.get(id);
			const updated = { ...hold, status: "cancelled", generation: params.generation + 1 };
			holds.set(id, updated);
			return updated;
		},
		escalateDecisionHold(id, params) {
			const hold = holds.get(id);
			const updated = { ...hold, escalated_to: params.escalated_to, escalation_version: (hold.escalation_version ?? 0) + 1, generation: params.generation + 1 };
			holds.set(id, updated);
			return updated;
		},
		recordEvent(runId, type, payload) { events.push({ runId, type, payload }); },
	};
	const deps = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01" }),
		ensureYanoStorage: () => storage,
		logEvent: vi.fn(),
		sendNotifications: vi.fn(async () => ({ ok: true, detail: "sent", channels: { whatsapp: { ok: true, detail: "sent" } } })),
		yanoPublishEvent: vi.fn(async () => {}),
		...overrides,
	};
	return { deps, storage, events, holds };
}

function toolByName(deps, name) {
	return createDecisionHoldTools(deps).find((t) => t.name === name);
}

describe("decision-holds", () => {
	describe("decision_hold_create", () => {
		it("creates a new hold and sends the waiting-for-reply notification exactly once", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "decision_hold_create");
			const result = await tool.execute("call-1", { run_id: "run-1", question: "q?", owner: "planner-01", idempotency_key: "k1" });
			expect(result.details.hold.status).toBe("open");
			expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
			expect(deps.sendNotifications.mock.calls[0][0]).toContain("demo");
			expect(deps.logEvent).toHaveBeenCalledWith("notification_dispatch", expect.objectContaining({ reason: "decision_hold_waiting_for_user" }));
		});

		it("does not re-notify on an idempotent retry (created: false)", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "decision_hold_create");
			await tool.execute("call-1", { run_id: "run-1", question: "q?", owner: "planner-01", idempotency_key: "k1" });
			deps.sendNotifications.mockClear();
			await tool.execute("call-2", { run_id: "run-1", question: "q?", owner: "planner-01", idempotency_key: "k1" });
			expect(deps.sendNotifications).not.toHaveBeenCalled();
		});

		it("rejects a non planner/user role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			const tool = toolByName(deps, "decision_hold_create");
			await expect(tool.execute("call-1", { run_id: "run-1", question: "q?", owner: "planner-01", idempotency_key: "k1" })).rejects.toThrow(/not authorised/);
		});

		it("throws when the orchestrator is not initialised", async () => {
			const { deps } = makeDeps({ getIdentity: () => null });
			const tool = toolByName(deps, "decision_hold_create");
			await expect(tool.execute("call-1", { run_id: "run-1", question: "q?", owner: "planner-01", idempotency_key: "k1" })).rejects.toThrow(/not initialised/);
		});
	});

	describe("decision_hold_get / decision_hold_list", () => {
		it("get throws for an unknown id", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "decision_hold_get");
			await expect(tool.execute("call-1", { id: "missing" })).rejects.toThrow(/no hold/);
		});

		it("list filters by run and status", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "decision_hold_create");
			await create.execute("c1", { run_id: "run-1", question: "a", owner: "o", idempotency_key: "k1" });
			await create.execute("c2", { run_id: "run-1", question: "b", owner: "o", idempotency_key: "k2" });
			const list = toolByName(deps, "decision_hold_list");
			const result = await list.execute("call-1", { run_id: "run-1" });
			expect(result.details.holds).toHaveLength(2);
			const filtered = await list.execute("call-2", { run_id: "run-1", status: "answered" });
			expect(filtered.details.holds).toHaveLength(0);
		});
	});

	describe("decision_hold_answer / cancel / escalate", () => {
		it("answer publishes an event and bumps generation", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "decision_hold_create");
			const created = await create.execute("c1", { run_id: "run-1", question: "a", owner: "o", idempotency_key: "k1" });
			const answer = toolByName(deps, "decision_hold_answer");
			const result = await answer.execute("call-1", { id: created.details.hold.id, generation: 0, answer: "yes", idempotency_key: "k-ans" });
			expect(result.details.hold.status).toBe("answered");
			expect(deps.yanoPublishEvent).toHaveBeenCalledWith("run-1", "decision_hold_answered", expect.objectContaining({ hold_id: created.details.hold.id }));
		});

		it("cancel publishes an event and marks cancelled", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "decision_hold_create");
			const created = await create.execute("c1", { run_id: "run-1", question: "a", owner: "o", idempotency_key: "k1" });
			const cancel = toolByName(deps, "decision_hold_cancel");
			const result = await cancel.execute("call-1", { id: created.details.hold.id, generation: 0, idempotency_key: "k-cxl" });
			expect(result.details.hold.status).toBe("cancelled");
			expect(deps.yanoPublishEvent).toHaveBeenCalledTimes(1);
		});

		it("escalate does NOT publish an MQTT event (only answer/cancel do)", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "decision_hold_create");
			const created = await create.execute("c1", { run_id: "run-1", question: "a", owner: "o", idempotency_key: "k1" });
			const escalate = toolByName(deps, "decision_hold_escalate");
			const result = await escalate.execute("call-1", { id: created.details.hold.id, generation: 0, escalated_to: "user", idempotency_key: "k-esc" });
			expect(result.details.hold.escalated_to).toBe("user");
			expect(deps.yanoPublishEvent).not.toHaveBeenCalled();
		});

		it("rejects non planner/user role for answer/cancel/escalate", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01" }) });
			await expect(toolByName(deps, "decision_hold_answer").execute("c", { id: "h1", generation: 0, answer: "x", idempotency_key: "k" })).rejects.toThrow(/not authorised/);
			await expect(toolByName(deps, "decision_hold_cancel").execute("c", { id: "h1", generation: 0, idempotency_key: "k" })).rejects.toThrow(/not authorised/);
			await expect(toolByName(deps, "decision_hold_escalate").execute("c", { id: "h1", generation: 0, escalated_to: "u", idempotency_key: "k" })).rejects.toThrow(/not authorised/);
		});
	});
});
