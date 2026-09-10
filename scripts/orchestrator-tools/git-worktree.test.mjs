// Fase 5 / M0 — pure git/worktree primitives, extracted from
// extensions/orchestrator.ts. Real temporary git repository (fs.mkdtempSync
// + `git init`), same pattern as scripts/yano-terminal-integration.test.mjs
// (Fase 2/M1) — these primitives shell out to real `git`, so a mock would
// just re-describe the implementation rather than verify it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SLUG_RE, assertGitRepo, ensureWorktreesGitignored, execGit, findExistingWorktree, normalizePath, worktreePaths } from "./git-worktree.ts";

describe("git-worktree", () => {
	let repoDir;

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-test-"));
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
		fs.writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
		execFileSync("git", ["add", "README.md"], { cwd: repoDir });
		execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });
	});
	afterEach(() => {
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	describe("SLUG_RE", () => {
		it("accepts lowercase kebab-case starting with a letter", () => {
			expect(SLUG_RE.test("fix-login-bug")).toBe(true);
			expect(SLUG_RE.test("a")).toBe(true);
		});
		it("rejects uppercase, leading digit/hyphen, and empty", () => {
			expect(SLUG_RE.test("Fix-Bug")).toBe(false);
			expect(SLUG_RE.test("1-fix")).toBe(false);
			expect(SLUG_RE.test("-fix")).toBe(false);
			expect(SLUG_RE.test("")).toBe(false);
		});
	});

	describe("worktreePaths", () => {
		it("is deterministic and nests under .worktrees/ with a task/ branch prefix", () => {
			const a = worktreePaths(repoDir, "fix-login-bug");
			const b = worktreePaths(repoDir, "fix-login-bug");
			expect(a).toEqual(b);
			expect(a.path).toBe(path.join(repoDir, ".worktrees", "fix-login-bug"));
			expect(a.branch).toBe("task/fix-login-bug");
		});
	});

	describe("assertGitRepo", () => {
		it("resolves for a real git repository", async () => {
			await expect(assertGitRepo(repoDir)).resolves.toBeUndefined();
		});
		it("throws for a directory that is not a git repository", async () => {
			const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
			try {
				await expect(assertGitRepo(plainDir)).rejects.toThrow(/must be a git repository|git init it first/);
			} finally {
				fs.rmSync(plainDir, { recursive: true, force: true });
			}
		});
	});

	describe("ensureWorktreesGitignored", () => {
		it("adds .worktrees/ to .gitignore and commits it", async () => {
			await ensureWorktreesGitignored(repoDir);
			const gitignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf-8");
			expect(gitignore).toContain(".worktrees/");
			const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString();
			expect(status.trim()).toBe(""); // committed, not left dirty
		});

		it("is idempotent — a second call does not duplicate the entry or re-commit", async () => {
			await ensureWorktreesGitignored(repoDir);
			const firstLog = execFileSync("git", ["log", "--oneline"], { cwd: repoDir }).toString();
			await ensureWorktreesGitignored(repoDir);
			const secondLog = execFileSync("git", ["log", "--oneline"], { cwd: repoDir }).toString();
			expect(secondLog).toBe(firstLog);
			const gitignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf-8");
			expect(gitignore.match(/\.worktrees\//g)).toHaveLength(1);
		});

		it("does nothing when a broader pattern already covers it", async () => {
			fs.writeFileSync(path.join(repoDir, ".gitignore"), "*\n");
			await ensureWorktreesGitignored(repoDir);
			const gitignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf-8");
			expect(gitignore).toBe("*\n");
		});
	});

	describe("execGit / findExistingWorktree / normalizePath", () => {
		it("findExistingWorktree is false before creation and true after a real `git worktree add`", async () => {
			const { path: wtPath, branch } = worktreePaths(repoDir, "demo-task");
			expect(await findExistingWorktree(repoDir, wtPath)).toBe(false);
			await execGit(["worktree", "add", "-b", branch, wtPath], repoDir);
			expect(await findExistingWorktree(repoDir, wtPath)).toBe(true);
		});

		it("normalizePath resolves an existing path via realpath and falls back to path.resolve for a missing one", () => {
			expect(normalizePath(repoDir)).toBe(fs.realpathSync(repoDir));
			const missing = path.join(repoDir, "does-not-exist");
			expect(normalizePath(missing)).toBe(path.resolve(missing));
		});

		it("execGit rejects with a readable error for an invalid git command", async () => {
			await expect(execGit(["not-a-real-git-command"], repoDir)).rejects.toThrow();
		});
	});
});
