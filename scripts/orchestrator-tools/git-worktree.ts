// Fase 5 / M0 — pure git/worktree primitives, extracted verbatim from
// extensions/orchestrator.ts. Zero closure dependencies (no
// identity/pi/ctx/storage — pure functions of the `cwd`/`slug`/`path`
// arguments passed in). Consumed both by the worktree_* tool handlers
// (moved into scripts/orchestrator-tools/worktree.ts, Fase 5/M3) AND by
// requireWorktree() in the "plan-gate" cluster (moved into
// scripts/orchestrator-tools/plan-gate.ts, Fase 5/M1) — extracted first,
// as the shared foundation both of those depend on, same reasoning as
// scripts/orchestrator-tools/redact.ts in Fase 4/M0.
//
// ━━ Git worktree isolation for task output ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Every task's actual file changes happen in a dedicated git worktree — a
// separate checkout on its own branch — instead of directly on the shared
// project directory's current branch. Nothing lands in the main project
// folder until the whole planner → coder → reviewer → planner cycle
// concludes with planner satisfied (worktree_finalize, called only then).
// Rejected/in-progress work simply never gets merged, so the main working
// tree never sees half-finished or failing attempts. Wrapped as real tools
// (not left to freehand `git` via a generic shell tool) because the failure
// modes here have real consequences — a bad merge or a lost worktree isn't
// something to leave to best-effort LLM shell commands when a few defensive
// checks can rule most of that out.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (err, stdout, stderr) => {
			if (err) reject(new Error(stderr?.toString().trim() || err.message));
			else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
		});
	});
}

export function worktreePaths(projectCwd: string, slug: string): { path: string; branch: string } {
	return {
		// Nested inside the project directory (not a sibling) so everything for
		// a task stays visibly under the project root, e.g. in an editor's file
		// tree. Git worktrees nested inside the tree they're a worktree of are
		// legal but leave a stray .git FILE (not directory) there that the main
		// checkout would otherwise see as an untracked path — ensureWorktreesGitignored()
		// keeps `.worktrees/` out of `git status` for the main checkout before
		// any worktree is ever created here, so this stays a non-issue.
		path: path.join(projectCwd, ".worktrees", slug),
		branch: `task/${slug}`,
	};
}

// Makes sure `.worktrees/` (where every task's worktree lives, nested inside
// the project) is gitignored in the MAIN checkout before we ever create one
// there — otherwise every task worktree would show up as an untracked path
// in `git status` on the main project, which is exactly the confusion this
// is meant to avoid. Idempotent: does nothing if the pattern is already
// present (as-is, or covered by a broader pattern like a bare `*`/`.*`).
// Commits the .gitignore change immediately in the main checkout so it does
// not linger as an untracked file itself; failure to commit is non-fatal
// (e.g. no git user.email/name configured yet) — the worktree creation that
// follows still proceeds either way.
export async function ensureWorktreesGitignored(projectCwd: string): Promise<void> {
	// Covers .worktrees/ (task worktrees) — logs/ used to need the same
	// treatment (Revisione 18) until Revisione 37 moved it under
	// .pi/extensions/yano-orchestrator/, which every scaffolded project
	// has gitignored wholesale since Revisione 31, so it no longer needs its
	// own entry here.
	const patterns: Array<{ dir: string; comment: string }> = [
		{ dir: ".worktrees/", comment: "# yano-orchestrator: per-task git worktrees (see docs/notes/development-notes.md)" },
	];
	const gitignorePath = path.join(projectCwd, ".gitignore");
	let existing = "";
	try {
		existing = fs.readFileSync(gitignorePath, "utf-8");
	} catch {
		// no .gitignore yet — will be created below
	}
	const lines = existing.split("\n").map((l) => l.trim());
	const isIgnored = (dir: string): boolean => {
		const bare = dir.replace(/\/$/, "");
		return lines.some((l) => l === dir || l === `/${dir}` || l === bare || l === `/${bare}` || l === "*" || l === ".*");
	};

	let addition = "";
	for (const { dir, comment } of patterns) {
		if (isIgnored(dir)) continue;
		addition += `${comment}\n${dir}\n`;
	}
	if (!addition) return;

	const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
	fs.writeFileSync(gitignorePath, existing + (needsLeadingNewline ? "\n" : "") + addition);

	try {
		await execGit(["add", ".gitignore"], projectCwd);
		await execGit(["commit", "-m", "chore: gitignore .worktrees/ (yano-orchestrator)"], projectCwd);
	} catch {
		// Non-fatal — worst case .gitignore sits there modified/untracked
		// until the next manual or agent-driven commit picks it up.
	}
}

export async function assertGitRepo(cwd: string): Promise<void> {
	try {
		await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
	} catch {
		throw new Error("git worktree isolation requires the project directory to be a git repository (git init it first).");
	}
}

// `git worktree list` reports each worktree's REAL (symlink-resolved) path.
// Comparing that against our own plain path.join() computation would false-
// negative on macOS, where /tmp (and other common parent dirs) is itself a
// symlink to /private/tmp — the exact platform this project has been tested
// on in this conversation. realpath both sides before comparing; fall back to
// path.resolve() when a path doesn't exist yet (nothing to resolve to).
export function normalizePath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

export async function findExistingWorktree(projectCwd: string, wtPath: string): Promise<boolean> {
	const { stdout } = await execGit(["worktree", "list", "--porcelain"], projectCwd);
	const target = normalizePath(wtPath);
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		if (normalizePath(line.slice("worktree ".length).trim()) === target) return true;
	}
	return false;
}
