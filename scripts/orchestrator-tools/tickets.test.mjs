// Fase 4 / M5 — ticket_* tool handlers, extracted from
// extensions/orchestrator.ts. In-memory fake storage (runs/tickets/deps),
// same style as decision-holds.test.mjs (Fase 4/M0), plus mocked
// activeTicketIds/publishPresence/computeSelfStatus (Revisione 40 presence
// wiring) and yano-model-advisor.mjs's recommend() for ticket_requeue's
// escalation path.
import { beforeEach, describe, expect, it, vi } from "vitest";

const recommendMock = vi.fn();
vi.mock("../yano-model-advisor.mjs", () => ({ recommend: (...args) => recommendMock(...args) }));

const { createTicketTools } = await import("./tickets.ts");

function makeDeps(overrides = {}) {
	const runs = new Map();
	const tickets = new Map();
	const deps = []; // { ticket_id, depends_on_id }
	const events = [];
	let nextTicketId = 1;

	const storage = {
		getRun: vi.fn((id) => runs.get(id) ?? null),
		updateRunStatus: vi.fn((id, status) => { const r = runs.get(id); if (r) r.status = status; }),
		getSpec: vi.fn(() => null),
		getPlaybookBinding: vi.fn(() => null),
		createTicket: vi.fn((input) => {
			const ticket = { id: `t${nextTicketId++}`, status: "pending", ...input, required_capabilities: input.required_capabilities ?? [] };
			tickets.set(ticket.id, ticket);
			return ticket;
		}),
		getTicket: vi.fn((id) => tickets.get(id) ?? null),
		listTickets: vi.fn((runId) => [...tickets.values()].filter((t) => t.run_id === runId)),
		addDependency: vi.fn((ticketId, dependsOnId) => deps.push({ ticket_id: ticketId, depends_on_id: dependsOnId })),
		listDependencies: vi.fn((runId) => deps.filter((d) => tickets.get(d.ticket_id)?.run_id === runId)),
		updateTicketStatus: vi.fn((id, status, extra = {}) => {
			const ticket = tickets.get(id);
			const updated = { ...ticket, status, ...extra };
			tickets.set(id, updated);
			return updated;
		}),
		recordEvent: vi.fn((runId, type, payload) => events.push({ runId, type, payload })),
		requeueTicketForRecovery: vi.fn((id, input) => ({ recovery: { recovery_generation: 1, retry_count: 1, max_retries: input.max_retries }, escalation: { active: false } })),
		getTicketRecovery: vi.fn(() => ({ retry_count: 1, max_retries: 3, status: "pending" })),
	};

	runs.set("run-1", { id: "run-1", domain: "backend", status: "active" });

	const activeTicketIds = new Set();
	const dep = {
		getIdentity: () => ({ role: "planner", cwd: "/p", project: "demo", instance: "planner-01", playbook: null, skills: [] }),
		ensureYanoStorage: () => storage,
		logEvent: vi.fn(),
		yanoPublishEvent: vi.fn(async () => {}),
		sendNotifications: vi.fn(async () => ({ ok: true, detail: "sent", channels: {} })),
		activeTicketIds,
		publishPresence: vi.fn(async () => {}),
		computeSelfStatus: vi.fn(() => "busy"),
		...overrides,
	};
	return { deps: dep, storage, runs, tickets, depsList: deps, events };
}

function toolByName(deps, name) {
	return createTicketTools(deps).find((t) => t.name === name);
}

