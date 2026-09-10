// Fase 5 / M1 — the "plan-gate" cluster, extracted from
// extensions/orchestrator.ts. Real temporary filesystem (fs.mkdtempSync),
// same pattern used throughout Fase 4/5 for fs-backed modules.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendPlanAudit, assertSafeRelativeFile, createAssertRoleHandoffAllowed, createRequireWorktree,
	findPhaseForRole, lockExpired, locksPath, planMarkdownPath, planPath, readLocks, readPlan,
	renderPlanMarkdown, reportPath, reportsDir, writeLocks, writePlan,
} from "./plan-gate.ts";

function makeIdentity(cwd) {
	return { getIdentity: () => ({ cwd }) };
}

describe("plan-gate", () => {
	let worktreePath;

	beforeEach(() => {
		worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "plan-gate-test-"));
	});
	afterEach(() => {
		fs.rmSync(worktreePath, { recursive: true, force: true });
	});

	describe("reportsDir / reportPath / locksPath", () => {
		it("resolves under .pi/extensions/yano-orchestrator/reports", () => {
			expect(reportsDir(worktreePath)).toBe(path.join(worktreePath, ".pi", "extensions", "yano-orchestrator", "reports"));
			expect(reportPath(worktreePath, "fix-bug")).toBe(path.join(reportsDir(worktreePath), "fix-bug.md"));
		});
		it("locksPath sits directly in the worktree root, not under .pi/", () => {
			expect(locksPath(worktreePath)).toBe(path.join(worktreePath, ".orchestrator-locks.json"));
		});
	});

	describe("readLocks / writeLocks / lockExpired", () => {
		it("readLocks returns [] when no lock file exists yet", () => {
			expect(readLocks(worktreePath)).toEqual([]);
		});
		it("writeLocks then readLocks round-trips", () => {
			const locks = [{ file: "src/a.ts", holder: "coder-01", claimed_at: new Date().toISOString(), ttl_minutes: 30 }];
			writeLocks(worktreePath, locks);
			expect(readLocks(worktreePath)).toEqual(locks);
		});
		it("lockExpired is false just after claiming, true well past the ttl", () => {
			const fresh = { file: "a", holder: "x", claimed_at: new Date().toISOString(), ttl_minutes: 30 };
			const stale = { file: "a", holder: "x", claimed_at: new Date(Date.now() - 60 * 60_000).toISOString(), ttl_minutes: 30 };
			expect(lockExpired(fresh)).toBe(false);
			expect(lockExpired(stale)).toBe(true);
		});
	});

	describe("assertSafeRelativeFile", () => {
		it("accepts a plain relative path", () => {
			expect(() => assertSafeRelativeFile("src/a.ts")).not.toThrow();
		});
		it("rejects an absolute path and a path escaping the worktree via ..", () => {
			expect(() => assertSafeRelativeFile("/etc/passwd")).toThrow(/must be a relative path/);
			expect(() => assertSafeRelativeFile("../outside.ts")).toThrow(/must be a relative path/);
		});
	});

	describe("createRequireWorktree", () => {
		it("rejects an invalid slug before ever touching the filesystem", () => {
			const requireWorktree = createRequireWorktree(makeIdentity(worktreePath));
			expect(() => requireWorktree("Not Valid!")).toThrow(/not a valid kebab-case slug/);
		});
		it("throws when no worktree directory exists for a valid slug", () => {
			const requireWorktree = createRequireWorktree(makeIdentity(worktreePath));
			expect(() => requireWorktree("fix-bug")).toThrow(/No worktree found/);
		});
		it("resolves the path/branch once the worktree directory exists", () => {
			const wtPath = path.join(worktreePath, ".worktrees", "fix-bug");
			fs.mkdirSync(wtPath, { recursive: true });
			const requireWorktree = createRequireWorktree(makeIdentity(worktreePath));
			const result = requireWorktree("fix-bug");
			expect(result.path).toBe(wtPath);
			expect(result.branch).toBe("task/fix-bug");
		});
	});

	describe("readPlan / writePlan / renderPlanMarkdown round-trip", () => {
		it("readPlan returns null when no plan exists yet", () => {
			expect(readPlan(worktreePath, "fix-bug")).toBeNull();
		});
		it("writePlan persists both .plan.json and a rendered .plan.md, readPlan reads it back", () => {
			const plan = {
				slug: "fix-bug",
				phases: [{ phase: 1, roles: ["coder"], status: "unlocked" }, { phase: 2, roles: ["reviewer"], status: "locked" }],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			writePlan(worktreePath, "fix-bug", plan);
			expect(fs.existsSync(planPath(worktreePath, "fix-bug"))).toBe(true);
			expect(fs.existsSync(planMarkdownPath(worktreePath, "fix-bug"))).toBe(true);
			expect(readPlan(worktreePath, "fix-bug")).toEqual(plan);
			const markdown = fs.readFileSync(planMarkdownPath(worktreePath, "fix-bug"), "utf-8");
			expect(markdown).toContain("Fase 1");
			expect(markdown).toContain("coder");
		});
	});

	describe("appendPlanAudit", () => {
		it("is a silent no-op when the report file does not exist yet", () => {
			expect(() => appendPlanAudit(worktreePath, "fix-bug", "evento di test")).not.toThrow();
		});
		it("appends a timestamped audit line when the report exists", () => {
			fs.mkdirSync(reportsDir(worktreePath), { recursive: true });
			fs.writeFileSync(reportPath(worktreePath, "fix-bug"), "# Report\n");
			appendPlanAudit(worktreePath, "fix-bug", "fase avanzata");
			const content = fs.readFileSync(reportPath(worktreePath, "fix-bug"), "utf-8");
			expect(content).toContain("fase avanzata");
		});
	});

	describe("findPhaseForRole", () => {
		it("finds the phase a role belongs to, case-insensitively", () => {
			const plan = { slug: "s", phases: [{ phase: 1, roles: ["Coder"], status: "unlocked" }], created_at: "", updated_at: "" };
			expect(findPhaseForRole(plan, "coder")?.phase).toBe(1);
			expect(findPhaseForRole(plan, "reviewer")).toBeUndefined();
		});
	});

	describe("createAssertRoleHandoffAllowed", () => {
		it("allows the standard planner → coder → reviewer → planner cycle", () => {
			const assertRoleHandoffAllowed = createAssertRoleHandoffAllowed(makeIdentity(worktreePath));
			expect(() => assertRoleHandoffAllowed("planner", "coder", "fix-bug")).not.toThrow();
			expect(() => assertRoleHandoffAllowed("coder", "reviewer", "fix-bug")).not.toThrow();
			expect(() => assertRoleHandoffAllowed("reviewer", "planner", "fix-bug")).not.toThrow();
		});

		it("rejects coder sending directly to planner (must go through reviewer)", () => {
			const assertRoleHandoffAllowed = createAssertRoleHandoffAllowed(makeIdentity(worktreePath));
			expect(() => assertRoleHandoffAllowed("coder", "planner", "fix-bug")).toThrow(/refused/);
		});

		it("allows planner to send to reviewer directly only when the plan is a refactor or clean-repo plan", () => {
			const assertRoleHandoffAllowed = createAssertRoleHandoffAllowed(makeIdentity(worktreePath));
			// No plan on disk at all -> not a refactor/clean-repo plan -> refused.
			expect(() => assertRoleHandoffAllowed("planner", "reviewer", "no-such-plan")).toThrow(/refused/);

			const wtPath = path.join(worktreePath, ".worktrees", "refactor-task");
			fs.mkdirSync(wtPath, { recursive: true });
			writePlan(wtPath, "refactor-task", { slug: "refactor-task", phases: [{ phase: 1, roles: ["refactoring-specialist"], status: "unlocked" }], created_at: "", updated_at: "" });
			expect(() => assertRoleHandoffAllowed("planner", "reviewer", "refactor-task")).not.toThrow();
		});

		it("allows any non-core sender to reach the planner (e.g. a specialist reporting back)", () => {
			const assertRoleHandoffAllowed = createAssertRoleHandoffAllowed(makeIdentity(worktreePath));
			expect(() => assertRoleHandoffAllowed("refactoring-specialist", "planner", "fix-bug")).not.toThrow();
		});

		it("targets outside the gated set (e.g. tdd-agent) are never gated", () => {
			const assertRoleHandoffAllowed = createAssertRoleHandoffAllowed(makeIdentity(worktreePath));
			expect(() => assertRoleHandoffAllowed("literally-anyone", "tdd-agent", "fix-bug")).not.toThrow();
		});
	});
});
