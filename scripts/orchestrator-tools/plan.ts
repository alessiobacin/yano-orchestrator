// Fase 5 / M4 — plan_set/plan_advance/plan_get/report_append/file_claim/
// file_release, extracted from extensions/orchestrator.ts. These are the
// "owners" of the plan-gate cluster's typed core (Plan/PlanPhase/FileLock),
// so they import directly from plan-gate.ts (Fase 5/M1) — pure functions,
// no wrapping needed, same reasoning as worktree.ts (Fase 5/M3).
// requireWorktree closes over identity via its own getter, already built
// once in orchestrator.ts, passed here as a direct function reference.
// ensureYanoStorage/logEvent/agentStatusSnapshot are closure functions
// already correctly bound at their own definition site in orchestrator.ts —
// passed as direct references, same pattern as every Fase 4/5 module.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { assertSafeRelativeFile, lockExpired, readLocks, readPlan, renderPlanMarkdown, reportPath, writeLocks, writePlan, appendPlanAudit } from "./plan-gate.ts";
import type { Plan, PlanPhase, PlanPhaseStatus } from "./plan-gate.ts";

function nowIso(): string {
	return new Date().toISOString();
}

export interface Identity {
	role: string;
	cwd: string;
	project: string;
	instance: string;
	capacity?: number;
}

export interface PlanToolsDeps {
	getIdentity: () => Identity | null;
	requireWorktree: (slug: string) => { path: string; branch: string };
	ensureYanoStorage: () => OrchestratorStorage;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	agentStatusSnapshot: () => string;
}

