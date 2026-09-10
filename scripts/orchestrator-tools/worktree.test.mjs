// Fase 5 / M3 — worktree_* tool handlers, extracted from
// extensions/orchestrator.ts. Real temporary git repository (same pattern
// as git-worktree.test.mjs, Fase 5/M0) — these handlers shell out to real
// `git worktree`/`merge`, so a mock would just re-describe the
// implementation. Storage (finalize evidence, run lookups) is a plain
// hand-written mock, same pattern as decision-holds.test.mjs (Fase 4/M0).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktreeTools } from "./worktree.ts";
import { createRequireWorktree, locksPath, readLocks, reportPath, writeLocks } from "./plan-gate.ts";

function makeDeps(repoDir, overrides = {}) {
	const identity = { role: "planner", cwd: repoDir, project: "demo", instance: "planner-01" };
	const evidenceStore = [];
	const runs = new Map();
	const storage = {
		recordFinalizeEvidence(input) {
			const record = { id: `ev-${evidenceStore.length + 1}`, ...input };
			evidenceStore.push(record);
			return record;
		},
		listFinalizeEvidence(slug) {
			return evidenceStore.filter((e) => e.slug === slug);
		},
		recordEvent: vi.fn(),
		getRun: (runId) => runs.get(runId) ?? null,
		updateRunFinalizationStatus: vi.fn(),
	};
	const deps = {
		getIdentity: () => identity,
		requireWorktree: createRequireWorktree({ getIdentity: () => identity }),
		ensureYanoStorage: () => storage,
		logEvent: vi.fn(),
		sendNotifications: vi.fn(async () => ({ ok: true, detail: "sent", channels: {} })),
		...overrides,
	};
	return { deps, identity, storage, runs };
}

function toolByName(deps, repoDir, name) {
	return createWorktreeTools(makeDeps(repoDir, deps).deps).find((t) => t.name === name);
}