describe("tickets", () => {
	beforeEach(() => { recommendMock.mockReset(); });

	describe("ticket_create", () => {
		it("creates a ticket with no dependencies, marking it immediately ready", async () => {
			const { deps, storage } = makeDeps();
			const tool = toolByName(deps, "ticket_create");
			const result = await tool.execute("c1", { run_id: "run-1", title: "Do the thing" });
			expect(result.details.ticket.status).toBe("pending");
			expect(storage.recordEvent).toHaveBeenCalledWith("run-1", "ticket_ready", expect.objectContaining({ ticket_id: result.details.ticket.id }), result.details.ticket.id);
		});

		it("rejects an invalid depends_on and leaves no ticket row behind", async () => {
			const { deps, tickets } = makeDeps();
			const tool = toolByName(deps, "ticket_create");
			await expect(tool.execute("c1", { run_id: "run-1", title: "X", depends_on: ["missing-ticket"] })).rejects.toThrow(/depends_on references/);
			expect(tickets.size).toBe(0);
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) });
			const tool = toolByName(deps, "ticket_create");
			await expect(tool.execute("c1", { run_id: "run-1", title: "X" })).rejects.toThrow(/only the planner role/);
		});

		it("throws when the run does not exist", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "ticket_create");
			await expect(tool.execute("c1", { run_id: "no-such-run", title: "X" })).rejects.toThrow(/call run_create first/);
		});
	});

	describe("tickets_ready", () => {
		it("computes ready/blocked buckets and execution waves", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "ticket_create");
			const a = await create.execute("c1", { run_id: "run-1", title: "A" });
			await create.execute("c2", { run_id: "run-1", title: "B", depends_on: [a.details.ticket.id] });
			const tool = toolByName(deps, "tickets_ready");
			const result = await tool.execute("c3", { run_id: "run-1" });
			expect(result.details.ready).toEqual([a.details.ticket.id]);
			expect(result.details.blocked).toHaveLength(1);
		});
	});

	describe("ticket_claim", () => {
		it("planner is structurally excluded from claiming (Revisione 42)", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "ticket_create");
			const created = await create.execute("c1", { run_id: "run-1", title: "A" });
			const claim = toolByName(deps, "ticket_claim");
			await expect(claim.execute("c2", { ticket_id: created.details.ticket.id })).rejects.toThrow(/planner role may never claim/);
		});

		it("a coder claims a ready ticket and presence is republished immediately", async () => {
			const { deps } = makeDeps();
			const created = await toolByName(deps, "ticket_create").execute("c1", { run_id: "run-1", title: "A" });
			const coderDeps = { ...deps, getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) };
			const claim = toolByName(coderDeps, "ticket_claim");
			const result = await claim.execute("c2", { ticket_id: created.details.ticket.id });
			expect(result.details.ticket.status).toBe("running");
			expect(deps.activeTicketIds.has(created.details.ticket.id)).toBe(true);
			expect(deps.publishPresence).toHaveBeenCalledWith("busy");
		});

		it("rejects a ticket that is not READY (blocked on dependencies)", async () => {
			const { deps } = makeDeps();
			const create = toolByName(deps, "ticket_create");
			const a = await create.execute("c1", { run_id: "run-1", title: "A" });
			const b = await create.execute("c2", { run_id: "run-1", title: "B", depends_on: [a.details.ticket.id] });
			const coderDeps = { ...deps, getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) };
			await expect(toolByName(coderDeps, "ticket_claim").execute("c3", { ticket_id: b.details.ticket.id })).rejects.toThrow(/not READY/);
		});

		it("rejects a claim missing a required capability", async () => {
			const { deps } = makeDeps();
			const created = await toolByName(deps, "ticket_create").execute("c1", { run_id: "run-1", title: "A", required_capabilities: ["frontend"] });
			const coderDeps = { ...deps, getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) };
			await expect(toolByName(coderDeps, "ticket_claim").execute("c2", { ticket_id: created.details.ticket.id })).rejects.toThrow(/missing required capabilities/);
		});
	});

	describe("ticket_complete", () => {
		async function claimedTicket(deps) {
			const created = await toolByName(deps, "ticket_create").execute("c1", { run_id: "run-1", title: "A" });
			const coderDeps = { ...deps, getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) };
			await toolByName(coderDeps, "ticket_claim").execute("c2", { ticket_id: created.details.ticket.id });
			return { ticketId: created.details.ticket.id, coderDeps };
		}

		it("marks done, drops activeTicketIds, and republishes presence", async () => {
			const { deps } = makeDeps();
			const { ticketId, coderDeps } = await claimedTicket(deps);
			const complete = toolByName(coderDeps, "ticket_complete");
			const result = await complete.execute("c3", { ticket_id: ticketId, status: "done" });
			expect(result.details.ticket.status).toBe("done");
			expect(deps.activeTicketIds.has(ticketId)).toBe(false);
		});

		it("completing the last ticket marks the run completed", async () => {
			const { deps, runs } = makeDeps();
			const { ticketId, coderDeps } = await claimedTicket(deps);
			await toolByName(coderDeps, "ticket_complete").execute("c3", { ticket_id: ticketId, status: "done" });
			expect(runs.get("run-1").status).toBe("completed");
		});

		it("only the assignee or planner may complete a ticket", async () => {
			const { deps } = makeDeps();
			const { ticketId } = await claimedTicket(deps);
			const otherCoderDeps = { ...deps, getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-02", playbook: null, skills: [] }) };
			await expect(toolByName(otherCoderDeps, "ticket_complete").execute("c3", { ticket_id: ticketId, status: "done" })).rejects.toThrow(/only the assignee or planner/);
		});

		it("a dependent ticket becomes ready and fires ticket_ready when its blocker completes", async () => {
			const { deps, storage } = makeDeps();
			const create = toolByName(deps, "ticket_create");
			const a = await create.execute("c1", { run_id: "run-1", title: "A" });
			await create.execute("c2", { run_id: "run-1", title: "B", depends_on: [a.details.ticket.id] });
			const coderDeps = { ...deps, getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) };
			await toolByName(coderDeps, "ticket_claim").execute("c3", { ticket_id: a.details.ticket.id });
			const result = await toolByName(coderDeps, "ticket_complete").execute("c4", { ticket_id: a.details.ticket.id, status: "done" });
			expect(result.details.newly_ready).toHaveLength(1);
		});
	});

	describe("ticket_requeue", () => {
		it("requeues without escalation when the storage layer reports none active", async () => {
			const { deps } = makeDeps();
			const tool = toolByName(deps, "ticket_requeue");
			const result = await tool.execute("c1", { ticket_id: "t1", reason: "crashed", max_retries: 3 });
			expect(result.details.recovery.recovery_generation).toBe(1);
			expect(recommendMock).not.toHaveBeenCalled();
		});

		it("on first escalation, recommends an alternate model and notifies", async () => {
			const { deps, storage } = makeDeps();
			storage.requeueTicketForRecovery.mockReturnValueOnce({ recovery: { recovery_generation: 2 }, escalation: { active: true } });
			recommendMock.mockResolvedValue({ recommended: { pinned_id: "anthropic/claude-sonnet-5@fallback" } });
			const tool = toolByName(deps, "ticket_requeue");
			const result = await tool.execute("c1", { ticket_id: "t1", reason: "crashed twice", max_retries: 3 });
			expect(result.details.escalation.recommended_model).toBe("anthropic/claude-sonnet-5@fallback");
			expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		});

		it("on final exhaustion, notifies with the exhaustion message and rethrows", async () => {
			const { deps, storage } = makeDeps();
			storage.requeueTicketForRecovery.mockImplementation(() => { throw new Error("recovery budget exhausted for ticket t1"); });
			const tool = toolByName(deps, "ticket_requeue");
			await expect(tool.execute("c1", { ticket_id: "t1", reason: "crashed again", max_retries: 3 })).rejects.toThrow(/recovery budget exhausted/);
			expect(deps.sendNotifications).toHaveBeenCalledTimes(1);
		});

		it("requires planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", playbook: null, skills: [] }) });
			const tool = toolByName(deps, "ticket_requeue");
			await expect(tool.execute("c1", { ticket_id: "t1", reason: "x", max_retries: 3 })).rejects.toThrow(/only planner/);
		});
	});

	describe("ticket_recovery_get", () => {
		it("reads the persisted recovery budget without requiring identity", async () => {
			const { deps } = makeDeps({ getIdentity: () => null });
			const tool = toolByName(deps, "ticket_recovery_get");
			const result = await tool.execute("c1", { ticket_id: "t1" });
			expect(result.details.recovery.max_retries).toBe(3);
		});
	});
});
