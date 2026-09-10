// Fase 5 / M4 — plan_set/plan_advance/plan_get/report_append/file_claim/
// file_release, extracted from extensions/orchestrator.ts. Real temporary
// filesystem (fs.mkdtempSync), same pattern as plan-gate.test.mjs (Fase
// 5/M1) — plan_set/plan_advance own the typed Plan round-trip directly on
// disk via plan-gate.ts, so a mock would just re-describe the
// implementation. requireWorktree is created directly via
// createRequireWorktree pointed at a real (non-git) temp dir — these
// handlers never call git themselves, so no `git init` is needed here
// (unlike worktree.test.mjs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlanTools } from "./plan.ts";
import { reportPath } from "./plan-gate.ts";

function makeDeps(worktreeDir, overrides = {}) {
	const identity = { role: "planner", cwd: worktreeDir, project: "demo", instance: "planner-01" };
	const tickets = new Map();
	const storage = {
		getTicket: (id) => tickets.get(id) ?? null,
	};
	const deps = {
		getIdentity: () => identity,
		requireWorktree: () => ({ path: worktreeDir, branch: "task/demo" }),
		ensureYanoStorage: () => storage,
		logEvent: vi.fn(),
		agentStatusSnapshot: () => "planner-01 idle",
		...overrides,
	};
	return { deps, identity, storage, tickets };
}

function toolByName(tools, name) {
	return tools.find((t) => t.name === name);
}

const minimalPlan = [
	{ roles: ["coder"] },
	{ roles: ["docs-sync"] },
];

