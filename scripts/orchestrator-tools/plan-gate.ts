// Fase 5 / M1 — the "plan-gate" cluster, extracted verbatim from
// extensions/orchestrator.ts: fs-backed lock CRUD + the structured
// execution-plan phase gate (Revisione 21). Zero SQLite, zero client/T
// MQTT, a single closure dependency (`identity`, only inside
// requireWorktree's `identity!.cwd` — injected as a getter, same pattern
// as every other Fase 4/5 module). Consumed by: plan_set/plan_advance/
// plan_get/file_claim/file_release (the "owners", moved into
// scripts/orchestrator-tools/plan.ts, Fase 5/M4), and — much more thinly —
// by agent_send (Fase 5/M6), playbook_reconcile (Fase 5/M5), and
// finalize_evidence_collect (part of scripts/orchestrator-tools/worktree.ts,
// Fase 5/M3), which import straight from this module rather than having
// these re-injected as deps (they're pure functions of their own
// parameters once `identity` is captured via getIdentity here).
import fs from "node:fs";
import path from "node:path";
import { SLUG_RE, worktreePaths } from "./git-worktree.ts";
import { yanoSubdirs, yanoWorkspaceDir } from "./yano-workspace.ts";

function nowIso(): string {
	return new Date().toISOString();
}

export type PlanGateDeps = {
	getIdentity: () => { cwd: string } | null;
};

// ━━ Shared-worktree coordination: report_append + file_claim/file_release ━━
//
// Once the planner can bring several specialists into the SAME worktree at
// once (Revisione 15), two concrete collision risks appear that plain file
// Read/Write tools don't protect against:
//  1. Two agents both read the report file, each append their own section
//     to their own in-memory copy, then both write the whole file back —
//     the second write silently clobbers the first agent's section (a
//     classic lost-update race), even though neither agent did anything
//     wrong on its own.
//  2. Two agents editing the same SOURCE file at once can overwrite each
//     other's changes the same way, with no signal to either that it
//     happened.
// report_append fixes (1) with a real OS-level append instead of read-
// modify-write. file_claim/file_release provide an ADVISORY lock for (2)
// — advisory means it only works if agents check it, which the updated
// prompts now instruct them to do; it cannot force good behavior out of
// an agent that ignores it, the same limit any file lock has in a system
// without a kernel-enforced mandatory lock.

// Revisione 37: spostato da `<worktreePath>/reports/<slug>.md` (root del
// progetto o del worktree, tracciato da git) a
// `<worktreePath>/.pi/extensions/yano-orchestrator/reports/<slug>.md`
// (gitignored) — stessa logica di logsDir()/yanoSubdirs più sopra: i
// report sono reportistica di sviluppo di QUESTO progetto, non
// deliverable applicativo, e non devono finire in un repo pubblico.
// worktreePath può essere sia un worktree attivo (`.worktrees/<slug>`)
// sia identity.cwd dopo il merge — in entrambi i casi risolve dentro il
// `.pi/...` di quella specifica directory, quindi il codice più sotto
// che copia da wtPath a identity.cwd dopo il merge continua a funzionare
// invariato.
export function reportsDir(base: string): string {
	return yanoSubdirs(yanoWorkspaceDir(base)).reports;
}

export function reportPath(worktreePath: string, slug: string): string {
	return path.join(reportsDir(worktreePath), `${slug}.md`);
}

export function locksPath(worktreePath: string): string {
	return path.join(worktreePath, ".orchestrator-locks.json");
}

export interface FileLock {
	file: string;
	holder: string;
	claimed_at: string;
	ttl_minutes: number;
}

export function readLocks(worktreePath: string): FileLock[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(locksPath(worktreePath), "utf-8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function writeLocks(worktreePath: string, locks: FileLock[]): void {
	fs.writeFileSync(locksPath(worktreePath), JSON.stringify(locks, null, 2));
}

export function lockExpired(lock: FileLock): boolean {
	return Date.now() - new Date(lock.claimed_at).getTime() > lock.ttl_minutes * 60_000;
}

export function assertSafeRelativeFile(file: string): void {
	if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
		throw new Error(`"${file}" must be a relative path inside the worktree (no leading "/", no "..").`);
	}
}