function initRepo(dir) {
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
	execFileSync("git", ["add", "README.md"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
}

describe("worktree", () => {
	let repoDir;

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-tools-test-"));
		initRepo(repoDir);
	});
	afterEach(() => {
		fs.rmSync(repoDir, { recursive: true, force: true });
	});

	describe("worktree_create / worktree_list_open", () => {
		it("creates a new worktree on task/<slug>, then reuses it on a second call", async () => {
			const { deps } = makeDeps(repoDir);
			const tools = createWorktreeTools(deps);
			const create = tools.find((t) => t.name === "worktree_create");
			const first = await create.execute("c1", { slug: "fix-login" });
			expect(first.details.reused).toBe(false);
			expect(fs.existsSync(first.details.worktree_path)).toBe(true);
			const second = await create.execute("c1", { slug: "fix-login" });
			expect(second.details.reused).toBe(true);
			expect(second.details.worktree_path).toBe(first.details.worktree_path);
		});

		it("rejects a non-kebab-case slug", async () => {
			const create = toolByName({}, repoDir, "worktree_create");
			await expect(create.execute("c1", { slug: "Fix Login" })).rejects.toThrow(/not a valid kebab-case slug/);
		});

		it("lists open worktrees, excluding the main checkout, with the report's Task line when present", async () => {
			const { deps } = makeDeps(repoDir);
			const tools = createWorktreeTools(deps);
			const create = tools.find((t) => t.name === "worktree_create");
			const created = await create.execute("c1", { slug: "add-feature" });
			const report = reportPath(created.details.worktree_path, "add-feature");
			fs.mkdirSync(path.dirname(report), { recursive: true });
			fs.writeFileSync(report, "# Report\n\n- Task: Add the new feature\n");

			const list = tools.find((t) => t.name === "worktree_list_open");
			const result = await list.execute("c1", {});
			expect(result.details.open).toHaveLength(1);
			expect(result.details.open[0].slug).toBe("add-feature");
			expect(result.details.open[0].task).toBe("Add the new feature");
		});

		it("reports none open when there are no task worktrees yet", async () => {
			const list = toolByName({}, repoDir, "worktree_list_open");
			const result = await list.execute("c1", {});
			expect(result.details.open).toHaveLength(0);
		});
	});

	describe("finalize_evidence_collect / finalize_evidence_list", () => {
		async function createWorktree(deps, slug) {
			const tools = createWorktreeTools(deps);
			await tools.find((t) => t.name === "worktree_create").execute("c1", { slug });
		}

		it("collects commit-kind evidence bound to the worktree's HEAD commit", async () => {
			const { deps } = makeDeps(repoDir);
			await createWorktree(deps, "task-a");
			const tools = createWorktreeTools(deps);
			const collect = tools.find((t) => t.name === "finalize_evidence_collect");
			const result = await collect.execute("c1", { slug: "task-a", kind: "commit", source: "ci", idempotency_key: "k1" });
			expect(result.details.evidence.status).toBe("verified");
			expect(result.details.evidence.kind).toBe("commit");
		});

		it("marks workspace evidence failed when the worktree has uncommitted changes", async () => {
			const { deps } = makeDeps(repoDir);
			await createWorktree(deps, "task-b");
			const wtPath = path.join(repoDir, ".worktrees", "task-b");
			fs.writeFileSync(path.join(wtPath, "dirty.txt"), "uncommitted");
			const tools = createWorktreeTools(deps);
			const collect = tools.find((t) => t.name === "finalize_evidence_collect");
			const result = await collect.execute("c1", { slug: "task-b", kind: "workspace", source: "ci", idempotency_key: "k2" });
			expect(result.details.evidence.status).toBe("failed");
		});

		it("rejects a non-planner caller", async () => {
			const { deps } = makeDeps(repoDir, { getIdentity: () => ({ role: "coder", cwd: repoDir, project: "demo", instance: "coder-01" }) });
			const tools = createWorktreeTools(deps);
			const collect = tools.find((t) => t.name === "finalize_evidence_collect");
			await expect(collect.execute("c1", { slug: "task-a", kind: "commit", source: "ci", idempotency_key: "k3" })).rejects.toThrow(/only planner/);
		});

		it("lists previously collected evidence for a slug", async () => {
			const { deps } = makeDeps(repoDir);
			await createWorktree(deps, "task-c");
			const tools = createWorktreeTools(deps);
			await tools.find((t) => t.name === "finalize_evidence_collect").execute("c1", { slug: "task-c", kind: "commit", source: "ci", idempotency_key: "k4" });
			const list = tools.find((t) => t.name === "finalize_evidence_list");
			const result = await list.execute("c1", { slug: "task-c" });
			expect(result.details.evidence).toHaveLength(1);
		});
	});

	describe("worktree_finalize", () => {
		const fullDeclarations = {
			user_confirmed: true,
			e2e_tests_run: true,
			version_bumped: true,
			docs_synced: true,
			push: false,
		};

		it("refuses without user_confirmed", async () => {
			const { deps } = makeDeps(repoDir);
			await createWorktreeTools(deps).find((t) => t.name === "worktree_create").execute("c1", { slug: "task-d" });
			const finalize = createWorktreeTools(deps).find((t) => t.name === "worktree_finalize");
			await expect(finalize.execute("c1", { slug: "task-d", ...fullDeclarations, user_confirmed: false })).rejects.toThrow(/user_confirmed must be true/);
		});

		it("refuses without an e2e declaration or skip reason", async () => {
			const { deps } = makeDeps(repoDir);
			await createWorktreeTools(deps).find((t) => t.name === "worktree_create").execute("c1", { slug: "task-e" });
			const finalize = createWorktreeTools(deps).find((t) => t.name === "worktree_finalize");
			await expect(finalize.execute("c1", { slug: "task-e", ...fullDeclarations, e2e_tests_run: false })).rejects.toThrow(/e2e_tests_run/);
		});

		it("merges a clean worktree into main, removes the worktree, and clears its lock file", async () => {
			const { deps } = makeDeps(repoDir);
			const tools = createWorktreeTools(deps);
			const created = await tools.find((t) => t.name === "worktree_create").execute("c1", { slug: "task-f" });
			const wtPath = created.details.worktree_path;
			fs.writeFileSync(path.join(wtPath, "feature.txt"), "new feature");
			execFileSync("git", ["add", "-A"], { cwd: wtPath });
			execFileSync("git", ["commit", "-q", "-m", "add feature"], { cwd: wtPath });
			// cross-module: a lock claimed via plan-gate.ts's writeLocks/readLocks
			// (the same mechanism file_claim/file_release use) must be cleared by
			// worktree_finalize before the safety-net commit — otherwise an
			// ephemeral coordination file would land in main's history.
			writeLocks(wtPath, [{ file: "feature.txt", holder: "coder-01", claimed_at: new Date().toISOString(), reason: "editing" }]);
			expect(readLocks(wtPath)).toHaveLength(1);

			const finalize = tools.find((t) => t.name === "worktree_finalize");
			const result = await finalize.execute("c1", { slug: "task-f", ...fullDeclarations });
			expect(result.details.merged).toBe(true);
			expect(fs.existsSync(wtPath)).toBe(false);
			expect(fs.existsSync(path.join(repoDir, "feature.txt"))).toBe(true);
			expect(fs.existsSync(locksPath(wtPath))).toBe(false);
		});

		it("blocks the merge when the main checkout itself has uncommitted changes", async () => {
			const { deps } = makeDeps(repoDir);
			const tools = createWorktreeTools(deps);
			await tools.find((t) => t.name === "worktree_create").execute("c1", { slug: "task-g" });
			fs.writeFileSync(path.join(repoDir, "dirty-main.txt"), "uncommitted in main");

			const finalize = tools.find((t) => t.name === "worktree_finalize");
			const result = await finalize.execute("c1", { slug: "task-g", ...fullDeclarations });
			expect(result.details.blocked_dirty_main).toBe(true);
			expect(result.details.merged).toBe(false);
		});
	});

	describe("worktree_abandon", () => {
		it("refuses when the worktree still has uncommitted changes", async () => {
			const { deps } = makeDeps(repoDir);
			const tools = createWorktreeTools(deps);
			const created = await tools.find((t) => t.name === "worktree_create").execute("c1", { slug: "task-h" });
			fs.writeFileSync(path.join(created.details.worktree_path, "dirty.txt"), "uncommitted");

			const abandon = tools.find((t) => t.name === "worktree_abandon");
			await expect(abandon.execute("c1", { slug: "task-h" })).rejects.toThrow(/still has uncommitted changes/);
		});

		it("removes a clean worktree, deletes its branch by default, and preserves the report into main", async () => {
			const { deps } = makeDeps(repoDir);
			const tools = createWorktreeTools(deps);
			const created = await tools.find((t) => t.name === "worktree_create").execute("c1", { slug: "task-i" });
			const wtPath = created.details.worktree_path;
			const wtReport = reportPath(wtPath, "task-i");
			fs.mkdirSync(path.dirname(wtReport), { recursive: true });
			fs.writeFileSync(wtReport, "# Report\n\n- Task: something\n");
			execFileSync("git", ["add", "-A"], { cwd: wtPath });
			execFileSync("git", ["commit", "-q", "-m", "report"], { cwd: wtPath });

			const abandon = tools.find((t) => t.name === "worktree_abandon");
			const result = await abandon.execute("c1", { slug: "task-i" });
			expect(result.details.branch_deleted).toBe(true);
			expect(fs.existsSync(wtPath)).toBe(false);
			expect(fs.existsSync(reportPath(repoDir, "task-i"))).toBe(true);
		});
	});
});
