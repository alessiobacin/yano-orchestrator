// Fase 6 / M0 — orchestrator_init/run_create/spec_create/run_status/
// run_watchdog_check, extracted from extensions/orchestrator.ts. All 5
// share the "run domain" (ensureYanoStorage's run/spec/ticket methods),
// and 3 of the 5 (orchestrator_init/run_status/run_watchdog_check) share
// yanoFindStalledTickets/yanoFindUnfinalizedRuns/yanoFindOrphanedTickets/
// yanoEnsureWorkspace/yanoReconcilePersistedState — pure functions still
// defined at module scope in orchestrator.ts (not yet extracted into their
// own module) and already injected by direct reference into
// scripts/watcher/watchdog-sweep.ts (Fase 2/M3). Same technique here: pass
// by reference, don't move or duplicate their definitions. presence is a
// `const` Map (stable reference, only contents mutate) — passed directly,
// same pattern as Fase 4/M5's activeTicketIds. yanoPublishEvent is a
// closure function already correctly bound at its own definition site in
// orchestrator.ts — passed as a direct reference, same reasoning as
// ensureYanoStorage/sendNotifications throughout Fase 4/5.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { OrchestratorStorage } from "../yano-orchestrator-storage.ts";
import { redactRuntimeProjection } from "./redact.ts";
import { yanoWorkspaceDir, yanoSubdirs } from "./yano-workspace.ts";
import { yanoComputeReadyBlocked, yanoComputeExecutionWaves } from "./ticket-scheduling.ts";

const WATCHDOG_INTERVAL_MS = Number(process.env.PI_ORCH_WATCHDOG_INTERVAL_MS) || 120_000;
const WATCHDOG_STALL_MS = Number(process.env.PI_ORCH_WATCHDOG_STALL_MS) || 900_000;
const WATCHDOG_FINALIZE_GRACE_MS = Number(process.env.PI_ORCH_WATCHDOG_FINALIZE_GRACE_MS) || 600_000;

// Same Crockford-base32 ULID generator duplicated locally in agents.ts
// (Fase 5/M6) — zero closure, kept here too rather than importing across
// modules for a dozen lines. Used by spec_create.
function ulid(): string {
	const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			randStr += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) randStr += CROCKFORD[(value << (5 - bits)) & 31];
	return (timeStr + randStr).slice(0, 26);
}

// Not exported from orchestrator.ts (local `interface`/`type` there) —
// duplicated here as trivial type-only copies, same call as
// scripts/orchestrator-tools/tickets.ts's PresenceStatus duplicate.
type PresenceStatus = "idle" | "busy" | "offline";

export interface YanoProjectConfig {
	schema_version: number;
	extension_version: string;
	project: string;
	created_at: string;
	updated_at: string;
}

export interface StalledTicketInfo {
	run_id: string;
	ticket_id: string;
	title: string;
	assigned_instance: string | null;
	running_since: string;
	elapsed_ms: number;
}

export interface UnfinalizedRunInfo {
	run_id: string;
	objective: string;
	completed_at: string;
	elapsed_ms: number;
}

export interface OrphanedTicketInfo {
	run_id: string;
	ticket_id: string;
	title: string;
	assigned_instance: string;
	running_since: string;
}

export interface Identity {
	role: string;
	cwd: string;
	project: string;
	instance: string;
}

export interface RunToolsDeps {
	getIdentity: () => Identity | null;
	ensureYanoStorage: () => OrchestratorStorage;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	yanoPublishEvent: (runId: string, type: string, payload: unknown) => Promise<void>;
	yanoEnsureWorkspace: (projectCwd: string, project: string, projectNameOverride?: string) => YanoProjectConfig;
	yanoReconcilePersistedState: (storage: OrchestratorStorage, project: string, presenceSnapshot: Map<string, { status: PresenceStatus }>) => number;
	yanoFindStalledTickets: (storage: OrchestratorStorage, project: string, nowMs: number, stallMs: number) => StalledTicketInfo[];
	yanoFindUnfinalizedRuns: (storage: OrchestratorStorage, project: string, nowMs: number, graceMs: number) => UnfinalizedRunInfo[];
	yanoFindOrphanedTickets: (
		storage: OrchestratorStorage,
		project: string,
		presenceSnapshot: Map<string, { status: PresenceStatus }>,
		options?: { ignoreOpenDecisionHolds?: boolean },
	) => OrphanedTicketInfo[];
	presence: Map<string, { status: PresenceStatus }>;
}