export function createRequireWorktree(deps: PlanGateDeps) {
	return function requireWorktree(slug: string): { path: string; branch: string } {
		if (!SLUG_RE.test(slug)) throw new Error(`"${slug}" is not a valid kebab-case slug.`);
		const identity = deps.getIdentity();
		const wt = worktreePaths(identity!.cwd, slug);
		if (!fs.existsSync(wt.path)) throw new Error(`No worktree found for slug "${slug}" at ${wt.path} — call worktree_create first.`);
		return wt;
	};
}

// ━━ Structured execution plan + deterministic phase gate (Revisione 21) ━━
// Revisione 18 introduced the phase-plan CONCEPT, but only as free-form
// markdown (reports/<slug>.plan.md) the LLM planner writes and re-reads by
// eye — nothing in the code ever checks it. That's how a real test (see
// Revisione 20 analysis, claude/e2e-codice-fiscale-analysis.md) produced a
// planner that scheduled a specialist (tdd-agent) in a phase BEFORE coder,
// violating "coder is always phase 1" — a rule that only lived in prose,
// so nothing stopped it from being violated. This section makes the plan
// a small structured file the code can actually read and enforce, on top
// of (not instead of) the human-readable .plan.md, which plan_set/
// plan_advance now render automatically instead of the planner writing it
// by hand.
//
// The enforcement itself lives in TWO places, deliberately:
//  1. plan_set validates STRUCTURE at declaration time: phase 1 must
//     include "coder", no role may appear in more than one phase. This
//     is what actually prevents the tdd-agent-before-coder case: a plan
//     that puts it in an earlier phase is rejected before it's ever
//     acted on, not caught after the fact.
//  2. agent_send validates TIMING at send time: a send addressed to a
//     role that belongs to a locked (not-yet-unlocked) phase is refused
//     outright, for ANY sender — not just the planner — because gating
//     only the planner's own sends wouldn't catch every path a message
//     could take.
// Both are best-effort in the sense that they only apply when a
// structured plan exists for the slug (plan_set was called) — ad hoc/
// user-direct flows that never call it are completely ungated, exactly
// as before this revision.
export type PlanPhaseStatus = "locked" | "unlocked" | "complete";
export interface PlanPhase {
	phase: number;
	roles: string[];
	note?: string;
	status: PlanPhaseStatus;
}
export interface Plan {
	slug: string;
	phases: PlanPhase[];
	created_at: string;
	updated_at: string;
}

export function planPath(worktreePath: string, slug: string): string {
	return path.join(reportsDir(worktreePath), `${slug}.plan.json`);
}

export function planMarkdownPath(worktreePath: string, slug: string): string {
	return path.join(reportsDir(worktreePath), `${slug}.plan.md`);
}

export function readPlan(worktreePath: string, slug: string): Plan | null {
	try {
		const raw = fs.readFileSync(planPath(worktreePath, slug), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.phases)) return parsed as Plan;
		return null;
	} catch {
		return null;
	}
}

export function renderPlanMarkdown(plan: Plan): string {
	const icon: Record<PlanPhaseStatus, string> = { complete: "[x]", unlocked: "[~]", locked: "[ ]" };
	const label: Record<PlanPhaseStatus, string> = { complete: "completa", unlocked: "sbloccata — in corso", locked: "bloccata, in attesa della fase precedente" };
	const lines = [
		`# Piano di esecuzione: ${plan.slug}`,
		"",
		"Una fase parte solo quando TUTTI i ruoli della fase precedente hanno",
		"segnalato il completamento. Ruoli nella STESSA fase partono insieme.",
		"Generato automaticamente da plan_set/plan_advance (Revisione 21) — non",
		"modificare a mano, lo stato reale è in .plan.json accanto a questo file.",
		"",
	];
	for (const p of plan.phases) {
		lines.push(`- ${icon[p.status]} Fase ${p.phase} (${label[p.status]}): ${p.roles.join(", ")}`);
		if (p.note) lines.push(`      ${p.note}`);
	}
	return lines.join("\n") + "\n";
}