describe("plan", () => {
	let worktreeDir;

	beforeEach(() => {
		worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tools-test-"));
	});
	afterEach(() => {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	});

	describe("plan_set / plan_advance / plan_get round-trip", () => {
		it("saves a plan with phase 1 unlocked and the rest locked", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			const result = await toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: minimalPlan });
			expect(result.details.plan.phases[0].status).toBe("unlocked");
			expect(result.details.plan.phases[1].status).toBe("locked");
		});

		it("rejects a phase 1 missing coder/refactoring-specialist/repo-curator/tdd-agent", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await expect(
				toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: [{ roles: ["reviewer"] }, { roles: ["docs-sync"] }] }),
			).rejects.toThrow(/phase 1 must include "coder"/);
		});

		it("rejects a last phase missing docs-sync", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await expect(
				toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: [{ roles: ["coder"] }] }),
			).rejects.toThrow(/LAST phase must include "docs-sync"/);
		});

		it("rejects a role appearing in two phases", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await expect(
				toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: [{ roles: ["coder"] }, { roles: ["coder", "docs-sync"] }] }),
			).rejects.toThrow(/may only belong to one phase/);
		});

		it("allows the tdd-agent-alone exception for phase 1 when coder follows in phase 2", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			const result = await toolByName(tools, "plan_set").execute("c1", {
				slug: "demo",
				phases: [{ roles: ["tdd-agent"] }, { roles: ["coder"] }, { roles: ["docs-sync"] }],
			});
			expect(result.details.plan.phases[0].status).toBe("unlocked");
		});

		it("rejects a non-planner caller", async () => {
			const { deps } = makeDeps(worktreeDir, { getIdentity: () => ({ role: "coder", cwd: worktreeDir, project: "demo", instance: "coder-01" }) });
			const tools = createPlanTools(deps);
			await expect(toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: minimalPlan })).rejects.toThrow(/only the planner role/);
		});

		it("advances phase 1 to complete and unlocks phase 2", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: minimalPlan });
			const result = await toolByName(tools, "plan_advance").execute("c1", { slug: "demo", completed_phase: 1 });
			expect(result.details.plan.phases[0].status).toBe("complete");
			expect(result.details.plan.phases[1].status).toBe("unlocked");
		});

		it("refuses to advance a still-locked phase out of order", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: minimalPlan });
			await expect(toolByName(tools, "plan_advance").execute("c1", { slug: "demo", completed_phase: 2 })).rejects.toThrow(/still locked/);
		});

		it("is a no-op advancing an already-complete phase", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: minimalPlan });
			await toolByName(tools, "plan_advance").execute("c1", { slug: "demo", completed_phase: 1 });
			const result = await toolByName(tools, "plan_advance").execute("c1", { slug: "demo", completed_phase: 1 });
			expect(result.content[0].text).toMatch(/already complete/);
		});

		it("requires every ticket_id to belong to run_id and be done before advancing", async () => {
			const { deps, tickets } = makeDeps(worktreeDir);
			tickets.set("t1", { id: "t1", run_id: "r1", status: "in_progress" });
			const tools = createPlanTools(deps);
			await toolByName(tools, "plan_set").execute("c1", { slug: "demo", phases: minimalPlan });
			await expect(
				toolByName(tools, "plan_advance").execute("c1", { slug: "demo", completed_phase: 1, run_id: "r1", ticket_ids: ["t1"] }),
			).rejects.toThrow(/incomplete ticket/);
			tickets.set("t1", { id: "t1", run_id: "r1", status: "done" });
			const result = await toolByName(tools, "plan_advance").execute("c1", { slug: "demo", completed_phase: 1, run_id: "r1", ticket_ids: ["t1"] });
			expect(result.details.plan.phases[0].status).toBe("complete");
		});

		it("plan_get returns null when no plan was ever set", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			const result = await toolByName(tools, "plan_get").execute("c1", { slug: "demo" });
			expect(result.details.plan).toBeNull();
		});
	});

	describe("report_append", () => {
		it("throws when the report file does not exist yet", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await expect(toolByName(tools, "report_append").execute("c1", { slug: "demo", section: "## Round 1" })).rejects.toThrow(/does not exist yet/);
		});

		it("appends atomically with an auto-generated event/status footer", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			const reportFile = reportPath(worktreeDir, "demo");
			fs.mkdirSync(path.dirname(reportFile), { recursive: true });
			fs.writeFileSync(reportFile, "# Report: demo\n");
			const result = await toolByName(tools, "report_append").execute("c1", { slug: "demo", section: "## Round 1 — coder\n\n- did the thing" });
			const content = fs.readFileSync(reportFile, "utf-8");
			expect(content).toContain("## Round 1 — coder");
			expect(content).toContain("stato team: planner-01 idle");
			expect(result.details.appended_bytes).toBeGreaterThan(0);
		});
	});

	describe("file_claim / file_release", () => {
		it("claims a free file and blocks a second claim by a different holder", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			const first = await toolByName(tools, "file_claim").execute("c1", { slug: "demo", file: "src/a.ts" });
			expect(first.details.claimed).toBe(true);

			const { deps: otherDeps } = makeDeps(worktreeDir, { getIdentity: () => ({ role: "coder", cwd: worktreeDir, project: "demo", instance: "coder-02" }) });
			const otherTools = createPlanTools(otherDeps);
			const second = await toolByName(otherTools, "file_claim").execute("c1", { slug: "demo", file: "src/a.ts" });
			expect(second.details.claimed).toBe(false);
			expect(second.details.held_by).toBe("planner-01");
		});

		it("treats an expired claim as free", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await toolByName(tools, "file_claim").execute("c1", { slug: "demo", file: "src/b.ts", ttl_minutes: 0.0001 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const { deps: otherDeps } = makeDeps(worktreeDir, { getIdentity: () => ({ role: "coder", cwd: worktreeDir, project: "demo", instance: "coder-02" }) });
			const otherTools = createPlanTools(otherDeps);
			const result = await toolByName(otherTools, "file_claim").execute("c1", { slug: "demo", file: "src/b.ts" });
			expect(result.details.claimed).toBe(true);
		});

		it("file_release is a no-op when you never held the file", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			const result = await toolByName(tools, "file_release").execute("c1", { slug: "demo", file: "src/never-claimed.ts" });
			expect(result.details.released).toBe(false);
		});

		it("releases a held file, freeing it for the next claimer", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await toolByName(tools, "file_claim").execute("c1", { slug: "demo", file: "src/c.ts" });
			const release = await toolByName(tools, "file_release").execute("c1", { slug: "demo", file: "src/c.ts" });
			expect(release.details.released).toBe(true);

			const { deps: otherDeps } = makeDeps(worktreeDir, { getIdentity: () => ({ role: "coder", cwd: worktreeDir, project: "demo", instance: "coder-02" }) });
			const otherTools = createPlanTools(otherDeps);
			const claim = await toolByName(otherTools, "file_claim").execute("c1", { slug: "demo", file: "src/c.ts" });
			expect(claim.details.claimed).toBe(true);
		});

		it("rejects an unsafe file path", async () => {
			const { deps } = makeDeps(worktreeDir);
			const tools = createPlanTools(deps);
			await expect(toolByName(tools, "file_claim").execute("c1", { slug: "demo", file: "../outside.ts" })).rejects.toThrow();
		});
	});
});