export function createPlanTools(deps: PlanToolsDeps) {
	const { getIdentity, requireWorktree, ensureYanoStorage, logEvent, agentStatusSnapshot } = deps;
	return [
		{
			name: "plan_set",
			label: "Plan Set",
			description:
				"Declare (or replace) a task's execution plan as an ordered list of phases — planner-only. Replaces writing " +
				"reports/<slug>.plan.md by hand (Revisione 18): this tool renders that file for you AND, unlike the hand-written " +
				"version, is actually enforced by agent_send (Revisione 21) — a send addressed to a role in a phase that isn't " +
				"unlocked yet is refused outright, for any sender, not just you. Phase 1 MUST include \"coder\" for the general " +
				"backend-change playbook, \"refactoring-specialist\" for the refactor playbook, or \"repo-curator\" for clean-repo (their reviewer follows in a later " +
				"phase) — this is what stops a plan from " +
				"ever scheduling a specialist BEFORE coder, which happened in a real test (see docs/notes/development-notes.md, Revisione 20). " +
				"ONE exception: phase 1 may be [\"tdd-agent\"] alone (genuine TDD — tests written before implementation), but only " +
				"if \"coder\" is then in phase 2. The LAST phase MUST include \"docs-sync\" (Revisione 24) — every task plan ends " +
				"with a documentation pass, not just optionally. A role may appear in only one phase. " +
				"Phase 1 starts unlocked automatically; later phases start locked until you call plan_advance on the phase before " +
				"them. Calling this again for the same slug preserves the status of phases that are unchanged (same phase number " +
				"and same roles) — including ones already marked complete — so you can extend a plan mid-task without losing " +
				"progress on phases already underway.",
			parameters: Type.Object({
				slug: Type.String({ description: "Task slug — same one used for worktree_create." }),
				phases: Type.Array(
					Type.Object({
						roles: Type.Array(Type.String(), { description: "Roles that work together in this phase, e.g. [\"coder\", \"reviewer\"] or [\"security-evaluator\", \"openapi-writer\"]." }),
						note: Type.Optional(Type.String({ description: "One line explaining why these roles are in this phase / this position." })),
					}),
					{ description: "Ordered phases, phase 1 first. Phase numbers are implied by array position (1-indexed)." },
				),
			}),
			async execute(_callId: string, params: { slug: string; phases: Array<{ roles: string[]; note?: string }> }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") {
					throw new Error(`plan_set: only the planner role may declare a task's execution plan (this instance is "${identity.role}").`);
				}
				if (params.phases.length === 0) throw new Error("plan_set: phases must have at least one entry.");
				for (const p of params.phases) {
					if (p.roles.length === 0) throw new Error("plan_set: every phase needs at least one role.");
				}
				// Revisione 21 follow-up: exactly one exception to "coder is always
				// phase 1" — genuine TDD (tdd-agent writes the test suite BEFORE
				// coder implements against it, per its own brief in agents/roles.yaml).
				// Deliberately narrow: phase 1 must be tdd-agent ALONE (no other role
				// riding along) so this can't be stretched into the exact loophole the
				// original rule was hardened against (an arbitrary specialist arguing
				// it "doesn't depend on the new code" to justify a phase before coder
				// — see docs/notes/development-notes.md, Revisione 20) — and coder must then be the
				// very next phase, so it's never more than one phase away.
				const phase1Roles = params.phases[0].roles.map((r) => r.trim().toLowerCase());
				const isTddOnlyPhase1 = phase1Roles.length === 1 && phase1Roles[0] === "tdd-agent";
				const hasDedicatedRefactorCoder = phase1Roles.includes("refactoring-specialist");
				// clean-repo has no generic coder: repo-curator is its dedicated
				// execution role and owns the approved file removals/relocations.
				// Treat it like refactoring-specialist for the phase-1 structural
				// gate, otherwise the clean-repo playbook can never advance from its
				// mandatory plan_set gate despite requiring a worktree and tickets.
				const hasDedicatedCleanupCoder = phase1Roles.includes("repo-curator");
				if (!phase1Roles.includes("coder") && !hasDedicatedRefactorCoder && !hasDedicatedCleanupCoder && !isTddOnlyPhase1) {
					throw new Error(
						'plan_set: phase 1 must include "coder" (or the dedicated refactor/cleanup role "refactoring-specialist"/"repo-curator") — a coding role is always phase 1, no phase may precede it (see prompts/planner.md). ' +
							'The ONE exception: phase 1 may be "tdd-agent" ALONE (genuine TDD, tests before implementation), with "coder" ' +
							'required in phase 2 right after. For the refactor playbook, put "refactoring-specialist" in phase 1 and "reviewer" after it. ' +
							"If a specialist doesn\'t depend on the new code, put it in phase 1 ALONGSIDE the applicable coding role, not in a phase before it.",
					);
				}
				if (isTddOnlyPhase1) {
					const phase2Roles = (params.phases[1]?.roles ?? []).map((r) => r.trim().toLowerCase());
					if (!phase2Roles.includes("coder")) {
						throw new Error(
							'plan_set: phase 1 is "tdd-agent" alone (the TDD exception) — "coder" must then be in phase 2, right after it. ' +
								"coder can never be missing from the plan entirely.",
						);
					}
				}
				// Revisione 24: every plan now ends with a documentation pass, not
				// just optionally when the planner thinks of it — a real user
				// request ("alla fine di ogni task ... deve essere presente la gente
				// che scrive la documentazione") after this was purely a prose
				// suggestion and, in practice, skipped. Same enforcement pattern as
				// "coder is always phase 1" above: a rule that only lives in prose
				// can be violated by one bad call in a moment of distraction, so it
				// belongs in validation, not just in prompts/planner.md. Only tasks
				// that never call plan_set at all (pure documentation/diagram/
				// changelog requests, delegated directly — see prompts/planner.md,
				// "Il piano di esecuzione è un tool, non un file") are exempt, since
				// those ARE the documentation task already.
				const lastPhaseRoles = params.phases[params.phases.length - 1].roles.map((r) => r.trim().toLowerCase());
				if (!lastPhaseRoles.includes("docs-sync")) {
					throw new Error(
						'plan_set: the LAST phase must include "docs-sync" — every task plan now ends with a documentation pass ' +
							"(README/docs/API specs — or, for non-code tasks, whatever documentation fits what was actually done — kept " +
							"in sync with the real result) instead of being optional (see prompts/planner.md, Revisione 24). Add " +
							'"docs-sync" to the last phase (alone, or alongside other end-of-task specialists like ' +
							"release-notes-writer/security-evaluator) and call plan_set again.",
					);
				}
				const seen = new Map<string, number>();
				for (let i = 0; i < params.phases.length; i++) {
					for (const role of params.phases[i].roles) {
						const key = role.trim().toLowerCase();
						if (seen.has(key)) {
							throw new Error(`plan_set: role "${role}" appears in both phase ${seen.get(key)! + 1} and phase ${i + 1} — a role may only belong to one phase.`);
						}
						seen.set(key, i);
					}
				}

				const wt = requireWorktree(params.slug);
				const existing = readPlan(wt.path, params.slug);
				const now = nowIso();
				const phases: PlanPhase[] = params.phases.map((p, i) => {
					const phaseNum = i + 1;
					const rolesKey = [...p.roles].map((r) => r.trim().toLowerCase()).sort().join(",");
					const prior = existing?.phases.find((op) => op.phase === phaseNum && [...op.roles].map((r) => r.trim().toLowerCase()).sort().join(",") === rolesKey);
					if (prior && prior.status === "complete") return { phase: phaseNum, roles: p.roles, note: p.note, status: "complete" };
					if (phaseNum === 1) return { phase: phaseNum, roles: p.roles, note: p.note, status: "unlocked" };
					return { phase: phaseNum, roles: p.roles, note: p.note, status: "locked" as PlanPhaseStatus };
				});
				// Second pass: a phase unlocks if the one right before it is complete
				// (covers the case where an earlier phase was already complete before
				// this plan_set call re-declared/extended the plan).
				for (let i = 1; i < phases.length; i++) {
					if (phases[i].status === "locked" && phases[i - 1].status === "complete") phases[i].status = "unlocked";
				}
				const plan: Plan = { slug: params.slug, phases, created_at: existing?.created_at || now, updated_at: now };
				writePlan(wt.path, params.slug, plan);
				logEvent("plan_set", { slug: params.slug, phases: phases.map((p) => ({ phase: p.phase, roles: p.roles, status: p.status })) });
				appendPlanAudit(
					wt.path,
					params.slug,
					`piano impostato da \`${identity.instance}\`: ${phases.map((p) => `fase ${p.phase} [${p.status}] = ${p.roles.join("+")}`).join(", ")}`,
				);

				return {
					content: [{ type: "text" as const, text: `plan_set: ${phases.length} phase(s) saved for "${params.slug}".\n${renderPlanMarkdown(plan)}` }],
					details: { plan },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("plan_set ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const plan = (result.details as any)?.plan as Plan | undefined;
				return new Text(theme.fg("success", "→ plan: ") + theme.fg("accent", plan ? `${plan.phases.length} fasi` : "?"), 0, 0);
			},
		},

		{
			name: "plan_advance",
			label: "Plan Advance",
			description:
				"Mark a phase complete and unlock the next one — planner-only. You can only advance the CURRENTLY unlocked phase " +
				"(no skipping ahead); calling this on an already-complete phase is a harmless no-op. This is the only way a later " +
				"phase's roles become reachable by agent_send (Revisione 21) — there is no way around it, by design.",
			parameters: Type.Object({
				slug: Type.String({ description: "Task slug — same one used for worktree_create." }),
				completed_phase: Type.Number({ description: "The phase number you're declaring complete, e.g. 1." }),
				run_id: Type.Optional(Type.String({ description: "Persisted run whose phase tickets must be complete; omit only for legacy plan-only flows." })),
				ticket_ids: Type.Optional(Type.Array(Type.String({ description: "All tickets belonging to the completed phase." }))),
			}),
			async execute(_callId: string, params: { slug: string; completed_phase: number; run_id?: string; ticket_ids?: string[] }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") {
					throw new Error(`plan_advance: only the planner role may advance a task's execution plan (this instance is "${identity.role}").`);
				}
				const wt = requireWorktree(params.slug);
				const plan = readPlan(wt.path, params.slug);
				if (!plan) throw new Error(`plan_advance: no plan found for "${params.slug}" — call plan_set first.`);
				const target = plan.phases.find((p) => p.phase === params.completed_phase);
				if (!target) throw new Error(`plan_advance: "${params.slug}" has no phase ${params.completed_phase} (it has ${plan.phases.length}).`);
				if (target.status === "complete") {
					return {
						content: [{ type: "text" as const, text: `plan_advance: phase ${params.completed_phase} was already complete — no-op.\n${renderPlanMarkdown(plan)}` }],
						details: { plan },
					};
				}
				if (target.status === "locked") {
					throw new Error(`plan_advance: phase ${params.completed_phase} is still locked (its own predecessor isn't complete yet) — can't mark it complete out of order.`);
				}
				if (params.run_id && params.ticket_ids === undefined) throw new Error("plan_advance: ticket_ids are required when run_id is provided; phase completion must be backed by persisted tickets.");
				if (params.run_id && params.ticket_ids) {
					if (params.ticket_ids.length === 0) throw new Error("plan_advance: ticket_ids must contain at least one persisted ticket when run_id is provided.");
					const storage = ensureYanoStorage();
					const tickets = params.ticket_ids.map((id) => storage.getTicket(id));
					if (tickets.some((ticket: any) => !ticket || ticket.run_id !== params.run_id)) throw new Error("plan_advance: every ticket_id must exist and belong to run_id.");
					const incomplete = tickets.filter((ticket: any) => ticket!.status !== "done");
					if (incomplete.length) throw new Error(`plan_advance: phase ${params.completed_phase} has incomplete ticket(s): ${incomplete.map((ticket: any) => `${ticket!.id}=${ticket!.status}`).join(", ")}.`);
				}
				target.status = "complete";
				const next = plan.phases.find((p) => p.phase === params.completed_phase + 1);
				if (next && next.status === "locked") next.status = "unlocked";
				plan.updated_at = nowIso();
				writePlan(wt.path, params.slug, plan);
				logEvent("plan_advance", { slug: params.slug, completed_phase: params.completed_phase, unlocked_phase: next?.phase ?? null });
				appendPlanAudit(
					wt.path,
					params.slug,
					`piano: fase ${params.completed_phase} completata da \`${identity.instance}\`` + (next ? `, fase ${next.phase} ora sbloccata (${next.roles.join("+")})` : " — era l'ultima fase"),
				);
				return {
					content: [{ type: "text" as const, text: `plan_advance: phase ${params.completed_phase} complete.${next ? ` Phase ${next.phase} (${next.roles.join(", ")}) is now unlocked.` : " That was the last phase."}` }],
					details: { plan },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("plan_advance ")) + theme.fg("accent", `${(args as any).slug ?? "?"} phase ${(args as any).completed_phase ?? "?"}`), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const plan = (result.details as any)?.plan as Plan | undefined;
				const unlocked = plan?.phases.find((p) => p.status === "unlocked");
				return new Text(theme.fg("success", "→ ") + theme.fg("accent", unlocked ? `fase ${unlocked.phase} sbloccata` : "nessuna fase successiva"), 0, 0);
			},
		},

		{
			name: "plan_get",
			label: "Plan Get",
			description: "Read the current structured execution plan for a task, if one exists (plan_set may never have been called — that's not an error, just means this task has no gate). Any role may call this.",
			parameters: Type.Object({ slug: Type.String({ description: "Task slug — same one used for worktree_create." }) }),
			async execute(_callId: string, params: { slug: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const wt = requireWorktree(params.slug);
				const plan = readPlan(wt.path, params.slug);
				if (!plan) {
					return { content: [{ type: "text" as const, text: `plan_get: no structured plan for "${params.slug}" — agent_send isn't gated for this task.` }], details: { plan: null } };
				}
				return { content: [{ type: "text" as const, text: renderPlanMarkdown(plan) }], details: { plan } };
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("plan_get ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const plan = (result.details as any)?.plan as Plan | null;
				return new Text(theme.fg("success", "→ ") + theme.fg("accent", plan ? `${plan.phases.length} fasi` : "nessun piano strutturato"), 0, 0);
			},
		},

		{
			name: "report_append",
			label: "Report Append",
			description:
				"Append a section to a task's shared report file (reports/<slug>.md inside its worktree) with a real atomic append, " +
				"instead of reading the whole file, adding a section in memory, and writing it all back — the latter loses another " +
				"agent's section if two agents append at nearly the same time, which is a real risk once the planner brings several " +
				"specialists into the SAME worktree at once. Use this for every '## Round N — <role>' section instead of a generic " +
				"file write. The report file must already exist (created once at task bootstrap with its header) — this only appends. " +
				"Every append automatically also records an event line with the timestamp and a snapshot of every known agent's " +
				"status at that exact moment — you don't write that part yourself, it's added for you (Revisione 19), specifically " +
				"so the report alone is a complete audit trail of what happened when and who was doing what.",
			parameters: Type.Object({
				slug: Type.String({ description: "Task slug — same one used for worktree_create." }),
				section: Type.String({ description: "Markdown section to append, e.g. \"## Round 2 — coder (`coder-01`)\\n\\n- ...\". A leading blank line is added automatically for separation." }),
			}),
			async execute(_callId: string, params: { slug: string; section: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const wt = requireWorktree(params.slug);
				const file = reportPath(wt.path, params.slug);
				if (!fs.existsSync(file)) {
					throw new Error(`report_append: ${file} does not exist yet — create it once with its header (# Report: ..., - Task:, - Stato:) before appending rounds to it.`);
				}
				// The section AND its auto-generated event/status footer are one
				// single fs.appendFileSync call (one atomic write) so nothing else
				// can land in between them and split a round from its own snapshot —
				// same reasoning as why this whole tool exists (see the note above
				// report_append's registration).
				const eventLine = `\n> _[evento] report_append di \`${identity.instance}\` (\`${identity.role}\`) alle ${nowIso()} — stato team: ${agentStatusSnapshot()}_\n`;
				const chunk = `\n${params.section.replace(/\s+$/, "")}\n${eventLine}`;
				fs.appendFileSync(file, chunk);
				logEvent("report_append", { slug: params.slug, report_path: file, appended_bytes: chunk.length, section_preview: params.section.slice(0, 120) });
				return {
					content: [{ type: "text" as const, text: `report_append: appended ${chunk.length} bytes to ${file}` }],
					details: { report_path: file, appended_bytes: chunk.length },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("report_append ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				return new Text(theme.fg("success", "→ appended to ") + theme.fg("accent", (result.details as any)?.report_path ?? "?"), 0, 0);
			},
		},

		{
			name: "file_claim",
			label: "File Claim",
			description:
				"Claim an ADVISORY lock on a file inside a task's worktree before editing it, so two agents working the same " +
				"worktree in parallel don't silently overwrite each other. Returns claimed:true if you now hold it (or already did), " +
				"or claimed:false with who holds it and since when if someone else does — in that case do NOT edit the file anyway: " +
				"wait, pick a different file, or report back that you're blocked instead. Expired claims (default 20 minutes, an " +
				"agent that crashed without releasing) are treated as free automatically.",
			parameters: Type.Object({
				slug: Type.String({ description: "Task slug — same one used for worktree_create." }),
				file: Type.String({ description: "Path to the file, relative to the worktree root (e.g. \"src/checker.ts\")." }),
				ttl_minutes: Type.Optional(Type.Number({ description: "How long the claim is valid before being treated as free. Default 20." })),
			}),
			async execute(_callId: string, params: { slug: string; file: string; ttl_minutes?: number }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				assertSafeRelativeFile(params.file);
				const wt = requireWorktree(params.slug);
				const locks = readLocks(wt.path).filter((l) => !lockExpired(l));
				const existing = locks.find((l) => l.file === params.file);
				if (existing && existing.holder !== identity.instance) {
					logEvent("file_claim", { slug: params.slug, file: params.file, claimed: false, held_by: existing.holder });
					return {
						content: [{ type: "text" as const, text: `file_claim: "${params.file}" is currently held by ${existing.holder} (since ${existing.claimed_at}) — do not edit it, wait or pick something else.` }],
						details: { claimed: false, held_by: existing.holder, since: existing.claimed_at },
					};
				}
				const ttl = params.ttl_minutes ?? 20;
				const next = locks.filter((l) => l.file !== params.file);
				next.push({ file: params.file, holder: identity.instance, claimed_at: nowIso(), ttl_minutes: ttl });
				writeLocks(wt.path, next);
				logEvent("file_claim", { slug: params.slug, file: params.file, claimed: true, already_yours: !!existing });
				return {
					content: [{ type: "text" as const, text: `file_claim: "${params.file}" claimed by ${identity.instance} for ${ttl} minutes.` }],
					details: { claimed: true, already_yours: !!existing },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("file_claim ")) + theme.fg("accent", (args as any).file ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return d?.claimed
					? new Text(theme.fg("success", "✓ claimed"), 0, 0)
					: new Text(theme.fg("error", `✗ held by ${d?.held_by ?? "?"}`), 0, 0);
			},
		},

		{
			name: "file_release",
			label: "File Release",
			description: "Release a file claimed with file_claim once you're done editing it, so other agents in the same worktree can claim it. Idempotent — a no-op if you don't hold it.",
			parameters: Type.Object({
				slug: Type.String({ description: "Task slug — same one used for worktree_create." }),
				file: Type.String({ description: "Path to the file, relative to the worktree root — same one passed to file_claim." }),
			}),
			async execute(_callId: string, params: { slug: string; file: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				assertSafeRelativeFile(params.file);
				const wt = requireWorktree(params.slug);
				const locks = readLocks(wt.path);
				const held = locks.find((l) => l.file === params.file && l.holder === identity!.instance);
				const next = locks.filter((l) => !(l.file === params.file && l.holder === identity!.instance));
				writeLocks(wt.path, next);
				logEvent("file_release", { slug: params.slug, file: params.file, released: !!held });
				return {
					content: [{ type: "text" as const, text: held ? `file_release: released "${params.file}".` : `file_release: "${params.file}" was not held by you — no-op.` }],
					details: { released: !!held },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("file_release ")) + theme.fg("accent", (args as any).file ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				return new Text(theme.fg("dim", (result.details as any)?.released ? "→ released" : "→ no-op"), 0, 0);
			},
		},
	];
}