export function writePlan(worktreePath: string, slug: string, plan: Plan): void {
	fs.mkdirSync(path.dirname(planPath(worktreePath, slug)), { recursive: true });
	fs.writeFileSync(planPath(worktreePath, slug), JSON.stringify(plan, null, 2));
	fs.writeFileSync(planMarkdownPath(worktreePath, slug), renderPlanMarkdown(plan));
}

// Best-effort audit line in the task's report, same spirit as report_append/
// agent_send's own auto-footer (Revisione 19) — never lets a report-
// bookkeeping problem fail the plan operation itself.
export function appendPlanAudit(worktreePath: string, slug: string, text: string): void {
	try {
		const file = reportPath(worktreePath, slug);
		if (fs.existsSync(file)) {
			fs.appendFileSync(file, `\n> _[evento] ${text} — alle ${nowIso()}_\n`);
		}
	} catch {
		// best-effort — see comment above
	}
}

// Which phase (if any) a given role belongs to in this plan — used both
// by plan_set's own validation and by agent_send's runtime gate.
export function findPhaseForRole(plan: Plan, role: string): PlanPhase | undefined {
	const normalized = role.trim().toLowerCase();
	return plan.phases.find((p) => p.roles.some((r) => r.trim().toLowerCase() === normalized));
}

// Phase ordering alone does not prevent shortcuts when coder and reviewer
// share a phase. Keep the core code handoff deterministic while also
// recognising the dedicated refactor coding role.
export function createAssertRoleHandoffAllowed(deps: PlanGateDeps) {
	const requireWorktree = createRequireWorktree(deps);
	return function assertRoleHandoffAllowed(senderRole: string, targetRole: string, slug: string): void {
		const sender = senderRole.trim().toLowerCase();
		const target = targetRole.trim().toLowerCase();
		const backendRoles = new Set(["coder", "reviewer"]);
		const refactorRoles = new Set(["refactoring-specialist"]);
		const frontendRoles = new Set(["frontend-developer", "frontend-reviewer"]);
		const coreRoles = new Set(["planner", ...backendRoles, ...frontendRoles]);
		if (!coreRoles.has(target) && !refactorRoles.has(target)) return;
		const isRefactorPlan = (() => {
			try {
				const wt = requireWorktree(slug);
				const plan = readPlan(wt.path, slug);
				return !!plan?.phases.some((p) => p.roles.some((r) => r.trim().toLowerCase() === "refactoring-specialist"));
			} catch {
				return false;
			}
		})();
		const isCleanRepoPlan = (() => {
			try {
				const wt = requireWorktree(slug);
				const plan = readPlan(wt.path, slug);
				return !!plan?.phases.some((p) => p.roles.some((r) => r.trim().toLowerCase() === "repo-curator"));
			} catch {
				return false;
			}
		})();
		const allowed = target === "planner"
			? sender === "reviewer" || sender === "frontend-reviewer" || sender === "full-stack-reviewer" || !coreRoles.has(sender)
			: target === "reviewer"
				? sender === "coder" || sender === "refactoring-specialist" || (sender === "planner" && (isRefactorPlan || isCleanRepoPlan))
				: target === "refactoring-specialist"
					? sender === "planner" || sender === "reviewer"
				: target === "frontend-reviewer"
					? sender === "frontend-developer"
					: sender === "planner" || sender === "reviewer" || sender === "frontend-reviewer";
		if (!allowed) {
			throw new Error(
				`agent_send: refused — handoff ${senderRole} → ${targetRole} is not allowed for "${slug}". ` +
				"The enforced paths are planner → coder → reviewer → planner, planner → refactoring-specialist → reviewer → planner, " +
				"planner → repo-curator → reviewer → planner for clean-repo; and " +
				"planner → frontend-developer → frontend-reviewer → planner; " +
				"planner → full-stack-developer → full-stack-reviewer → planner; " +
				"each reviewer may return corrections only to its matching developer role.",
			);
		}
	};
}
