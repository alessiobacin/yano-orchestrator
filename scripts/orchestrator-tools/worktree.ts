// Fase 5 / M3 — worktree_* tool handlers (6 of 6), extracted from
// extensions/orchestrator.ts. Depends on scripts/orchestrator-tools/
// git-worktree.ts (Fase 5/M0, pure functions, imported directly — no
// wrapping needed) and scripts/orchestrator-tools/plan-gate.ts (Fase 5/M1):
// locksPath/reportPath are pure and imported directly; requireWorktree
// closes over identity via its own getter, already built once in
// orchestrator.ts (`const requireWorktree = createRequireWorktree(...)`),
// so it's passed here as a direct function reference — no re-injection of
// getIdentity needed, same reasoning the plan calls out for M3/M5/M6.
// ensureYanoStorage/sendNotifications are closure functions already
// correctly bound at their own definition site in orchestrator.ts — passed
// as direct references, same pattern as every Fase 4/5 module.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";
import { SLUG_RE, execGit, worktreePaths, normalizePath, ensureWorktreesGitignored, assertGitRepo, findExistingWorktree } from "./git-worktree.ts";
import { locksPath, reportPath } from "./plan-gate.ts";
import { openDatabase as openFeedbackDatabase, listFeedback, terminalStatusForFeedbackId } from "../yano-feedback.mjs";

function nowIso(): string {
	return new Date().toISOString();
}

export interface Identity {
	role: string;
	cwd: string;
	project: string;
	instance: string;
}

export interface WorktreeToolsDeps {
	getIdentity: () => Identity | null;
	requireWorktree: (slug: string) => { path: string; branch: string };
	ensureYanoStorage: () => OrchestratorStorage;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	sendNotifications: (message: string) => Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }>;
}

