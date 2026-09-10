// Fase 5 / M2 — agent_* tool handlers (7 of 8), extracted from
// extensions/orchestrator.ts. Fase 5/M6 added agent_send as the 8th; its
// own describe block below uses a real temp worktree (createRequireWorktree/
// writePlan from plan-gate.ts, not mocked) for the phase-gate tests, same
// reasoning as worktree.test.mjs/plan.test.mjs — that coupling is the
// actual thing being verified. Plain deps objects with vi.fn() spies
// elsewhere, same pattern as decision-holds.test.mjs (Fase 4/M0).
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentTools } from "./agents.ts";
import { createAssertRoleHandoffAllowed, createRequireWorktree, reportPath, writePlan } from "./plan-gate.ts";

function makeDeps(overrides = {}) {
	const presence = new Map();
	const pendingReplies = new Map();
	const activityLog = [];
	const identity = { role: "planner", cwd: "/p", project: "demo", instance: "planner-01", team: ["core"], capacity: 5 };
	const deps = {
		getIdentity: () => identity,
		getClient: () => ({ publishAsync: vi.fn(async () => {}) }),
		getT: () => ({
			teamEvents: (t) => `team/${t}`,
			agentCommands: (i) => `agent/${i}`,
			agentResponses: (i) => `agent/${i}/responses`,
			roleTasks: (r) => `role/${r}/tasks`,
			agentFallback: () => "system/agent-fallback",
		}),
		getMqttConnected: () => true,
		getPresenceHydration: () => Promise.resolve(),
		getCurrentInbound: () => null,
		presence,
		pendingReplies,
		activityLog,
		computeSelfStatus: () => "idle",
		currentLoad: () => 0,
		logEvent: vi.fn(),
		sendNotifications: vi.fn(async () => ({ ok: true, detail: "sent", channels: {} })),
		agentStatusSnapshot: () => "planner-01 idle",
		scheduleEviction: vi.fn(),
		requireWorktree: () => { throw new Error("requireWorktree not needed by this test"); },
		assertRoleHandoffAllowed: () => {},
		pi: { sendMessage: vi.fn(), appendEntry: vi.fn() },
		...overrides,
	};
	return { deps, presence, pendingReplies, activityLog };
}

function toolByName(deps, name) {
	return createAgentTools(deps).find((t) => t.name === name);
}