export function createRunTools(deps: RunToolsDeps) {
	const {
		getIdentity,
		ensureYanoStorage,
		logEvent,
		yanoPublishEvent,
		yanoEnsureWorkspace,
		yanoReconcilePersistedState,
		yanoFindStalledTickets,
		yanoFindUnfinalizedRuns,
		yanoFindOrphanedTickets,
		presence,
	} = deps;
	return [
		{
			name: "orchestrator_init",
			label: "Orchestrator Init",
			description:
				"Idempotently create/open the YanoOrchestrator project workspace (.pi/extensions/yano-orchestrator/ — " +
				"config/specs/playbooks/diagrams/knowledge/policies/artifacts/overrides/orchestratorStorage) and its SQLite " +
				"database. Safe to call every session start: never destroys existing state. Any role may call it (it's just " +
				"workspace setup) — planner normally does it once before run_create. Optional project_name (Revisione 28) sets/" +
				"renames the human-facing project name stored in config/project.json — distinct from the MQTT --project scope " +
				"flag, which this never touches. Call this WITHOUT project_name first to see the current name (in the returned " +
				"config) before deciding whether to ask the user for one.",
			parameters: Type.Object({
				project_name: Type.Optional(Type.String({ description: "Human-facing project name to set/rename in config/project.json. Omit to just read the current one." })),
			}),
			async execute(_callId: string, params: { project_name?: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const cfg = yanoEnsureWorkspace(identity.cwd, identity.project, params.project_name);
				const storage = ensureYanoStorage();
				const reconciledRuns = identity.role === "planner" ? yanoReconcilePersistedState(storage, identity.project, presence) : 0;
				const schemaVersion = storage.getSchemaVersion();
				logEvent("yano_init", { schema_version: schemaVersion, extension_version: cfg.extension_version, project: cfg.project, reconciled_runs: reconciledRuns });
				return {
					content: [{ type: "text" as const, text: `orchestrator_init: workspace ready at .pi/extensions/yano-orchestrator/ (schema v${schemaVersion}, extension ${cfg.extension_version}, project "${cfg.project}").${reconciledRuns ? ` Reconciled ${reconciledRuns} active run(s).` : ""}` }],
					details: { config: cfg, schema_version: schemaVersion, reconciled_runs: reconciledRuns },
				};
			},
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("orchestrator_init")), 0, 0);
			},
			renderResult(_result: any, _options: unknown, theme: Theme) {
				return new Text(theme.fg("success", "→ workspace ready"), 0, 0);
			},
		},

		{
			name: "run_create",
			label: "Run Create",
			description:
				"Start a new orchestration run — planner-only. A run is the top-level container for one objective's spec + " +
				"tickets + dependency graph + event history, persisted in SQLite. Implicitly ensures the workspace exists " +
				"(same effect as orchestrator_init) if this is the first run.",
			parameters: Type.Object({
				objective: Type.String({ description: "The user's objective for this run, in plain language." }),
				domain: Type.Optional(Type.String({ description: 'Work domain, e.g. "software", "research", "documentation", "operations", "marketing" — defaults to "generic".' })),
			}),
			async execute(_callId: string, params: { objective: string; domain?: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") throw new Error(`run_create: only the planner role may start a run (this instance is "${identity.role}").`);
				const storage = ensureYanoStorage();
				const run = storage.createRun({ project: identity.project, objective: params.objective, domain: params.domain || "generic" });
				storage.recordEvent(run.id, "run_created", { objective: run.objective, domain: run.domain });
				logEvent("yano_run_created", { run_id: run.id, domain: run.domain });
				await yanoPublishEvent(run.id, "run_created", { objective: run.objective, domain: run.domain });
				return {
					content: [{ type: "text" as const, text: `run_create: run "${run.id}" started (domain: ${run.domain}).` }],
					details: { run },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("run_create ")) + theme.fg("accent", String((args as any).objective ?? "?").slice(0, 60)), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const run = (result.details as any)?.run;
				return new Text(theme.fg("success", "→ run ") + theme.fg("accent", run?.id ?? "?"), 0, 0);
			},
		},

		{
			name: "spec_create",
			label: "Spec Create",
			description:
				"Attach a canonical specification to a run — planner-only. Persisted both in SQLite (queryable by tickets) and " +
				"as a markdown file under specs/ (human/agent-readable) — the To-Spec-inspired canonical spec (objective/scope/" +
				"requirements/constraints/acceptance-criteria for software, looser structure for other domains). Content is " +
				"free-form markdown; this tool does not force a schema on it.",
			parameters: Type.Object({
				run_id: Type.String(),
				title: Type.String(),
				content: Type.String({ description: "Full spec content, markdown." }),
			}),
			async execute(_callId: string, params: { run_id: string; title: string; content: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				if (identity.role !== "planner") throw new Error(`spec_create: only the planner role may create a specification (this instance is "${identity.role}").`);
				const storage = ensureYanoStorage();
				const run = storage.getRun(params.run_id);
				if (!run) throw new Error(`spec_create: no run "${params.run_id}" — call run_create first.`);
				const specsDir = yanoSubdirs(yanoWorkspaceDir(identity.cwd)).specs;
				const slugTitle = params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "spec";
				const specId = ulid();
				const filePath = path.join(specsDir, `${specId}-${slugTitle}.md`);
				fs.writeFileSync(filePath, `# ${params.title}\n\n${params.content}\n`);
				const spec = storage.createSpec({ id: specId, run_id: params.run_id, title: params.title, content: params.content, file_path: path.relative(identity.cwd, filePath) });
				storage.recordEvent(run.id, "spec_created", { spec_id: spec.id, title: spec.title });
				logEvent("yano_spec_created", { run_id: run.id, spec_id: spec.id });
				await yanoPublishEvent(run.id, "spec_created", { spec_id: spec.id, title: spec.title });
				return {
					content: [{ type: "text" as const, text: `spec_create: "${spec.title}" saved (${spec.id}), at ${spec.file_path}.` }],
					details: { spec },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("spec_create ")) + theme.fg("accent", (args as any).title ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const spec = (result.details as any)?.spec;
				return new Text(theme.fg("success", "→ spec ") + theme.fg("accent", spec?.id ?? "?"), 0, 0);
			},
		},

		{
			name: "run_status",
			label: "Run Status",
			description:
				"Read the full persisted state of a run — status, every ticket with its computed READY/BLOCKED/RUNNING/DONE/" +
				"FAILED bucket, execution waves, recent events, and any currently stalled tickets (Revisione 29 — RUNNING for " +
				"longer than the watchdog's stall threshold with no ticket_complete, the same check the background watchdog " +
				"runs automatically for the planner). This is the resumability surface: after a crash/restart, a fresh planner " +
				"session calls this instead of regenerating the plan, to see exactly what's done, what's in flight, and " +
				"what's next. A ticket left \"running\" from a dead process is surfaced as running here, not silently treated " +
				"as done or auto-requeued (automatic crash retry is deferred, see docs/notes/development-notes.md Revisione 26).",
			parameters: Type.Object({ run_id: Type.String() }),
			async execute(_callId: string, params: { run_id: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const storage = ensureYanoStorage();
				const run = storage.getRun(params.run_id);
				if (!run) throw new Error(`run_status: no run "${params.run_id}".`);
				const tickets = storage.listTickets(params.run_id);
				const dependencies = storage.listDependencies(params.run_id);
				const buckets = yanoComputeReadyBlocked(tickets, dependencies);
				const waves = yanoComputeExecutionWaves(tickets, dependencies);
				const events = storage.listEvents(params.run_id, { limit: 50 });
				const checkpoints = storage.listCheckpoints(params.run_id);
				const playbook_binding = redactRuntimeProjection(storage.getPlaybookBinding(params.run_id));
				const playbook_state = storage.getPlaybookRuntimeState(params.run_id);
				const playbook_evidence = storage.listPlaybookEvidence(params.run_id).map((item: any) => redactRuntimeProjection(item));
				const capability_cards = storage.listCapabilityCards(params.run_id).map((card: any) => redactRuntimeProjection(card));
				const playbook_effects = storage.listPlaybookEffects(params.run_id).map((effect: any) => redactRuntimeProjection(effect));
				const decision_holds = storage.listDecisionHolds(params.run_id).map((hold: any) => redactRuntimeProjection(hold));
				const stalled = yanoFindStalledTickets(storage, identity.project, Date.now(), WATCHDOG_STALL_MS).filter((s) => s.run_id === params.run_id);
				const unfinalized = yanoFindUnfinalizedRuns(storage, identity.project, Date.now(), WATCHDOG_FINALIZE_GRACE_MS).filter((r) => r.run_id === params.run_id);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`run "${run.id}" (${run.status}, domain: ${run.domain}): ${tickets.length} ticket(s) — ` +
								`${buckets.done.length} done, ${buckets.running.length} running, ${buckets.ready.length} ready, ${buckets.blocked.length} blocked, ${buckets.failed.length} failed.` +
								(stalled.length ? `\n⚠️ ${stalled.length} ticket bloccato/i: ${stalled.map((s) => `${s.ticket_id} (${Math.round(s.elapsed_ms / 60_000)} min, ${s.assigned_instance ?? "?"})`).join(", ")}.` : "") +
								(unfinalized.length ? `\n⚠️ run completato da ${Math.round(unfinalized[0].elapsed_ms / 60_000)} min — stato ${run.finalization_status || "pending_finalize"}: verifica se worktree_finalize va ancora chiamato.` : ""),
						},
					],
					details: { run, finalization_status: run.finalization_status || (run.status === "completed" ? "pending_finalize" : "not_started"), tickets, dependencies, ...buckets, waves, recent_events: events, checkpoints, playbook_binding, playbook_state, playbook_evidence, capability_cards, playbook_effects, decision_holds, stalled_tickets: stalled, unfinalized_run: unfinalized.length > 0 },
				};
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("run_status ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const run = (result.details as any)?.run;
				return new Text(theme.fg("success", "→ ") + theme.fg("accent", run?.status ?? "?"), 0, 0);
			},
		},

		{
			name: "run_watchdog_check",
			label: "Run Watchdog Check",
			description:
				"Manually run the same stall-detection sweep the planner's background watchdog performs automatically every " +
				`${Math.round(WATCHDOG_INTERVAL_MS / 60_000)} minute(s) (Revisione 29): finds tickets stuck "running" for more ` +
				`than ${Math.round(WATCHDOG_STALL_MS / 60_000)} minutes with no ticket_complete — the only externally observable ` +
				"signal for a worker whose single LLM turn hung or got truncated by the provider without ever calling a tool " +
				"(heartbeat/presence alone can't catch this: the process's event loop can stay alive, publishing \"working\", " +
				"the whole time). Any role may call this on demand — useful right after resuming a session, or just to check. " +
				"The automatic background sweep (planner instance only) additionally records a ticket_stalled event, notifies " +
				"the user via WhatsApp, and wakes the planner's own turn with an actionable message the first time a given " +
				"running episode crosses each stall-threshold multiple — this manual tool only reports, it never escalates. " +
				"Also reports runs stuck \"completed\" with no worktree_finalize/notification follow-up for more than " +
				`${Math.round(WATCHDOG_FINALIZE_GRACE_MS / 60_000)} minutes (Revisione 40) — a run can auto-complete the moment ` +
				"its last ticket is done, independently of whether the planner ever actually merged/notified. And — Revisione 42 — " +
				"any RUNNING ticket whose assigned instance has no live MQTT presence right now (confirmably disconnected, not " +
				"just slow): by the time you see one here it's already been auto-marked \"failed\" by the background watchdog, " +
				"this just surfaces which instance you still need to relaunch.",
			parameters: Type.Object({ run_id: Type.Optional(Type.String({ description: "Limit to one run; omit to check every active run for this project." })) }),
			async execute(_callId: string, params: { run_id?: string }) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const storage = ensureYanoStorage();
				const all = yanoFindStalledTickets(storage, identity.project, Date.now(), WATCHDOG_STALL_MS);
				const stalled = params.run_id ? all.filter((s) => s.run_id === params.run_id) : all;
				const allUnfinalized = yanoFindUnfinalizedRuns(storage, identity.project, Date.now(), WATCHDOG_FINALIZE_GRACE_MS);
				const unfinalized = params.run_id ? allUnfinalized.filter((r) => r.run_id === params.run_id) : allUnfinalized;
				const allOrphaned = yanoFindOrphanedTickets(storage, identity.project, presence, { ignoreOpenDecisionHolds: true });
				const orphaned = params.run_id ? allOrphaned.filter((o) => o.run_id === params.run_id) : allOrphaned;
				const lines = [
					...stalled.map((s) => `⚠️ ${s.ticket_id} "${s.title}" — assegnato a ${s.assigned_instance ?? "?"}, running da ${Math.round(s.elapsed_ms / 60_000)} min.`),
					...unfinalized.map((r) => `⚠️ run ${r.run_id} "${r.objective}" — completato da ${Math.round(r.elapsed_ms / 60_000)} min, nessun finalize/notifica risulta ancora arrivato.`),
					...orphaned.map((o) => `🔴 ${o.ticket_id} "${o.title}" — assegnato a "${o.assigned_instance}", OFFLINE (nessuna presence viva). Rilanciala prima di ripianificare.`),
				];
				return {
					content: [
						{
							type: "text" as const,
							text: lines.length === 0 ? "run_watchdog_check: nessun blocco (né ticket, né run non finalizzati, né istanze offline)." : lines.join("\n"),
						},
					],
					details: { stalled, unfinalized, orphaned },
				};
			},
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("run_watchdog_check")), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const n = ((result.details as any)?.stalled ?? []).length + ((result.details as any)?.unfinalized ?? []).length;
				return n === 0 ? new Text(theme.fg("success", "→ nessun blocco"), 0, 0) : new Text(theme.fg("warning", `→ ${n} bloccat${n === 1 ? "o" : "i"}`), 0, 0);
			},
		},
	];
}