export function createWorktreeTools(deps: WorktreeToolsDeps) {
	const { getIdentity, requireWorktree, ensureYanoStorage, logEvent, sendNotifications } = deps;
	return [
		{
			name: "worktree_create",
			label: "Worktree Create",
			description:
				"Create (or reuse, if already created for this slug) an isolated git worktree for a task's file changes — a separate " +
				"checkout on its own branch (task/<slug>), nested at .worktrees/<slug> inside the project directory (kept out of the " +
				"main checkout's `git status` via an auto-managed .gitignore entry). ALL file edits, test runs, and report-file " +
				"writes for this task must happen inside the returned worktree_path, never directly in the main project directory — " +
				"nothing reaches the main project folder until worktree_finalize merges it, only once the whole task succeeds. Safe " +
				"to call again with the same slug (e.g. across rounds of the same task) — reuses the existing worktree instead of erroring.",
			parameters: Type.Object({
				slug: Type.String({ description: "Kebab-case task slug, same one used for the report file (e.g. \"codice-fiscale\")." }),
			}),
			async execute(_callId: string, params: { slug: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const slug = params.slug;
				if (!SLUG_RE.test(slug)) throw new Error(`worktree_create: "${slug}" is not a valid kebab-case slug (lowercase letters, digits, hyphens, starting with a letter).`);
				await assertGitRepo(identity.cwd);
				await ensureWorktreesGitignored(identity.cwd);
				const { path: wtPath, branch } = worktreePaths(identity.cwd, slug);

				if (await findExistingWorktree(identity.cwd, wtPath)) {
					logEvent("worktree_create", { slug, worktree_path: wtPath, branch, reused: true });
					return {
						content: [{ type: "text" as const, text: `worktree_create: reusing existing worktree at ${wtPath} (branch ${branch})` }],
						details: { worktree_path: wtPath, branch, reused: true },
					};
				}

				// The branch itself might already exist from an earlier attempt whose
				// worktree registration didn't stick (e.g. the directory was deleted
				// by hand instead of via `git worktree remove`) — attach to it instead
				// of failing on "branch already exists".
				let branchExists = true;
				try {
					await execGit(["rev-parse", "--verify", branch], identity.cwd);
				} catch {
					branchExists = false;
				}
				if (branchExists) {
					await execGit(["worktree", "add", wtPath, branch], identity.cwd);
				} else {
					await execGit(["worktree", "add", "-b", branch, wtPath], identity.cwd);
				}

				logEvent("worktree_create", { slug, worktree_path: wtPath, branch, reused: false });
				return {
					content: [{ type: "text" as const, text: `worktree_create: created ${wtPath} on branch ${branch}. Do ALL work for this task inside that directory.` }],
					details: { worktree_path: wtPath, branch, reused: false },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("worktree_create ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return new Text(theme.fg("success", "→ ") + theme.fg("accent", d?.worktree_path ?? "?") + (d?.reused ? theme.fg("dim", " (reused)") : ""), 0, 0);
			},
		},

		// ━━ worktree_list_open (Revisione 24) ━━
		// A real incident showed a single conceptual feature (codice fiscale
		// validation) split across THREE separate worktrees/branches, created by
		// three separate planner sessions that each had no way to know an earlier
		// one had already opened (and never finalized) a worktree for what was
		// arguably the same task — see docs/notes/development-notes.md, Revisione 24, and
		// claude/e2e-codice-fiscale-analysis.md for the full transcript. Nothing
		// in this codebase persists cross-session task memory (each planner
		// session starts cold), so the fix is a cheap, always-available lookup:
		// list what's already open, in plain git terms, so a new session can
		// notice overlap BEFORE calling worktree_create and creating a fourth.
		{
			name: "worktree_list_open",
			label: "Worktree List Open",
			description:
				"List every task worktree still open (created via worktree_create, not yet merged/cleaned up via worktree_finalize " +
				"or worktree_abandon) under .worktrees/ in this project — slug, branch, when it was last touched, and (if the task's " +
				"report file exists yet) the one-line Task description from its header. Call this BEFORE worktree_create whenever a " +
				"new request MIGHT be a continuation of, or overlap with, something already in flight — especially across separate " +
				"planner sessions, which have no memory of each other's unfinished worktrees otherwise (this is exactly how one " +
				"feature ended up split across 3 separate worktrees/branches in a real incident — Revisione 24, see " +
				"docs/notes/development-notes.md). If anything here looks like the same feature as the new request, ask the user explicitly " +
				"whether to continue in that existing worktree (reuse its slug) instead of creating a new one — don't guess either way.",
			parameters: Type.Object({}),
			async execute(_callId: string, _params: Record<string, never>) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				await assertGitRepo(identity.cwd);
				const { stdout } = await execGit(["worktree", "list", "--porcelain"], identity.cwd);
				const mainReal = normalizePath(identity.cwd);
				const wtRoot = normalizePath(path.join(identity.cwd, ".worktrees"));

				const entries: Array<{ path: string; branch: string }> = [];
				let current: { path?: string; branch?: string } = {};
				for (const line of stdout.split("\n")) {
					if (line.startsWith("worktree ")) {
						if (current.path) entries.push({ path: current.path, branch: current.branch || "" });
						current = { path: line.slice("worktree ".length).trim() };
					} else if (line.startsWith("branch ")) {
						current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
					}
				}
				if (current.path) entries.push({ path: current.path, branch: current.branch || "" });

				const open: Array<{ slug: string; worktree_path: string; branch: string; last_commit: string; task: string | null }> = [];
				for (const e of entries) {
					const real = normalizePath(e.path);
					if (real === mainReal) continue; // the main checkout itself is always listed too — skip it
					if (real !== wtRoot && !real.startsWith(wtRoot + path.sep)) continue; // not one of ours (e.g. an unrelated worktree elsewhere)
					const slug = path.basename(e.path);
					let lastCommit = "(unreadable)";
					try {
						const log = await execGit(["log", "-1", "--format=%ci %s"], e.path);
						lastCommit = log.stdout.trim() || "(no commits yet)";
					} catch {
						// leave the "(unreadable)" default — e.g. a brand-new worktree with zero commits on a fresh branch
					}
					let task: string | null = null;
					try {
						const report = fs.readFileSync(reportPath(e.path, slug), "utf-8");
						const m = report.match(/^-\s*Task:\s*(.+)$/m);
						if (m) task = m[1].trim();
					} catch {
						// no report file yet — task stays null, still worth listing
					}
					open.push({ slug, worktree_path: e.path, branch: e.branch, last_commit: lastCommit, task });
				}

				const text =
					open.length === 0
						? "worktree_list_open: nessun worktree aperto al momento — via libera per crearne uno nuovo."
						: `worktree_list_open: ${open.length} worktree aperti — controlla se qualcuno di questi è la STESSA cosa della nuova richiesta prima di crearne un altro:\n\n` +
							open
								.map((o) => `- ${o.slug} (${o.branch}) — ${o.task ? `Task: ${o.task}` : "nessun report ancora"} — ultimo commit: ${o.last_commit}`)
								.join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: { open },
				};
			},
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("worktree_list_open")), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				const n = d?.open?.length ?? 0;
				return new Text(n > 0 ? theme.fg("accent", `→ ${n} open`) : theme.fg("dim", "→ none open"), 0, 0);
			},
		},

		{
			name: "finalize_evidence_collect",
			label: "Collect Finalize Evidence",
			description: "Collect one typed, idempotent finalize evidence record and bind it to the current worktree commit.",
			parameters: Type.Object({ run_id: Type.Optional(Type.String()), slug: Type.String(), kind: Type.Union([Type.Literal("test"), Type.Literal("workspace"), Type.Literal("commit"), Type.Literal("merge"), Type.Literal("push")]), source: Type.String(), observed_value: Type.Optional(Type.String()), idempotency_key: Type.String() }),
			async execute(_callId: string, params: { run_id?: string; slug: string; kind: string; source: string; observed_value?: string; idempotency_key: string }) {
				const identity = getIdentity();
				if (!identity || identity.role !== "planner") throw new Error("finalize_evidence_collect: only planner may collect finalize evidence.");
				const wt = requireWorktree(params.slug);
				const commit = (await execGit(["rev-parse", "HEAD"], wt.path)).stdout.trim();
				let observed = params.observed_value?.trim() ?? "";
				let status = "verified";
				if (params.kind === "workspace") {
					const dirty = (await execGit(["status", "--porcelain"], wt.path)).stdout.trim();
					observed = dirty ? `dirty:${dirty.slice(0, 200)}` : `clean:${commit}`;
					status = dirty ? "failed" : "verified";
				} else if (params.kind === "commit") {
					observed = commit;
				} else if (!observed) {
					throw new Error(`finalize_evidence_collect: ${params.kind} requires observed_value from its adapter.`);
				}
				const storage = ensureYanoStorage();
				const evidence = storage.recordFinalizeEvidence({ run_id: params.run_id ?? null, slug: params.slug, kind: params.kind, source: params.source, observed_value: observed, commit_hash: commit, status, idempotency_key: params.idempotency_key });
				if (status === "verified" && params.run_id) storage.recordEvent(params.run_id, "finalize_evidence_verified", { slug: params.slug, kind: params.kind, source: params.source, commit_hash: commit });
				return { content: [{ type: "text" as const, text: `finalize_evidence_collect: ${params.kind} ${status} for ${params.slug}.` }], details: { evidence: redactRuntimeProjection(evidence) } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("finalize_evidence_collect ")) + theme.fg("accent", (args as any).kind ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.evidence?.status ?? "?"), 0, 0); },
		},

		{
			name: "finalize_evidence_list",
			label: "List Finalize Evidence",
			description: "List redacted finalize evidence for a task slug.",
			parameters: Type.Object({ slug: Type.String() }),
			async execute(_callId: string, params: { slug: string }) {
				const evidence = ensureYanoStorage().listFinalizeEvidence(params.slug).map((item: any) => redactRuntimeProjection(item));
				return { content: [{ type: "text" as const, text: `${evidence.length} finalize evidence record(s) for ${params.slug}.` }], details: { evidence } };
			},
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("finalize_evidence_list ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.evidence ?? []).length)), 0, 0); },
		},

		{
			name: "worktree_finalize",
			label: "Worktree Finalize",
			description:
				"Merge a task's worktree branch back into the project's main checkout — call this ONLY once the whole " +
				"planner→coder→reviewer→planner cycle has concluded with planner satisfied (the final report is being written). " +
				"Commits anything left uncommitted in the worktree first (a safety net — coder/reviewer should already be committing " +
				"as they go), then merges task/<slug> into the current branch of the main project directory, pushes to the remote " +
				"(unless push:false), and removes the worktree. On a merge conflict, aborts the merge cleanly (main checkout is left " +
				"untouched) and leaves the worktree in place for manual resolution instead of guessing at a fix — report this to the " +
				"user rather than retrying blindly.\n\n" +
				"Revisione 42 — mandatory closing procedure, enforced here rather than left to prompt discipline alone: this call is " +
				"REFUSED unless you explicitly declare (a) user_confirmed:true — you asked the user whether this result is what they " +
					"actually wanted and they said yes, don't assume it from silence — except for a persisted pure-backend bug that " +
					"the planner explicitly classifies as deterministic and safe for automatic finalization; (b) either e2e_tests_run:true (the project's " +
				"end-to-end/full test suite was actually run as part of this task, by coder/reviewer/e2e-simulator — not by you) or " +
				"e2e_tests_skipped_reason explaining why none applies (e.g. a pure-docs task with no e2e suite to run); (c) either " +
				"version_bumped:true (the project's own version marker was bumped as part of this task) or " +
				"version_bump_skipped_reason explaining why not; (d) either docs_synced:true — a docs-sync pass (docs-sync role, or " +
				"you doing the equivalent check yourself) actually compared the project's own README/QUICK-START/architecture " +
				"diagram/any other doc that names what this task touched against the real end state and fixed what had gone stale — " +
				"or docs_sync_skipped_reason explaining why none applies (Revisione 43 — requested explicitly: a task isn't really " +
				"closed if its own documentation quietly drifted out of sync with what actually shipped). These are " +
				"self-declarations, not independently verified by this " +
				"tool — but an explicit false/lie is now on the record in the event log, instead of the step simply never having " +
				"been considered at all.\n\n" +
				"On success, if a .env with Evolution API settings is present (see .env.example, Revisione 19), this also sends a " +
				"multi-channel completion notification automatically — you don't need to call notify_all yourself for the normal " +
				"case. Pass notify_message to customize the text; otherwise a sensible default naming the task is sent. If no channel " +
				"is configured, dispatch is recorded as skipped — it never fails the actual merge.",
			parameters: Type.Object({
				slug: Type.String({ description: "Same slug passed to worktree_create for this task." }),
				commit_message: Type.Optional(Type.String({ description: "Commit message for any uncommitted changes and for the merge commit. Defaults to a generic message referencing the slug." })),
				notify_message: Type.Optional(Type.String({ description: "Custom completion message sent to all configured notification channels. Defaults to a generic one naming the task slug." })),
				user_confirmed: Type.Boolean({ description: "You explicitly asked the user to confirm this result is what they wanted, and they confirmed — required, no exceptions." }),
				automatic_backend: Type.Optional(Type.Boolean({ description: "Planner-only bug exception: true only for a persisted pure-backend, deterministic, non-destructive bug with all required tests/review green." })),
				feedback_id: Type.Optional(Type.String({ description: "Persisted BUG-... or SUG-... id when this task closes a bug/suggestion. Required with automatic_backend. When present and user_confirmed is true, the record is moved to its terminal status automatically (resolved for a bug, processed for a suggestion) — no separate CLI/API call needed." })),
				frontend_scope: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("not_applicable")])),
				agentation_review_status: Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("declined")])),
				agentation_url: Type.Optional(Type.String({ description: "The development URL shown to the user for the Agentation review." })),
				agentation_user_response: Type.Optional(Type.String({ description: "The user's explicit Agentation decision or verification response." })),
				e2e_tests_run: Type.Optional(Type.Boolean({ description: "The project's end-to-end/full test suite was actually run as part of this task." })),
				e2e_tests_skipped_reason: Type.Optional(Type.String({ description: "Required if e2e_tests_run is not true: why no e2e run applies to this task." })),
				version_bumped: Type.Optional(Type.Boolean({ description: "The project's own version marker (package.json or equivalent) was bumped as part of this task." })),
				version_bump_skipped_reason: Type.Optional(Type.String({ description: "Required if version_bumped is not true: why no version bump applies to this task." })),
				docs_synced: Type.Optional(Type.Boolean({ description: "A docs-sync pass actually compared the project's own README/QUICK-START/architecture diagram/other docs against the real end state of this task and fixed anything stale." })),
				docs_sync_skipped_reason: Type.Optional(Type.String({ description: "Required if docs_synced is not true: why no docs-sync pass applies to this task." })),
				run_id: Type.Optional(Type.String({ description: "Run id returned by run_create for this task; when supplied, records the run as finalized after the merge. Always pass it for ticket/DAG runs." })),
				push: Type.Optional(Type.Boolean({ description: "Push the main branch to its remote after a successful merge. Defaults to true — set false only if you deliberately don't want this task pushed yet." })),
			}),
			async execute(_callId: string, params: any) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const slug = params.slug;
				if (!SLUG_RE.test(slug)) throw new Error(`worktree_finalize: "${slug}" is not a valid kebab-case slug.`);
				let automaticBackendBug = false;
				if (params.automatic_backend) {
					if (!params.feedback_id?.startsWith("BUG-")) throw new Error("worktree_finalize: automatic_backend richiede feedback_id BUG-...");
					const feedbackDb = openFeedbackDatabase();
					try { automaticBackendBug = listFeedback(feedbackDb, { type: "bug" }).some((item: any) => item.id === params.feedback_id && item.project_id === identity.project && item.status === "processing"); }
					finally { feedbackDb.close(); }
					if (!automaticBackendBug) throw new Error("worktree_finalize: automatic_backend richiede un bug persistito del progetto nello stato processing.");
				}
				if (!params.user_confirmed && !automaticBackendBug) {
					throw new Error(
						"worktree_finalize: refused — user_confirmed must be true. Ask the user explicitly whether this task's result " +
							"is what they wanted BEFORE finalizing (Revisione 42) — don't assume completion just because every ticket is " +
							"done. Once they've confirmed, call this again with user_confirmed: true.",
					);
				}
				if (params.frontend_scope === "required") {
					if (!params.agentation_review_status || !params.agentation_user_response?.trim()) {
						throw new Error("worktree_finalize: refused — frontend_scope=required needs an explicit Agentation answer: ask the user to review the development URL, then pass agentation_review_status=verified or declined and agentation_user_response.");
					}
					if (params.agentation_review_status === "verified" && !params.agentation_url?.trim()) {
						throw new Error("worktree_finalize: refused — agentation_review_status=verified requires the development agentation_url shown to the user.");
					}
				}
				if (!params.e2e_tests_run && !params.e2e_tests_skipped_reason) {
					throw new Error(
						"worktree_finalize: refused — pass e2e_tests_run:true (the project's end-to-end/full test suite actually ran) " +
							"or e2e_tests_skipped_reason explaining why none applies to this task (Revisione 42 — a completed task now " +
							"needs this decision made explicit, not silently skipped).",
					);
				}
				if (!params.version_bumped && !params.version_bump_skipped_reason) {
					throw new Error(
						"worktree_finalize: refused — pass version_bumped:true (the project's own version marker was bumped as part of " +
							"this task) or version_bump_skipped_reason explaining why not (Revisione 42).",
					);
				}
				if (!params.docs_synced && !params.docs_sync_skipped_reason) {
					throw new Error(
						"worktree_finalize: refused — pass docs_synced:true (a docs-sync pass compared the project's own docs against " +
							"what this task actually shipped and fixed anything stale) or docs_sync_skipped_reason explaining why none " +
							"applies to this task (Revisione 43).",
					);
				}
				logEvent("worktree_finalize_checklist", {
					slug,
					user_confirmed: params.user_confirmed,
					automatic_backend: automaticBackendBug,
					feedback_id: params.feedback_id ?? null,
					frontend_scope: params.frontend_scope ?? "not_applicable",
					agentation_review_status: params.agentation_review_status ?? null,
					agentation_url: params.agentation_url ?? null,
					agentation_user_response: params.agentation_user_response ?? null,
					e2e_tests_run: !!params.e2e_tests_run,
					e2e_tests_skipped_reason: params.e2e_tests_skipped_reason ?? null,
					version_bumped: !!params.version_bumped,
					version_bump_skipped_reason: params.version_bump_skipped_reason ?? null,
					docs_synced: !!params.docs_synced,
					docs_sync_skipped_reason: params.docs_sync_skipped_reason ?? null,
				});
				await assertGitRepo(identity.cwd);
				const { path: wtPath, branch } = worktreePaths(identity.cwd, slug);

				if (!(await findExistingWorktree(identity.cwd, wtPath))) {
					throw new Error(`worktree_finalize: no worktree found for slug "${slug}" at ${wtPath} — was worktree_create ever called for this task?`);
				}
				// Validate the association before any commit, merge, worktree removal or
				// notification. A bad run id must be a harmless rejected call, never a
				// successful merge followed by an exception while updating SQLite.
				const finalizationStorage = params.run_id ? ensureYanoStorage() : null;
				if (params.run_id && !finalizationStorage?.getRun(params.run_id)) {
					throw new Error(`worktree_finalize: run_id "${params.run_id}" non trovato.`);
				}

				// Revisione 24: a real incident traced a messy merge-conflict back to
				// the MAIN checkout itself having uncommitted changes (almost
				// certainly from applying a project update by copying files in
				// without committing) at the exact moment a worktree merge was
				// attempted — the two collided. Refuse up front instead of merging
				// into a dirty tree and producing a conflict (or worse, a "clean"
				// merge that quietly mixes two unrelated changes together). This is
				// a genuine block that needs a human decision (commit? stash?
				// discard?) — not something safe to guess past, so it's paired with
				// a WhatsApp notification like every other blocking case below.
				const mainStatus = await execGit(["status", "--porcelain"], identity.cwd);
				if (mainStatus.stdout.trim().length > 0) {
					logEvent("worktree_finalize", { slug, worktree_path: wtPath, branch, merged: false, conflict: false, blocked_dirty_main: true });
					const notifyText =
						`⚠️ Task "${slug}": merge bloccato — la directory principale del progetto ha modifiche non committate. ` +
						"Serve una decisione dell'utente prima di continuare.";
					const notifyResult = await sendNotifications(notifyText);
					logEvent("notification_dispatch", { slug, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels, reason: "dirty_main_blocked_finalize" });
					return {
						content: [{
							type: "text" as const,
							text:
								`worktree_finalize: BLOCCATO — la directory principale del progetto (${identity.cwd}) ha modifiche non committate:\n\n${mainStatus.stdout}\n` +
								"Il merge non viene tentato: mischiare queste modifiche con quelle del worktree potrebbe produrre un conflitto fuorviante, " +
								"o peggio un merge \"pulito\" che in realtà mescola due cose diverse senza che nessuno se ne accorga. Committa o metti da " +
								"parte (git stash) queste modifiche nella directory principale, poi richiama worktree_finalize — il worktree resta intatto " +
								"nel frattempo." +
								(notifyResult.ok ? " (Notifiche inviate ai canali configurati.)" : ` (Nessun canale ha inviato la notifica: ${notifyResult.detail}.)`),
						}],
						details: { merged: false, conflict: false, blocked_dirty_main: true, worktree_path: wtPath, branch },
					};
				}

				const message = params.commit_message || `Task ${slug}: completed and verified`;

				// The lock registry (file_claim/file_release) is ephemeral coordination
				// state for agents working this worktree in parallel — it has no
				// business landing in the main project once the task is done, so it's
				// removed before the safety-net commit below picks it up.
				try {
					fs.rmSync(locksPath(wtPath), { force: true });
				} catch {
					/* best-effort — a leftover lock file is harmless clutter, not worth failing finalize over */
				}

				const status = await execGit(["status", "--porcelain"], wtPath);
				if (status.stdout.trim().length > 0) {
					await execGit(["add", "-A"], wtPath);
					await execGit(["commit", "-m", message], wtPath);
				}

				try {
					await execGit(["merge", "--no-ff", branch, "-m", `Merge ${branch}: ${message}`], identity.cwd);
				} catch (err) {
					// Revisione 24: list which files actually conflicted BEFORE
					// aborting — `git diff --name-only --diff-filter=U` only works
					// while the merge is still mid-conflict, so this must run first.
					// Reporting this up front (instead of just the raw git error text)
					// is what a human resolving it manually actually needs first.
					let conflictFiles: string[] = [];
					try {
						const diffResult = await execGit(["diff", "--name-only", "--diff-filter=U"], identity.cwd);
						conflictFiles = diffResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
					} catch {
						// best-effort — falls back to the raw git error message below
					}
					try { await execGit(["merge", "--abort"], identity.cwd); } catch { /* nothing to abort */ }
					logEvent("worktree_finalize", { slug, worktree_path: wtPath, branch, merged: false, conflict: true, conflict_files: conflictFiles });
					const fileList = conflictFiles.length > 0 ? conflictFiles.map((f) => `  - ${f}`).join("\n") : "(nessun file identificato automaticamente — vedi il messaggio git sotto)";
					const notifyText = `⚠️ Task "${slug}": CONFLITTO di merge — richiede risoluzione manuale.\nFile in conflitto:\n${fileList}\nWorktree: ${wtPath}`;
					const notifyResult = await sendNotifications(notifyText);
					logEvent("notification_dispatch", { slug, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels, reason: "merge_conflict" });
					return {
						content: [{
							type: "text" as const,
							text:
								`worktree_finalize: MERGE CONFLICT merging ${branch} — aborted cleanly, the main checkout is untouched. ` +
								`The worktree is left at ${wtPath} for manual resolution.\n\nFile in conflitto:\n${fileList}\n\n` +
								`${err instanceof Error ? err.message : String(err)}\n\n` +
								"Dopo una risoluzione MANUALE (fuori da worktree_finalize), chiama worktree_abandon per registrare cosa è successo nel " +
								"report e rimuovere il worktree ormai orfano — altrimenti resta lì per sempre, come nell'incidente che ha portato a " +
								"questo cambiamento (Revisione 24)." +
								(notifyResult.ok ? " (Notifiche inviate ai canali configurati.)" : ` (Nessun canale ha inviato la notifica: ${notifyResult.detail}.)`),
						}],
						details: { merged: false, conflict: true, worktree_path: wtPath, branch, conflict_files: conflictFiles },
					};
				}

				// The merge succeeded, so everything tracked is now safely on the main
				// branch. `git worktree remove` still refuses if the worktree has any
				// untracked leftover files (build artifacts, logs) — harmless to force
				// past at this point since nothing meaningful could still be sitting
				// there uncommitted.
				try {
					await execGit(["worktree", "remove", wtPath], identity.cwd);
				} catch {
					await execGit(["worktree", "remove", "--force", wtPath], identity.cwd);
				}

				logEvent("worktree_finalize", { slug, worktree_path: wtPath, branch, merged: true, conflict: false });
				// Revisione 66 — before this, only the automatic_backend bug path ever
				// closed a feedback record (and it wrote 'processed', which yano
				// dash's Bug tab doesn't even have a column for — an auto-finalized
				// bug silently vanished from its own Kanban board instead of
				// showing as resolved).
				// Any confirmed finalize that names a feedback_id now closes it too,
				// with the status its own dashboard actually expects.
				if (params.feedback_id && (automaticBackendBug || params.user_confirmed)) {
					const feedbackDb = openFeedbackDatabase();
					try { feedbackDb.prepare("UPDATE feedback SET status=?,updated_at=? WHERE id=?").run(terminalStatusForFeedbackId(params.feedback_id), nowIso(), params.feedback_id); }
					finally { feedbackDb.close(); }
				}
				if (params.run_id && finalizationStorage) {
					finalizationStorage.updateRunFinalizationStatus(params.run_id, "finalized");
				}

				// Revisione 42 — "push" is the missing last step of the closing
				// procedure the operator asked for: worktree_finalize merged into the
				// main checkout's CURRENT branch already, but never pushed it to the
				// remote, so "commit, push" only ever happened if the planner
				// remembered to run git push by hand afterwards. Defaults to true
				// (the new standard closing behavior); best-effort and NEVER allowed
				// to affect the merge result above, which has already happened
				// regardless — a missing/unreachable remote, no upstream configured,
				// or a rejected push (e.g. someone else pushed first) is reported back
				// in the text, not thrown, so a planner working on a project with no
				// remote at all (a fresh yano init before the user ever added one)
				// doesn't get a merge it can't recover from.
				let pushResult: { ok: boolean; detail: string } = { ok: false, detail: "push:false — non richiesto" };
				if (params.push !== false) {
					try {
						const currentBranch = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], identity.cwd);
						await execGit(["push", "origin", currentBranch.stdout.trim()], identity.cwd);
						pushResult = { ok: true, detail: "push riuscito" };
					} catch (err) {
						pushResult = { ok: false, detail: err instanceof Error ? err.message : String(err) };
					}
					logEvent("worktree_finalize_push", { slug, ok: pushResult.ok, detail: pushResult.detail });
				}
				if (params.run_id && finalizationStorage) {
					finalizationStorage.recordEvent(params.run_id, "run_finalized", { slug, branch, pushed: pushResult.ok });
				}

				// Multi-channel completion notification — best-effort, only
				// on the success path, never allowed to affect the merge result above
				// (which has already happened by this point regardless of what
				// follows). Silently skipped per channel if .env isn't configured for
				// this project — see sendNotifications().
				const notifyText = params.notify_message || `✅ Task "${slug}" completato e verificato — unito nel progetto.`;
				const notifyResult = await sendNotifications(notifyText);
				logEvent("notification_dispatch", { slug, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels });
				try {
					const mergedReportFile = reportPath(identity.cwd, slug); // now in the main checkout, not the (removed) worktree
					if (fs.existsSync(mergedReportFile)) {
						const line = `\n> _[evento] notifica multi-canale fine task — ${notifyResult.ok ? "inviata" : `non inviata (${notifyResult.detail})`} alle ${nowIso()}_\n`;
						fs.appendFileSync(mergedReportFile, line);
					}
				} catch {
					// best-effort — see comment above
				}

				return {
					content: [{
						type: "text" as const,
						text: `worktree_finalize: merged ${branch} into the main checkout and removed the worktree.` +
							(params.push === false ? " Push saltato (push:false)." : pushResult.ok ? " Push al remote riuscito." : ` Push NON riuscito: ${pushResult.detail}.`) +
							(notifyResult.ok ? " Notifications sent to configured channels." : ` (No notification channel sent the message: ${notifyResult.detail})`),
					}],
					details: { merged: true, conflict: false, worktree_path: wtPath, branch, notifications: notifyResult.channels, notified: notifyResult.ok, pushed: pushResult.ok },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("worktree_finalize ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				if (d?.merged) return new Text(theme.fg("success", "✓ merged & cleaned up"), 0, 0);
				if (d?.blocked_dirty_main) return new Text(theme.fg("error", "✗ blocked — main checkout is dirty"), 0, 0);
				return new Text(theme.fg("error", "✗ conflict — left for manual resolution"), 0, 0);
			},
		},

		// ━━ worktree_abandon (Revisione 24) ━━
		// A real incident: a merge conflict on worktree_finalize was resolved
		// manually by cherry-picking files straight into main with
		// `git checkout <branch> -- <files>`, entirely bypassing worktree_finalize
		// — which meant nothing ever ran `git worktree remove` or `git branch -D`,
		// leaving an orphaned worktree/branch sitting around indefinitely (see
		// docs/notes/development-notes.md, Revisione 24). This tool is the cleanup step for
		// exactly that path: once a human (or the planner, told by a human) has
		// confirmed the work already landed in main some other way, this closes
		// the loop — preserves the report, removes the worktree, optionally
		// deletes the now-redundant branch. It deliberately never touches main's
		// history itself (no merge, no commit there) — that already happened.
		{
			name: "worktree_abandon",
			label: "Worktree Abandon",
			description:
				"Clean up a task's worktree WITHOUT attempting a merge — use this only AFTER the work was already integrated into " +
				"the main checkout some other way (e.g. a human manually resolved a worktree_finalize merge conflict outside the " +
				"tool, or the task was abandoned outright and nothing needs to land in main). Unlike worktree_finalize, this never " +
				"touches the main checkout's git history — it only preserves the task's report (copying it into the main checkout's " +
				"reports/<slug>.md first if it isn't already there, so the record of what happened isn't lost) and removes the " +
				"worktree (and, by default, the branch). Refuses outright if the worktree still has UNCOMMITTED changes, to avoid " +
				"silently discarding work — commit or discard them first, or use worktree_finalize instead if this should actually " +
				"be merged normally. Exists because of a real incident (Revisione 24, see docs/notes/development-notes.md) where a manual merge- " +
				"conflict resolution bypassed worktree_finalize entirely and left an orphaned worktree with nothing to ever clean " +
				"it up.",
			parameters: Type.Object({
				slug: Type.String({ description: "Same slug passed to worktree_create for this task." }),
				reason: Type.Optional(Type.String({ description: "One line explaining why this worktree is being closed outside the normal finalize flow, e.g. \"resolved manually via git checkout <branch> -- <files>, see report for details\"." })),
				delete_branch: Type.Optional(Type.Boolean({ description: "Also force-delete the task/<slug> branch (it may not be reachable from main's history after a manual/partial merge, so a plain delete could fail — this force-deletes). Defaults to true." })),
			}),
			async execute(_callId: string, params: { slug: string; reason?: string; delete_branch?: boolean }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const slug = params.slug;
				if (!SLUG_RE.test(slug)) throw new Error(`worktree_abandon: "${slug}" is not a valid kebab-case slug.`);
				await assertGitRepo(identity.cwd);
				const { path: wtPath, branch } = worktreePaths(identity.cwd, slug);
				if (!(await findExistingWorktree(identity.cwd, wtPath))) {
					throw new Error(`worktree_abandon: no worktree found for slug "${slug}" at ${wtPath}.`);
				}
				const status = await execGit(["status", "--porcelain"], wtPath);
				if (status.stdout.trim().length > 0) {
					throw new Error(
						`worktree_abandon: ${wtPath} still has uncommitted changes — refusing to remove it and risk losing work. ` +
							"Commit or discard those changes first (or call worktree_finalize instead if this should actually be merged).",
					);
				}

				const reason = params.reason || "closed outside the normal worktree_finalize flow";
				try {
					const src = reportPath(wtPath, slug);
					const dest = reportPath(identity.cwd, slug);
					if (fs.existsSync(src) && !fs.existsSync(dest)) {
						fs.mkdirSync(path.dirname(dest), { recursive: true });
						fs.copyFileSync(src, dest);
					}
					if (fs.existsSync(dest)) {
						fs.appendFileSync(dest, `\n> _[evento] worktree abbandonato (non tramite worktree_finalize) — ${reason} — alle ${nowIso()}_\n`);
					}
				} catch {
					// best-effort — never let report bookkeeping block the actual cleanup below
				}

				try {
					await execGit(["worktree", "remove", wtPath], identity.cwd);
				} catch {
					await execGit(["worktree", "remove", "--force", wtPath], identity.cwd);
				}

				const deleteBranch = params.delete_branch ?? true;
				let branchDeleted = false;
				if (deleteBranch) {
					try {
						await execGit(["branch", "-D", branch], identity.cwd);
						branchDeleted = true;
					} catch {
						// best-effort — a leftover branch is harmless clutter, unlike a leftover worktree directory
					}
				}

				logEvent("worktree_abandon", { slug, worktree_path: wtPath, branch, reason, branch_deleted: branchDeleted });
				const notifyResult = await sendNotifications(`ℹ️ Task "${slug}": worktree chiuso manualmente (${reason}) — non tramite il normale merge automatico.`);
				logEvent("notification_dispatch", { slug, ok: notifyResult.ok, detail: notifyResult.detail, channels: notifyResult.channels, reason: "worktree_abandon" });

				return {
					content: [{
						type: "text" as const,
						text:
							`worktree_abandon: removed ${wtPath}${branchDeleted ? ` and deleted branch ${branch}` : ""}. ` +
							`Report preserved at ${reportPath(identity.cwd, slug)} if it existed.`,
					}],
					details: { worktree_path: wtPath, branch, branch_deleted: branchDeleted },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("worktree_abandon ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
			},
			renderResult(_result: any, _options: unknown, theme: Theme) {
				return new Text(theme.fg("success", "✓ worktree removed"), 0, 0);
			},
		},
	];
}