describe("agents", () => {
	describe("agent_control", () => {
		it("status verb reports peer count and mqtt connectivity without hitting the allow-list", async () => {
			const { deps, presence } = makeDeps();
			presence.set("coder-01", {});
			const result = await toolByName(deps, "agent_control").execute("c1", { verb: "status" });
			expect(result.details.peers).toBe(1);
			expect(result.details.mqtt_connected).toBe(true);
		});

		it("rejects launch/relaunch/terminate verbs for a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", team: [] }) });
			await expect(toolByName(deps, "agent_control").execute("c1", { verb: "launch", target: "herdr" })).rejects.toThrow(/planner-only/);
		});

		it("rejects a target binary not on the allow-list", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "agent_control").execute("c1", { verb: "launch", target: "curl" })).rejects.toThrow(/not allowlisted/);
		});
	});

	describe("agent_list", () => {
		it("awaits presence hydration and includes self marked non-delegatable", async () => {
			const hydration = vi.fn(() => Promise.resolve());
			const { deps } = makeDeps({ getPresenceHydration: hydration });
			const result = await toolByName(deps, "agent_list").execute();
			expect(hydration).toHaveBeenCalled();
			expect(result.details.agents).toHaveLength(1);
			expect(result.details.agents[0].self).toBe(true);
		});

		it("defaults missing team/capacity/current_load on an offline-shaped peer card instead of crashing (Revisione 41)", async () => {
			const { deps, presence } = makeDeps();
			presence.set("coder-01", { instance: "coder-01", role: "coder", status: "idle" }); // no team/capacity/current_load
			const result = await toolByName(deps, "agent_list").execute();
			const peer = result.details.agents.find((a) => a.instance === "coder-01");
			expect(peer.team).toEqual([]);
			expect(peer.current_load).toBe(0);
		});

		it("excludes offline peers from the roster", async () => {
			const { deps, presence } = makeDeps();
			presence.set("coder-01", { instance: "coder-01", role: "coder", status: "offline" });
			const result = await toolByName(deps, "agent_list").execute();
			expect(result.details.agents.find((a) => a.instance === "coder-01")).toBeUndefined();
		});
	});

	describe("agent_get / agent_await", () => {
		it("agent_get reports unknown for a missing assignment_id", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "agent_get").execute("c1", { assignment_id: "missing" });
			expect(result.details.status).toBe("unknown");
		});

		it("agent_get reports complete once the entry has a result", async () => {
			const { deps, pendingReplies } = makeDeps();
			pendingReplies.set("a1", { result: { response: "done" } });
			const result = await toolByName(deps, "agent_get").execute("c1", { assignment_id: "a1" });
			expect(result.details.status).toBe("complete");
			expect(result.details.response).toBe("done");
		});

		it("agent_await resolves with the response when the promise settles before the timeout", async () => {
			const { deps, pendingReplies } = makeDeps();
			pendingReplies.set("a1", { promise: Promise.resolve({ response: "hello" }), target: "coder-01", awaiting: false });
			const result = await toolByName(deps, "agent_await").execute("c1", { assignment_id: "a1", timeout_ms: 1000 });
			expect(result.details.response).toBe("hello");
		});

		it("agent_await reports an unknown assignment_id without racing anything", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "agent_await").execute("c1", { assignment_id: "missing" });
			expect(result.details.error).toBe("unknown assignment_id");
		});
	});

	describe("agent_publish_event", () => {
		it("publishes to the team channel when the caller is a member", async () => {
			const publishAsync = vi.fn(async () => {});
			const { deps } = makeDeps({ getClient: () => ({ publishAsync }) });
			const result = await toolByName(deps, "agent_publish_event").execute("c1", { team: "core", summary: "shipped auth" });
			expect(result.details.team).toBe("core");
			expect(publishAsync).toHaveBeenCalledWith("team/core", expect.stringContaining("shipped auth"), { qos: 0 });
		});

		it("rejects publishing to a team the caller does not belong to", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "agent_publish_event").execute("c1", { team: "not-my-team", summary: "x" })).rejects.toThrow(/not a member/);
		});
	});

	describe("agent_activity", () => {
		it("returns the most recent N events, newest-window only", async () => {
			const { deps, activityLog } = makeDeps();
			for (let i = 0; i < 5; i++) activityLog.push({ channel: "self", from: "coder-01", summary: `event ${i}`, timestamp: "t" });
			const result = await toolByName(deps, "agent_activity").execute("c1", { limit: 2 });
			expect(result.details.events).toHaveLength(2);
			expect(result.details.events[1].summary).toBe("event 4");
		});
	});

	describe("agent_terminate", () => {
		it("planner terminates a live peer, publishes the envelope, and logs it", async () => {
			const publishAsync = vi.fn(async () => {});
			const { deps, presence } = makeDeps({ getClient: () => ({ publishAsync }) });
			presence.set("coder-01", { status: "idle" });
			const result = await toolByName(deps, "agent_terminate").execute("c1", { target_instance: "coder-01", reason: "wedged" });
			expect(result.details.was_live).toBe(true);
			expect(publishAsync).toHaveBeenCalledTimes(1);
			expect(deps.logEvent).toHaveBeenCalledWith("agent_terminate_sent", expect.objectContaining({ target: "coder-01" }));
		});

		it("rejects a non-planner role", async () => {
			const { deps } = makeDeps({ getIdentity: () => ({ role: "coder", cwd: "/p", project: "demo", instance: "coder-01", team: [] }) });
			await expect(toolByName(deps, "agent_terminate").execute("c1", { target_instance: "coder-02", reason: "x" })).rejects.toThrow(/only the planner role/);
		});

		it("refuses to terminate yourself", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "agent_terminate").execute("c1", { target_instance: "planner-01", reason: "x" })).rejects.toThrow(/refusing to terminate yourself/);
		});

		it("is a harmless best-effort no-op signal when the target is not live", async () => {
			const { deps } = makeDeps();
			const result = await toolByName(deps, "agent_terminate").execute("c1", { target_instance: "coder-99", reason: "x" });
			expect(result.details.was_live).toBe(false);
		});
	});

	describe("agent_send", () => {
		it("rejects when neither target_instance nor target_role is given", async () => {
			const { deps } = makeDeps();
			await expect(toolByName(deps, "agent_send").execute("c1", { prompt: "do it" })).rejects.toThrow(/provide target_instance or target_role/);
		});

		it("publishes to the target instance and returns assignment_id/hops", async () => {
			const publishAsync = vi.fn(async () => {});
			const { deps, presence } = makeDeps({ getClient: () => ({ publishAsync }) });
			presence.set("coder-01", { instance: "coder-01", role: "coder", status: "idle" });
			const result = await toolByName(deps, "agent_send").execute("c1", { target_instance: "coder-01", prompt: "do it" });
			expect(result.details.hops).toBe(0);
			expect(result.details.no_live_target).toBe(false);
			expect(publishAsync).toHaveBeenCalledWith("agent/coder-01", expect.stringContaining("do it"), { qos: 1 });
		});

		it("inherits hops+1 from the current inbound context, and refuses past MAX_HOPS", async () => {
			const { deps, presence } = makeDeps({ getCurrentInbound: () => ({ hops: 5 }) });
			presence.set("coder-01", { instance: "coder-01", role: "coder", status: "idle" });
			const result = await toolByName(deps, "agent_send").execute("c1", { target_instance: "coder-01", prompt: "x" });
			expect(result.details.hops).toBe(6);

			const { deps: maxedDeps } = makeDeps({ getCurrentInbound: () => ({ hops: 999 }) });
			await expect(toolByName(maxedDeps, "agent_send").execute("c1", { target_instance: "coder-01", prompt: "x" })).rejects.toThrow(/hop limit reached/);
		});

		it("new_round:true resets the hop chain to 0 even with an inbound context", async () => {
			const { deps, presence } = makeDeps({ getCurrentInbound: () => ({ hops: 5 }) });
			presence.set("coder-01", { instance: "coder-01", role: "coder", status: "idle" });
			const result = await toolByName(deps, "agent_send").execute("c1", { target_instance: "coder-01", prompt: "x", new_round: true });
			expect(result.details.hops).toBe(0);
		});

		it("routes to a live planner and warns when the requested target is not live", async () => {
			const publishAsync = vi.fn(async () => {});
			const { deps, presence } = makeDeps({ getClient: () => ({ publishAsync }) });
			presence.set("planner-02", { instance: "planner-02", role: "planner", status: "idle" });
			const result = await toolByName(deps, "agent_send").execute("c1", { target_instance: "coder-99", prompt: "x" });
			expect(result.details.no_live_target).toBe(true);
			expect(result.details.route).toBe("planner");
			expect(result.details.fallback_target).toBe("planner-02");
			expect(publishAsync).toHaveBeenCalledWith("agent/planner-02", expect.stringContaining("[yano-routing]"), { qos: 1 });
		});

		it("routes to the watcher fallback topic when nobody is live, skipping the real bootstrap under the test env flag", async () => {
			const prior = process.env.PI_ORCH_TEST_NO_EXIT;
			process.env.PI_ORCH_TEST_NO_EXIT = "1";
			try {
				const publishAsync = vi.fn(async () => {});
				const { deps } = makeDeps({ getClient: () => ({ publishAsync }) });
				const result = await toolByName(deps, "agent_send").execute("c1", { target_role: "coder", prompt: "x" });
				expect(result.details.route).toBe("watcher");
				expect(result.details.watcher_bootstrap).toEqual({ attempted: false, ok: false, detail: "test harness: bootstrap skipped" });
				expect(publishAsync).toHaveBeenCalledWith("system/agent-fallback", expect.stringContaining("agent_route_fallback"), { qos: 1, retain: true });
			} finally {
				if (prior === undefined) delete process.env.PI_ORCH_TEST_NO_EXIT;
				else process.env.PI_ORCH_TEST_NO_EXIT = prior;
			}
		});

		describe("phase gate (real plan-gate.ts, temp worktree)", () => {
			let cwd;

			function setup() {
				cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-send-test-"));
				fs.mkdirSync(path.join(cwd, ".worktrees", "demo"), { recursive: true });
				return path.join(cwd, ".worktrees", "demo");
			}

			it("refuses a send to a role in a still-locked phase, for any sender", async () => {
				const wtPath = setup();
				writePlan(wtPath, "demo", {
					slug: "demo",
					phases: [
						{ phase: 1, roles: ["coder"], status: "unlocked" },
						{ phase: 2, roles: ["docs-sync"], status: "locked" },
					],
					created_at: "t0",
					updated_at: "t0",
				});
				try {
					const identity = { role: "planner", cwd, project: "demo", instance: "planner-01", team: ["core"], capacity: 5 };
					const { deps, presence } = makeDeps({
						getIdentity: () => identity,
						requireWorktree: createRequireWorktree({ getIdentity: () => identity }),
						assertRoleHandoffAllowed: createAssertRoleHandoffAllowed({ getIdentity: () => identity }),
					});
					presence.set("docs-sync-01", { instance: "docs-sync-01", role: "docs-sync", status: "idle" });
					await expect(
						toolByName(deps, "agent_send").execute("c1", { target_instance: "docs-sync-01", prompt: "x", slug: "demo" }),
					).rejects.toThrow(/still.*locked/);
				} finally {
					fs.rmSync(cwd, { recursive: true, force: true });
				}
			});

			it("allows a send to a role in an unlocked phase and appends an audit line to the task report", async () => {
				const wtPath = setup();
				writePlan(wtPath, "demo", {
					slug: "demo",
					phases: [{ phase: 1, roles: ["coder"], status: "unlocked" }],
					created_at: "t0",
					updated_at: "t0",
				});
				const report = reportPath(wtPath, "demo");
				fs.mkdirSync(path.dirname(report), { recursive: true });
				fs.writeFileSync(report, "# Report: demo\n");
				try {
					const identity = { role: "planner", cwd, project: "demo", instance: "planner-01", team: ["core"], capacity: 5 };
					const publishAsync = vi.fn(async () => {});
					const { deps, presence } = makeDeps({
						getIdentity: () => identity,
						getClient: () => ({ publishAsync }),
						requireWorktree: createRequireWorktree({ getIdentity: () => identity }),
						assertRoleHandoffAllowed: createAssertRoleHandoffAllowed({ getIdentity: () => identity }),
					});
					presence.set("coder-01", { instance: "coder-01", role: "coder", status: "idle" });
					const result = await toolByName(deps, "agent_send").execute("c1", { target_instance: "coder-01", prompt: "x", slug: "demo" });
					expect(result.details.no_live_target).toBe(false);
					const content = fs.readFileSync(report, "utf-8");
					expect(content).toContain("agent_send:");
					expect(content).toContain("coder-01");
				} finally {
					fs.rmSync(cwd, { recursive: true, force: true });
				}
			});
		});
	});
});
