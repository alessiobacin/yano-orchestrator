/**
 * orchestrator — MQTT-based agent bus for Pi, replacing coms.ts's socket
 * transport and flat peer-to-peer paradigm with the role/instance/capability
 * model from docs/architecture/architecture.md.
 *
 * What changes vs coms.ts / coms-net.ts:
 *
 *   coms.ts concept                    orchestrator.ts equivalent
 *   ----------------------------------  ------------------------------------
 *   unix socket bind + dial             MQTT 5 client (single broker conn)
 *   ~/.pi/coms registry files           agents/agents.yaml + agents/roles.yaml
 *   --cname (free-form peer name)       --instance (must resolve to a
 *                                        configured instance id, e.g. coder-01)
 *   flat peer, no role                  role + team + capabilities, resolved
 *                                        with INSTANCE > ROLE > GLOBAL
 *                                        precedence (architecture.md §3-4)
 *   ping/pong liveness                  retained MQTT presence + LWT
 *   coms_send (1:1 only)                agent_send (1:1 via target_instance,
 *                                        OR fan-out via target_role)
 *   msg_id, no replay protection        assignment_id used as a fencing
 *                                        token; duplicate/stale deliveries
 *                                        are deduped/ignored client-side
 *   no visibility into others' work     agent_publish_event + agent_activity:
 *                                        agents can see what happened on a
 *                                        project/team channel without being
 *                                        addressed directly (pub/sub, not
 *                                        just request/response)
 *
 * Explicitly NOT implemented here (see docs/notes/development-notes.md): the Scheduler
 * Engine, DAG/playbook execution, the scored Agent Router, review-loop
 * composite nodes, budget enforcement, TLS/ACL hardening. This file is only
 * the transport + identity + presence + pub/sub layer described in
 * architecture.md §22-24, §37 — the piece that plays the same role coms.ts
 * plays today, nothing more.
 *
 * Usage: pi -e extensions/orchestrator.ts --instance coder-01 --role coder
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import mqtt, { type MqttClient } from "mqtt";
import { parse as parseYaml } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../scripts/playbook-loader.mjs";
import { fetchPublicSource, searchPublicAlternatives } from "../scripts/yano-auto-improve-web.mjs";
import { ensureTraceProject, getTraceConfig, projectKey, setTraceMode, traceEnabled, traceRoot } from "../scripts/yano-trace-storage.mjs";
import { loadYanoRules } from "../scripts/yano-rules.mjs";
import { loadAgentMemory, updateAgentMemory } from "../scripts/yano-agent-memory.mjs";
import { ensureProjectSummary, projectBootstrapPrompt, scanProject } from "../scripts/yano-project-context.mjs";
import { collectCodeMemContext } from "../scripts/yano-code-mem-context.mjs";
import { getProjectApi, listProjectApis, resolveApiSecret } from "../scripts/yano-api-registry.mjs";
import { llmProxyAutoModel, switchImageTurnToAuto } from "../scripts/yano-vision-routing.mjs";
import { switchPinnedModelToAuto } from "../scripts/yano-model-fallback.mjs";
import { recommend as recommendModel } from "../scripts/yano-model-advisor.mjs";
import { openDatabase as openFeedbackDatabase, createFeedback as createFeedbackRecord, claimFeedback, claimNextQueuedFeedback, listFeedback, buildQueuedFeedbackWakeMessage, terminalStatusForFeedbackId } from "../scripts/yano-feedback.mjs";
import { detectStalledTickets } from "../scripts/watcher/detect-stalled-tickets.mjs";
import { writeWatchdogHeartbeat } from "../scripts/watcher/heartbeat.mjs";
import {
	SQLiteOrchestratorStorage,
	type OrchestratorStorage,
	type RunRecord,
	type RunStatus,
	type RunFinalizationStatus,
	type SpecRecord,
	type TicketRecord,
	type TicketStatus,
	type DependencyRecord,
	type DecisionHoldRecord,
	type DecisionHoldStatus,
	type EventRecord,
} from "../scripts/yano-orchestrator-storage.ts";
import {
	setTerminalTitle,
	herdrReportAgent,
	herdrRenamePane,
	herdrRenameTab,
	paseoDetectAndLog,
} from "../scripts/yano-terminal-integration.ts";
import * as notifications from "../scripts/yano-notifications.ts";
import { createWatchdogSweep } from "../scripts/watcher/watchdog-sweep.ts";
import { redactRuntimeProjection } from "../scripts/orchestrator-tools/redact.ts";
import { createDecisionHoldTools } from "../scripts/orchestrator-tools/decision-holds.ts";
import { createRetentionPolicyTools } from "../scripts/orchestrator-tools/retention-policy.ts";
import { createGovernanceProposalTools } from "../scripts/orchestrator-tools/governance-proposals.ts";
import { createCapabilityCardTools } from "../scripts/orchestrator-tools/capability-cards.ts";
import { createPlaybookTools } from "../scripts/orchestrator-tools/playbooks.ts";
import { createTicketTools } from "../scripts/orchestrator-tools/tickets.ts";
import { SLUG_RE, execGit, worktreePaths, normalizePath, ensureWorktreesGitignored, assertGitRepo, findExistingWorktree } from "../scripts/orchestrator-tools/git-worktree.ts";
import { yanoComputeReadyBlocked, yanoComputeExecutionWaves } from "../scripts/orchestrator-tools/ticket-scheduling.ts";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://localhost:1883";
// 5 was calibrated for the simple one-pass planner->coder->reviewer->planner
// demo. The multi-round review/correction loop (reviewer<->coder can bounce
// more than once per round, and planner can deliberately start whole new
// rounds — see prompts/planner.md) legitimately needs more hops than that: a
// single rejection-then-approve round alone already spends 4 of 5. Raised to
// a still-finite but much more generous default; agent_send's new_round
// parameter additionally resets the count to 0 for planner-initiated new
// rounds, so this ceiling is really only hit by a genuine runaway loop.
const MAX_HOPS = Number(process.env.PI_ORCH_MAX_HOPS) || 24;
const TIMEOUT_MS = Number(process.env.PI_ORCH_TIMEOUT_MS) || 1_800_000; // 30 min, mirrors coms.ts default
const HEARTBEAT_MS = Number(process.env.PI_ORCH_HEARTBEAT_MS) || 15_000;
const STALE_AFTER_MS = Number(process.env.PI_ORCH_STALE_AFTER_MS) || HEARTBEAT_MS * 3;
const SEEN_ASSIGNMENTS_CAP = 1000;
const ACTIVITY_LOG_CAP = 200;
const DEFAULT_CONTROL_VERBS = ["status", "launch", "relaunch", "terminate"] as const;
const CONTROL_BINARIES = new Set(["herdr", "pi", "yano"]);

function loadControlPolicy(cwd: string): { verbs: string[]; cli: Record<string, unknown> } {
	const fallback = { verbs: [...DEFAULT_CONTROL_VERBS], cli: {} };
	try {
		const file = path.join(cwd, "config", "control.json");
		if (!fs.existsSync(file)) return fallback;
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			verbs: Array.isArray(value.verbs) ? value.verbs.filter((verb: unknown): verb is string => typeof verb === "string") : fallback.verbs,
			cli: value.cli && typeof value.cli === "object" ? value.cli : {},
		};
	} catch {
		return fallback;
	}
}

// Real incident that prompted this (Revisione 29): a worker's single LLM
// turn hung/got truncated by the model provider mid-response, with NOT ONE
// tool call along the way (no report_append, no retry, nothing) — the pane
// just sat there forever. Presence/heartbeat (HEARTBEAT_MS/STALE_AFTER_MS
// above) could NOT have caught this: the process's event loop was still
// alive (an in-flight HTTP call doesn't block it), so it kept publishing
// "status: working" presence the whole time — a live heartbeat is not the
// same thing as progress. The only externally observable signal left is
// plain wall-clock time on the ticket layer: a ticket stuck "running" (set
// by ticket_claim) for longer than WATCHDOG_STALL_MS with no ticket_complete
// is flagged stalled. This is a heuristic, not a certainty — a genuinely
// slow task looks identical from the outside — which is exactly why the
// escalation this drives (see watchdogSweep()) INFORMS the planner instead
// of automatically killing/reassigning anything itself.
const WATCHDOG_INTERVAL_MS = Number(process.env.PI_ORCH_WATCHDOG_INTERVAL_MS) || 120_000; // how often the planner sweeps for stalled tickets
const WATCHDOG_STALL_MS = Number(process.env.PI_ORCH_WATCHDOG_STALL_MS) || 900_000; // 15 min running with no ticket_complete → flagged

// Revisione 40 — a real incident this same "ticket stuck running" check
// CANNOT catch: every ticket in a run reached "done", ticket_complete's own
// allDone branch auto-marked the run "completed" — and then nothing else
// happened, because the follow-up (merge the worktree via worktree_finalize,
// notify the operator) is the PLANNER's own judgment call, not something the
// ticket/DAG layer does automatically. If the planner's own turn-taking stops
// making progress right around when the last ticket completes (observed
// cause in this incident: an LLM proxy container restarted mid-session — see
// docs/notes/development-notes.md), the run sits "completed" forever with no
// worktree merged and no human notified, and yanoFindStalledTickets() above
// finds nothing wrong because there is no ticket left in "running" status to
// flag. This is a DIFFERENT heuristic — "the DAG layer says done, but nothing
// has moved since" — not a certainty either (a planner could legitimately be
// composing a long final report), which is why it only ever informs, same as
// the ticket-stall path, and only after a generous grace period.
const WATCHDOG_FINALIZE_GRACE_MS = Number(process.env.PI_ORCH_WATCHDOG_FINALIZE_GRACE_MS) || 600_000; // 10 min "completed" with nothing since → flagged

// Revisione 42 — a real incident (progetto "code-mem") showed a gap neither
// check above catches: a ticket's assigned_instance had gone away ENTIRELY
// (herdr tab closed, `pi` process not running at all — not "hung", just
// GONE), and the planner, restarted, found itself facing that half-finished
// ticket with nothing there to receive a delegation, and did the work itself
// instead of relaunching a coder. yanoFindStalledTickets() would eventually
// have flagged this too, but only after WATCHDOG_STALL_MS (15 min) of pure
// wall-clock waiting — and even then only as "maybe stalled", informational,
// never a certainty. This case does NOT need to wait or guess: presence
// (MQTT retained "status" per instance, LWT-backed, pruned client-side after
// STALE_AFTER_MS ~45s of silence — see onPresenceMessage/staleSweepTimer) is
// a genuinely deterministic signal of "is this instance actually connected
// right now", not a heuristic. If a RUNNING ticket's assigned_instance has no
// live presence card at all, that instance is confirmably not there — no
// elapsed-time threshold needed, the very next watchdog sweep (at most
// WATCHDOG_INTERVAL_MS after the fact, typically ~2 min, once presence has
// had time to expire) can call it with certainty. See
// yanoFindOrphanedTickets()/watchdogSweep() below for what this drives: an
// automatic (code-only, no LLM judgment involved) ticket_complete(failed) so
// the slot frees up, PLUS a mandatory instruction to the planner to relaunch
// the missing instance — never to do the ticket's work itself.
//
// Separately, and OFF by default (PI_ORCH_WATCHDOG_AUTO_TERMINATE=true to
// enable): a ticket that's STILL connected (live presence, not offline) but
// RUNNING well past this second, harder threshold gets a real kill — a
// "terminate" control message published to that instance's own command
// topic (see agent_terminate/handleTerminate below), forcing a clean
// self-exit instead of waiting for the 30-minute agent_send timeout or
// leaving a possibly-wedged process sitting there indefinitely. This is
// opt-in and deliberately NOT the default: unlike the orphan case above
// (which only acts on an instance that's already gone), forcibly killing a
// STILL-RUNNING process risks destroying a genuinely slow-but-progressing
// task — a real trade-off the operator should choose knowingly, not one
// this package should make silently on their behalf.
const WATCHDOG_AUTO_TERMINATE_ENABLED = process.env.PI_ORCH_WATCHDOG_AUTO_TERMINATE === "true";
const WATCHDOG_AUTO_TERMINATE_MS = Number(process.env.PI_ORCH_WATCHDOG_AUTO_TERMINATE_MS) || 1_200_000; // 20 min, well under the 30-min agent_send timeout

const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type CommandEnvelope = {
	type: "command";
	assignment_id: string; // fencing token — see architecture.md §23-24
	sender_instance: string;
	sender_role: string;
	target_instance?: string; // 1:1 addressing
	target_role?: string;     // fan-out to every live instance of a role (no
	                          // claim arbitration at this stage — see docs/notes/development-notes.md)
	project: string;
	prompt: string;
	reply_to: string; // topic the response must be published to
	hops: number;
	timestamp: string;
	response_schema?: object | null;
};

type ResponseEnvelope = {
	type: "response";
	assignment_id: string;
	responder_instance: string;
	response: any;
	error?: string | null;
	timestamp: string;
};

// Revisione 42 — a forced-shutdown control message, published on the SAME
// per-instance command topic agent_send/handleCommand already use
// (pi/<project>/agents/<id>/commands), so it needs no new topic/subscription
// — just a new `type` discriminant the existing message handler branches on.
// Deliberately minimal: no reply is expected (the target is being told to
// exit, not asked to do work), so there's no reply_to/assignment_id/hops.
type TerminateEnvelope = {
	type: "terminate";
	requested_by_instance: string;
	requested_by_role: string;
	reason: string;
	timestamp: string;
};

// Watcher-driven context maintenance. This is deliberately a control message
// rather than a normal task: the target agent owns its Pi session and is the
// only component allowed to ask Pi to compact that session.
type ContextCompactRequestEnvelope = {
	type: "context_compact_request";
	request_id: string;
	requested_by_instance: string;
	requested_by_role: string;
	reason: string;
	custom_instructions?: string;
	timestamp: string;
};

// Controlled reload handshake used by `yano update --reload`. It is a
// quiescence request, not a hot-reload: the running extension stops accepting
// new delegated work and publishes readiness before the supervisor sends the
// normal graceful terminate.
type ReloadPrepareEnvelope = {
	type: "reload_prepare";
	requested_by_instance: string;
	requested_by_role: string;
	reason: string;
	timestamp: string;
};

type ReloadCancelEnvelope = {
	type: "reload_cancel";
	requested_by_instance: string;
	requested_by_role: string;
	reason: string;
	timestamp: string;
};

type PresenceStatus = "idle" | "busy" | "offline";

interface PresenceCard {
	instance: string;
	role: string;
	project: string;
	project_key: string;
	team: string[];
	model: string;
	skills: string[];
	tools: string[];
	mcp: string[];
	status: PresenceStatus;
	capacity: number;
	current_load: number;
	color: string;
	started_at: string;
	last_heartbeat: string;
	reload_requested?: boolean;
	reload_ready?: boolean;
	yano_runtime_version?: string | null;
}

interface ActivityEvent {
	channel: string; // "team:<name>" | "role:<name>" | "self"
	from: string;
	summary: string;
	timestamp: string;
}

interface PendingReply {
	resolve: (v: { response?: any; error?: string | null }) => void;
	result?: { response?: any; error?: string | null };
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: any; error?: string | null }>;
	target: string;
	created_at: string;
	// Revisione 30: true while some turn is actively blocked inside agent_await
	// racing THIS entry's promise. When a reply (or the entry-level timeout)
	// lands while awaiting is true, that turn is already live and will receive
	// the result directly as agent_await's own return value — no separate
	// wake-up is needed. When awaiting is false/undefined (the far more common
	// case: agent_send was fire-and-forget and the sender's turn has long since
	// ended), resolving the promise alone reaches nobody — see the incident
	// this fixes in handleResponse/agent_send's timeout branch below.
	awaiting?: boolean;
	// The original prompt text, kept so a wake-up message (or a timeout notice)
	// can show what was actually being waited for, not just an assignment_id.
	prompt_preview: string;
}

interface InboundContext {
	assignment_id: string;
	hops: number;
	reply_to: string;
	sender_instance: string;
	response_schema?: object | null;
	prompt_preview: string;
	fulfilled: boolean;
}

// ━━ Config: agents.yaml / roles.yaml (architecture.md §2-4) ━━━━━━━━━━━━━━━━

interface RoleConfig {
	activation?: "always" | "lazy";
	playbook?: string;
	// Optional reusable prompt name. This lets several roles/playbooks share a
	// meaningful prompt without forcing the file to be named after one role.
	prompt?: string;
	model?: { provider?: string; model?: string };
	skills?: string[];
	cli?: string[];
	mcp?: string[];
	teams?: string[];
	// Human-readable name and mission for a specialist role that has no
	// bespoke prompts/<role>.md file — see loadRolePrompt()/prompts/specialist.md.
	label?: string;
	brief?: string;
	playbook_path?: string;
	source_proposal?: string;
}

interface InstanceConfig {
	role: string;
	model?: { provider?: string; model?: string };
	skills?: string[];
	cli?: string[];
	mcp?: string[];
	teams?: string[];
	inherit_role_tools?: boolean; // default true
	color?: string;
	capacity?: number;
}

function loadYamlIfExists(file: string): any {
	try {
		if (!fs.existsSync(file)) return null;
		return parseYaml(fs.readFileSync(file, "utf-8"));
	} catch {
		return null; // best-effort — a malformed config falls back to CLI flags
	}
}

function loadConfig(cwd: string, configDir: string): {
	roles: Record<string, RoleConfig>;
	agents: Record<string, InstanceConfig>;
} {
	const dir = path.isAbsolute(configDir) ? configDir : path.join(cwd, configDir);
	const rolesDoc = loadYamlIfExists(path.join(dir, "roles.yaml"));
	const agentsDoc = loadYamlIfExists(path.join(dir, "agents.yaml"));
	return {
		roles: (rolesDoc?.roles as Record<string, RoleConfig>) || {},
		agents: (agentsDoc?.agents as Record<string, InstanceConfig>) || {},
	};
}

// Merge precedence: INSTANCE > ROLE > GLOBAL (architecture.md §3).
function resolveCapabilities(
	instanceId: string,
	cfg: { roles: Record<string, RoleConfig>; agents: Record<string, InstanceConfig> },
	roleOverride?: string,
): { role: string; playbook: string | null; model: string; skills: string[]; cli: string[]; mcp: string[]; teams: string[]; capacity: number } {
	const inst = cfg.agents[instanceId];
	const role = roleOverride || inst?.role || "unassigned";
	const roleCfg = cfg.roles[role] || {};
	const inheritRoleTools = inst?.inherit_role_tools !== false; // default true

	const model = inst?.model
		? `${inst.model.provider ?? "?"}:${inst.model.model ?? "?"}`
		: roleCfg.model
			? `${roleCfg.model.provider ?? "?"}:${roleCfg.model.model ?? "?"}`
			: "default";

	const dedupe = (a: string[] = [], b: string[] = []) => [...new Set([...(inheritRoleTools ? a : []), ...b])];

	return {
		role,
		playbook: roleCfg.playbook ?? null,
		model,
		skills: dedupe(roleCfg.skills, inst?.skills),
		cli: dedupe(roleCfg.cli, inst?.cli),
		mcp: dedupe(roleCfg.mcp, inst?.mcp),
		teams: dedupe(roleCfg.teams, inst?.teams),
		capacity: inst?.capacity ?? 1,
	};
}

// ━━ Topic hierarchy (architecture.md §23) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function topics(project: string, scope = project) {
	return {
		agentCommands: (id: string) => `pi/${scope}/agents/${id}/commands`,
		agentResponses: (id: string) => `pi/${scope}/agents/${id}/responses`,
		agentStatus: (id: string) => `pi/${scope}/agents/${id}/status`,
		agentEvents: (id: string) => `pi/${scope}/agents/${id}/events`,
		agentStatusWildcard: () => `pi/${scope}/agents/+/status`,
		roleTasks: (role: string) => `pi/${scope}/roles/${role}/tasks`,
		// A durable hand-off channel for the one case a normal role topic cannot
		// solve: the requested recipient is not live and there is no live planner
		// to receive the escalation. The continuous watcher subscribes here and
		// either forwards the original command to a planner or starts one first.
		agentFallback: () => `pi/${scope}/system/agent-fallback`,
		teamEvents: (team: string) => `pi/${scope}/teams/${team}/events`,
		// YanoOrchestrator ticket/dependency layer (see below): "something
		// happened" signals only — SQLite (orchestratorStorage/orchestrator.db)
		// is the source of truth for what's actually true, this topic is just
		// pub/sub visibility on top of it, same split the operator asked for.
		// QoS 0, not retained: a client that (re)connects always reads the real
		// state from SQLite via run_status/tickets_ready, never from a replayed
		// MQTT message.
		runEvents: (runId: string) => `pi/${scope}/runs/${runId}/events`,
	};
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function ulid(): string {
	// Same Crockford-base32 ULID generator used by coms.ts/coms-net.ts, kept
	// so assignment_id/session identifiers stay time-sortable.
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
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

function nowIso(): string {
	return new Date().toISOString();
}

function contextTextLength(value: unknown): number {
	try { return JSON.stringify(value ?? null).length; } catch { return 0; }
}

// redactRuntimeProjection moved verbatim into
// scripts/orchestrator-tools/redact.ts (Fase 4 / M0) — imported above.

function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function fallbackColor(seed: string): string {
	const h = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

// Kept as a local copy rather than importing scripts/create-project.mjs's
// slugify() — this file is a standalone extension (loaded via `pi -e
// extensions/orchestrator.ts` or globally after `pi extension install`),
// never guaranteed to sit next to scripts/ when installed, so it can't take
// on a cross-file dependency. Same normalize/strip-diacritics/kebab-case
// behavior as create-project.mjs's slugify() by design — see
// resolveDefaultProject() below for why they need to agree.
function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "progetto"
	);
}

// Revisione 38 (see docs/notes/development-notes.md) — a real incident: the
// operator scaffolded a second project and, without ever passing
// `--project`, its planner immediately saw the FIRST project's agents on
// the same local broker. Root cause: `--project` (registerFlag below)
// used to default to the literal string "default" for every single
// scaffolded project, so any two projects sharing one MQTT broker — which
// the Quickstart explicitly makes easy, one `docker compose ... up -d` per
// machine, not per project — land on the exact same `pi/default/...` topic
// tree and cross-talk. Fix: when `--project` isn't passed explicitly,
// derive a project-specific default instead of a shared constant, cheapest
// signal first:
//   1. config/project.json's own `project` field, if the workspace has
//      already been initialized (orchestrator_init ran, or `yano init` itself
//      pre-wrote it — see create-project.mjs) — this is the operator's own
//      chosen name (via --name, or a later project_name rename), slugified
//      for topic-safety since it may contain spaces ("URL Shortener").
//   2. package.json's `name` field — every project scaffolded by `yano init`
//      already gets one, kebab-case, from the same --name (create-project.mjs's
//      own slugify()); reading it here needs no workspace to exist yet, so
//      it also covers the very first launch before orchestrator_init runs.
//   3. slugify(basename(cwd)) — last resort for a project with neither
//      (e.g. hand-rolled, pre-`yano init` setup): still distinct per directory,
//      which is all that actually matters here.
//   4. "default" — only if cwd itself has no usable name (empty basename).
// `--project` still always wins when passed explicitly — this only changes
// what happens when it's omitted, which was silently unsafe before.
function resolveDefaultProject(cwd: string): string {
	try {
		const cfgPath = path.join(cwd, ".pi", "extensions", "yano-orchestrator", "config", "project.json");
		if (fs.existsSync(cfgPath)) {
			const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
			if (typeof cfg.project === "string" && cfg.project.trim()) return slugify(cfg.project);
		}
	} catch {
		// malformed/unreadable config.json — fall through to the next signal
	}
	try {
		const pkgPath = path.join(cwd, "package.json");
		if (fs.existsSync(pkgPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			if (typeof pkg.name === "string" && pkg.name.trim()) return slugify(pkg.name);
		}
	} catch {
		// malformed/unreadable package.json — fall through to the next signal
	}
	const base = path.basename(cwd);
	return base ? slugify(base) : "default";
}

interface CliFlags {
	instance?: string;
	role?: string;
	project?: string;
	projectScope?: string;
	brokerUrl?: string;
	mqttUsername?: string;
	mqttPassword?: string;
	mqttTlsCa?: string;
	mqttTlsCert?: string;
	mqttTlsKey?: string;
	mqttAllowInsecure?: boolean;
	configDir?: string;
	promptsDir?: string;
	customPrompts?: boolean;
	color?: string;
	name?: string;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	return {
		instance: (pi.getFlag("instance") as string | undefined) || undefined,
		role: (pi.getFlag("role") as string | undefined) || undefined,
		project: (pi.getFlag("project") as string | undefined) || undefined,
		projectScope: (pi.getFlag("project-scope") as string | undefined) || undefined,
		brokerUrl: (pi.getFlag("broker") as string | undefined) || undefined,
		mqttUsername: (pi.getFlag("mqtt-username") as string | undefined) || undefined,
		mqttPassword: (pi.getFlag("mqtt-password") as string | undefined) || undefined,
		mqttTlsCa: (pi.getFlag("mqtt-tls-ca") as string | undefined) || undefined,
		mqttTlsCert: (pi.getFlag("mqtt-tls-cert") as string | undefined) || undefined,
		mqttTlsKey: (pi.getFlag("mqtt-tls-key") as string | undefined) || undefined,
		mqttAllowInsecure: !!pi.getFlag("mqtt-allow-insecure"),
		configDir: (pi.getFlag("config-dir") as string | undefined) || undefined,
		promptsDir: (pi.getFlag("prompts-dir") as string | undefined) || undefined,
		customPrompts: !!pi.getFlag("custom-prompts"),
		color: (pi.getFlag("color") as string | undefined) || undefined,
		name: (pi.getFlag("name") as string | undefined) || undefined,
	};
}

// ━━ Role prompts (architecture.md pipeline: planner decompone e delega,
// coder implementa e passa la mano, reviewer verifica e informa il planner) ━━
//
// Loaded from prompts/<role>.md (relative to cwd, overridable with
// --prompts-dir) so they're editable without touching this file — same
// convention pi-pi.ts uses for .pi/agents/pi-pi/*.md. If the file is
// missing, a minimal built-in default keeps the demo working out of the box.

const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
	planner:
		"Sei l'agente planner, istanza {{INSTANCE}} nel progetto {{PROJECT}}.\n" +
		"Ogni task va isolato in un git worktree dedicato: niente tocca la directory principale del progetto finché l'intero ciclo non si conclude con successo.\n" +
		"Quando l'utente ti chiede di sviluppare qualcosa, NON implementarlo tu stesso.\n" +
		"1. Scomponi la richiesta in un task chiaro e autosufficiente per un coder.\n" +
		"2. Scegli uno slug kebab-case e chiama worktree_create con quello slug (idempotente, riusabile tra round) per ottenere worktree_path. Dentro worktree_path crea reports/<slug>.md (intestazione: Task, Worktree, Stato: in corso) — è il log condiviso di tutto quello che verrà fatto/testato, in tutti i round.\n" +
		"3. Usa agent_send con target_role: \"coder\" per delegarlo (oppure target_instance se sai già quale istanza), includendo nel prompt sia worktree_path sia il percorso del file di report al suo interno.\n" +
		"4. NON aspettare in blocco con agent_await: comunica subito all'utente che hai delegato il task, dove trova worktree/report, e che lo aggiornerai. Poi termina il turno.\n" +
		"5. Verrai risvegliato con un nuovo turno quando reviewer ti informerà che il lavoro è completato e verificato (anche dopo più round, o se reviewer è stato attivato direttamente dall'utente). Leggi il file di report nel worktree: se sei soddisfatto, appendi una sezione \"## Report finale\" col riepilogo di tutti i round/test, poi chiama worktree_finalize con lo stesso slug — è l'unico momento in cui il lavoro entra ed è committato nella directory principale — e comunica il completamento all'utente (su conflitto di merge il worktree resta intatto per revisione manuale, riportalo all'utente); se NON sei soddisfatto, appendi perché (senza chiamare worktree_finalize) e rimanda a coder con agent_send target_role: \"coder\", worktree_path incluso, e new_round: true (obbligatorio quando avvii tu un nuovo round, altrimenti rischi il limite di hop). Non superare 3 round senza concludere: oltre, chiedi indicazioni all'utente invece di continuare da solo, e non chiamare worktree_finalize finché non è chiaro come chiudere.",
	coder:
		"Sei l'agente coder, istanza {{INSTANCE}} nel progetto {{PROJECT}}.\n" +
		"Non scrivere mai direttamente nella directory principale del progetto: lavora sempre dentro il worktree_path del task (usa worktree_create con lo slug indicato se manca, è idempotente). Non chiamare mai worktree_finalize: lo fa solo il planner a fine ciclo.\n" +
		"Quando ricevi un task da planner (o una richiesta di correzione da reviewer):\n" +
		"1. Implementalo per davvero, scrivendo/modificando i file dentro worktree_path (che è condiviso con reviewer).\n" +
		"2. Scrivi ed esegui davvero dei test (non solo descriverli) dentro il worktree, e appendi al file di report indicato nel messaggio una sezione \"## Round N — coder\" con cosa hai fatto e i test eseguiti (esempio, atteso, PASS/FAIL, dettaglio) — non sovrascrivere le sezioni precedenti.\n" +
		"3. Quando hai finito, usa agent_send con target_role: \"reviewer\", includendo worktree_path e il percorso del file di report, descrivendo cosa hai fatto e chiedendo la revisione.\n" +
		"4. Non serve che tu informi direttamente il planner del completamento finale: è compito del reviewer farlo dopo aver verificato.\n" +
		"5. Concludi il turno dopo aver delegato la revisione.",
	reviewer:
		"Sei l'agente reviewer, istanza {{INSTANCE}} nel progetto {{PROJECT}}.\n" +
		"Verifica sempre il codice dentro worktree_path del task (usa worktree_create con lo slug indicato se manca, è idempotente), mai nella directory principale del progetto. Non chiamare mai worktree_finalize: lo fa solo il planner a fine ciclo.\n" +
		"Quando ricevi una richiesta di revisione da coder (o direttamente dall'utente, es. per un test che ritiene mancante):\n" +
		"1. Controlla davvero il codice dentro worktree_path (leggi i file, verifica la logica, esegui davvero i test — quelli del coder più eventuali extra), e appendi l'esito al file di report indicato in una sezione \"## Round N — reviewer\" (non sovrascrivere le sezioni precedenti).\n" +
		"2. Se va bene: usa agent_send con target_role: \"planner\", con worktree_path e il percorso del report, chiedendo esplicitamente una valutazione finale (non dare per scontato sia l'ultima parola — sarà lui a chiamare worktree_finalize).\n" +
		"3. Se NON va bene: usa agent_send con target_role: \"coder\" (worktree_path incluso) spiegando esattamente cosa correggere, e NON informare ancora il planner — quando coder risponde con la fix, ri-verifica prima di notificare planner.\n" +
		"4. Concludi il turno dopo aver inviato l'esito.",
};

// Revisione 47: THE running copy of extensions/orchestrator.ts (wherever
// `pi` actually loaded it from — the global npm package, the separate clone
// `pi extension install` maintains under ~/.pi/agent/git/..., or a local dev
// checkout) always has its own prompts/ folder sitting right next to it.
// import.meta.url resolves to THIS file's own real path regardless of which
// of those it is, so this needs no configuration and can never point at the
// wrong install — it's the fix for the actual bug behind Revisione 46 (a
// project scaffolded before a later prompt fix shipped stayed silently stuck
// on the OLD prompt forever, because `yano update` only refreshed the global
// install, never a per-project copy). `yano sync-prompts` (Revisione 46) is
// gone: there is no per-project copy to fall behind any more by default.
function resolveGlobalPromptsDir(): string {
	const thisFile = fileURLToPath(import.meta.url); // .../yano-orchestrator/extensions/orchestrator.ts
	return path.join(path.dirname(thisFile), "..", "prompts");
}

function readRolePromptFile(dir: string, name: string): string | null {
	const file = path.join(dir, `${name}.md`);
	try {
		if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8");
	} catch {
		// fall through
	}
	return null;
}

const BUILTIN_SPECIALIST_PROMPT =
	"Sei un agente specialista di ruolo {{ROLE}} ({{ROLE_LABEL}}), istanza {{INSTANCE}} nel progetto {{PROJECT}} (team: {{TEAM}}).\n" +
	"La tua missione specifica in questo ruolo: {{BRIEF}}\n{{CAPABILITIES}}\n" +
	"Lavora sempre dentro worktree_path (mai nella directory principale del progetto — usa worktree_create con lo slug indicato se manca). Usa report_append (non il tool generico di scrittura file) per aggiungere una sezione \"## Round N — {{ROLE}}\" al report, e file_claim/file_release prima di modificare un file che altri agenti dello stesso team potrebbero toccare in parallelo. Non chiamare mai worktree_finalize: lo fa solo il planner a fine ciclo.";

// Appended to every configured specialist, including roles with a dedicated
// prompt file: the planner owns final task state and must observe each result.
const MANDATORY_SPECIALIST_PLANNER_HANDOFF = `

## Handoff obbligatorio al planner

Prima di concludere **ogni** round operativo, invia sempre un messaggio con
\`agent_send\` a \`target_role: "planner"\` e lo stesso \`slug\` del task,
anche se hai già mandato il lavoro a coder, reviewer o a un altro specialista.
Questo messaggio non è un'approvazione finale e non autorizza il planner a
finalizzare il worktree: gli permette di rivalutare il task dopo la tua
modifica. Includi: stato (completato/bloccato/in attesa di verifica), cosa e
dove hai modificato o prodotto, verifiche con esito, rischi/blocchi e la
prossima azione o il destinatario già coinvolto. Se non hai potuto eseguire il
lavoro, avvisa ugualmente il planner con prerequisito mancante ed evidenza.
Non terminare il turno finché questo handoff non è stato inviato con successo.`;

// Shared fragments (prompt-optimization audit): these paragraphs were
// byte-for-byte identical across several role prompt files (coder.md,
// reviewer.md, specialist.md, docs-sync.md, security-evaluator.md,
// frontend-developer.md) — duplicated token cost on every single launch of
// those roles, not a one-time cost. Substituted via {{PLACEHOLDER}} tokens
// in the .md files themselves, same mechanism already used for
// {{INSTANCE}}/{{BRIEF}}/{{CAPABILITIES}} below. A file that doesn't contain
// a given placeholder is completely unaffected (replaceAll is a no-op).
const SLUG_REMINDER =
	"**Passa sempre `slug` a `agent_send`**: aggiunge in automatico una riga di\n" +
	"evento al report con orario e stato di tutti gli agenti in quel momento —\n" +
	"non serve che tu scriva nulla per questo, ma serve che tu passi `slug`.";

// Only for roles that normally EDIT files themselves (coder, generic
// specialist, docs-sync, frontend-developer). reviewer.md and
// security-evaluator.md keep their own distinct tool paragraph inline
// (they frame file_claim/file_release as an occasional exception, "se devi
// modificare TU STESSO", since they are read-mostly roles — a real
// difference in emphasis, not just wording, so not consolidated here).
const WORKER_TOOLS_INTRO =
	"Hai a disposizione i tool `agent_list`, `agent_send`, `agent_get`, `agent_await`,\n" +
	"`agent_publish_event`, `agent_activity` per comunicare con gli altri agenti via MQTT,\n" +
	"il tool `worktree_create` per creare/riusare il worktree git isolato di un task,\n" +
	"`report_append` per aggiungere sezioni al file di report senza rischiare di\n" +
	"cancellare quelle di altri agenti, e `file_claim`/`file_release` per coordinarti sui\n" +
	"file quando altri agenti lavorano lo stesso worktree in parallelo (vedi sotto),\n" +
	"oltre ai normali tool per leggere/scrivere file.";

const DIAGRAM_TIP =
	"## Prima di iniziare: leggi il diagramma, se esiste (Revisione 28)\n\n" +
	"Prima di esplorare il codice esistente da zero, controlla se esiste\n" +
	"`.pi/extensions/yano-orchestrator/diagrams/architecture.mmd` (nella\n" +
	"directory principale del progetto, non nel worktree — è uno stato\n" +
	"persistente cross-task, aggiornato da `architecture-diagrammer` o da\n" +
	"`docs-sync`) e leggilo: ti dà un'orientamento immediato sull'architettura\n" +
	"corrente senza dover ricostruirla leggendo ogni file — risparmia token. Non\n" +
	"è garantito che esista — se manca, procedi come sempre.";

const TURN_CLOSE_NOTE =
	"## Prima di concludere il turno: dillo sempre (Revisione 48)\n\n" +
	"Richiesta esplicita dell'operatore: nella tua ULTIMA risposta di questo\n" +
	"turno — quella visibile nel pannello/terminale di questa istanza, non solo\n" +
	"nel messaggio MQTT che mandi con `agent_send` o nella sezione che aggiungi\n" +
	"con `report_append` — di' sempre, in una riga o poche righe, cosa hai appena\n" +
	"fatto. Chi guarda il pannello di questa istanza deve poter capire l'esito\n" +
	"senza dover aprire i log MQTT o il file di report.";

// Shared context-efficiency protocol. It is injected into every role at
// runtime so custom project prompts cannot accidentally omit the policy.
const CONTEXT_EFFICIENCY_PROTOCOL = `

## Protocollo di esplorazione progressiva e contesto

Prima di esplorare il codice, leggi nell'ordine: memoria condivisa del
progetto (\`project.md\`), memoria del ruolo/istanza, diagrammi e documenti
pertinenti in \`docs/\`, quindi task e report disponibili. Valuta se queste
informazioni bastano per procedere. Se bastano, leggi solo i file direttamente
coinvolti dal task e amplia l'esplorazione solo quando una dipendenza o una
lacuna lo rende necessario. Non leggere l'intero repository per abitudine.

La memoria e la documentazione sono orientamento, non verità assoluta:
verifica nel codice, nella configurazione, nei test e nel comportamento runtime
ogni informazione critica o potenzialmente obsoleta. Non saltare test,
controlli di sicurezza, contratti API o verifiche richieste dal playbook.
Quando il progetto è inizializzato con Code Mem, usa prima il suo orientamento
bounded: \`cm recall "<task>" --level 1 --limit 6 --mode hybrid\` per la memoria
semantica e \`cm query "<domanda>"\` per il grafo di file, moduli e simboli.
Usa \`cm gn\`/\`cm gp\` solo per seguire una relazione specifica. Non eseguire
\`cm scan --deep\` a ogni turno: l'indice si aggiorna in fase di init o quando
il watcher rileva cambiamenti, mentre l'agente deve leggere il codice solo dopo
aver ristretto il perimetro.
Quando serve approfondire, annota brevemente perché nel report. Prima di
concludere il round, indica sempre: documenti consultati, file di codice
analizzati, approfondimenti aggiuntivi, informazioni mancanti/non verificate,
verifiche eseguite e relativo esito. Non inventare fatti o risultati.`;

const REPORT_ARTIFACT_PROTOCOL = `

## Report di progetto

Il report condiviso del task resta quello indicato dal planner e serve al
coordinamento dei round. Ogni relazione, valutazione, audit o deliverable
documentale autonomo deve invece essere salvato nel progetto in
\`docs/reports/<tipo>-<gg-mm-HH_MM>.md\`, usando data e ora locali italiane
(giorno-mese-ora_minuti), con un tipo descrittivo e senza nomi generici.
Prima di crearne uno controlla se esiste già una relazione dello stesso tipo
nella stessa finestra temporale e aggiornala invece di duplicarla. Riporta
sempre fonti, evidenze, score/confidenza, limiti e stato; non inventare dati.`;

// Near-identical across specialist.md, security-evaluator.md, docs-sync.md.
// coder.md keeps its own wording (it's about the SAME ticket layer but the
// surrounding numbered list differs enough — "se manca uno dei due" vs "se
// manca un ticket_id" framing — not consolidated to avoid renumbering risk
// in a file with its own distinct step sequence).
const TICKET_CLAIM_STEP0 =
	"0. **Se il messaggio che ti ha coinvolto include anche un `ticket_id`\n" +
	"   (Revisione 26 — layer ticket/DAG persistente)**, chiama subito\n" +
	"   `ticket_claim({ ticket_id })` prima di iniziare — registra questa\n" +
	"   istanza come assegnataria sul layer persistente, non solo sul piano a\n" +
	"   fasi del planner. Se rifiuta (ticket già claimato, o capability\n" +
	"   mancanti), fermati e segnalalo nel report invece di procedere. **Non\n" +
	"   chiamare mai tu `ticket_complete`**: è il planner a deciderlo, quando\n" +
	"   giudica il tuo contributo concluso (vedi `prompts/planner.md`), non\n" +
	"   appena hai finito. Se il messaggio non include un `ticket_id`, procedi\n" +
	"   normalmente: quel layer resta opzionale dal tuo punto di vista.";

// primaryDir is consulted FIRST, file by file (<role>.md, then specialist.md
// if roleCfg has a brief) — fallbackDir (pass null to skip it entirely) is
// consulted only for whichever specific file primaryDir doesn't have. This
// is what makes --custom-prompts safe to turn on for just ONE role: any
// other role's file simply isn't in the project's custom prompts folder, so
// it transparently keeps reading the installed package's own (always
// current) version instead of silently freezing on whatever `yano
// copy-prompts` happened to copy that one time — the exact staleness this
// revision exists to close, but now impossible even for a customized
// project, not just the (new) default of no local copy at all.
function loadRolePrompt(primaryDir: string, fallbackDir: string | null, role: string, roleCfg?: RoleConfig): string {
	// Planner/coder/reviewer have their own deliberate terminal handoff
	// protocol. frontend-reviewer is the frontend equivalent of reviewer
	// (same "final gate before planner" function in the mandatory
	// planner -> frontend-developer -> frontend-reviewer -> planner flow,
	// prompts/frontend-reviewer.md) and was missing from this list — the
	// generic "this is not a final approval" framing of
	// MANDATORY_SPECIALIST_PLANNER_HANDOFF below is actively misleading for
	// an approval message that IS the final gate. Every other configured
	// role is a specialist for this rule.
	const requiresPlannerHandoff = Boolean(roleCfg?.brief) && !["planner", "coder", "reviewer", "frontend-reviewer"].includes(role);
	if (roleCfg?.prompt) {
		const fromPromptAlias = readRolePromptFile(primaryDir, roleCfg.prompt);
		if (fromPromptAlias !== null) return requiresPlannerHandoff ? `${fromPromptAlias}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}` : fromPromptAlias;
		if (fallbackDir) {
			const fallbackPromptAlias = readRolePromptFile(fallbackDir, roleCfg.prompt);
			if (fallbackPromptAlias !== null) return requiresPlannerHandoff ? `${fallbackPromptAlias}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}` : fallbackPromptAlias;
		}
	}
	const fromPrimary = readRolePromptFile(primaryDir, role);
	if (fromPrimary !== null) return requiresPlannerHandoff ? `${fromPrimary}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}` : fromPrimary;
	if (fallbackDir) {
		const fromFallback = readRolePromptFile(fallbackDir, role);
		if (fromFallback !== null) return requiresPlannerHandoff ? `${fromFallback}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}` : fromFallback;
	}
	if (roleCfg?.brief) {
		const specialistFromPrimary = readRolePromptFile(primaryDir, "specialist");
		if (specialistFromPrimary !== null) return `${specialistFromPrimary}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}`;
		if (fallbackDir) {
			const specialistFromFallback = readRolePromptFile(fallbackDir, "specialist");
			if (specialistFromFallback !== null) return `${specialistFromFallback}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}`;
		}
		return `${BUILTIN_SPECIALIST_PROMPT}${MANDATORY_SPECIALIST_PLANNER_HANDOFF}`;
	}
	return DEFAULT_ROLE_PROMPTS[role] || `Sei l'agente ${role}, istanza {{INSTANCE}} nel progetto {{PROJECT}}. Usa agent_list/agent_send/agent_get/agent_await per collaborare con gli altri agenti.`;
}

function roleCapabilitiesPrompt(roleCfg?: RoleConfig): string {
	const skills = roleCfg?.skills?.length ? roleCfg.skills.join(", ") : "nessuna skill dichiarata";
	const cli = roleCfg?.cli?.length ? roleCfg.cli.join(", ") : "nessuna CLI dichiarata";
	const mcp = roleCfg?.mcp?.length ? roleCfg.mcp.join(", ") : "nessun MCP dichiarato";
	const activation = roleCfg?.activation === "lazy" ? "lazy: installazione/verifica eseguita quando il planner lancia questo ruolo" : "core: prerequisiti verificati da yano init/doctor";
	const playbook = roleCfg?.playbook || "default-orchestration";
	const playbookPath = roleCfg?.playbook_path ? `\n- Sorgente playbook immutabile: ${roleCfg.playbook_path}` : "";
	const proposal = roleCfg?.source_proposal ? `\n- Proposta Architect: ${roleCfg.source_proposal}` : "";
	return `## Contratto delle capacità (enforced da roles.yaml)\n- Playbook: ${playbook}${playbookPath}${proposal}\n- Attivazione: ${activation}\n- Skill autorizzate: ${skills}\n- CLI autorizzate: ${cli}\n- MCP autorizzati: ${mcp}\nUsa solo queste capacità. Se una è mancante, interrompi il round, descrivi il comando/documentazione per risolvere e informa il planner; non sostituirla silenziosamente con strumenti equivalenti.`;
}

function apiRegistryPrompt(root: string): string {
	const apis = listProjectApis(root).filter((api) => api.enabled !== false);
	if (!apis.length) return "";
	const rows = apis.map((api) => `- ${api.name}: ${api.base_url} — ${api.description} (metodi: ${api.methods.join(", ")}; scope: ${api.scope}; autenticazione: ${api.auth_env ? `${api.auth_header} da variabile protetta` : "nessuna dichiarata"})`);
	return `\n\n## REST API utente disponibili\nQueste API sono state registrate esplicitamente dall'utente per questo progetto o globalmente. Usale solo se la descrizione è pertinente al task, rispetta i metodi dichiarati e non inventare endpoint. Per richieste mutanti chiedi conferma secondo il playbook.\n${rows.join("\n")}\nPer chiamarle usa il tool \`api_request\`; il tool limita host, metodi e credenziali al registro.`;
}

// ━━ Terminal/pane/tab display integration (Fase 2 / M1) ━━━━━━━━━━━━━━━━━
//
// setTerminalTitle/herdrReportAgent/herdrRenamePane/herdrRenameTab/
// paseoDetectAndLog were extracted verbatim into
// scripts/yano-terminal-integration.ts — all pure process.env + execFile,
// no orchestrator state (paseoDetectAndLog takes logEvent explicitly).
// Imported below.

// git-worktree isolation primitives (SLUG_RE/execGit/worktreePaths/
// normalizePath/ensureWorktreesGitignored/assertGitRepo/findExistingWorktree)
// moved verbatim into scripts/orchestrator-tools/git-worktree.ts
// (Fase 5 / M0) — imported above.

// ━━ YanoOrchestrator ticket/dependency layer (Revisione 26) ━━━━━━━━━━
//
// First vertical slice of the ticket/DAG/SQLite orchestration layer agreed
// with the operator on top of the existing MQTT+worktree+roster+phase-gate
// system (see docs/notes/development-notes.md). Deliberate split, as specified by the
// operator:
//
//   MQTT   -> "something happened" — fast pub/sub signals (ticket_ready,
//             ticket_started, ticket_done, run_completed, ...), same bus
//             agent_send/agent_publish_event already use.
//   SQLite -> "what is actually true" — durable state for runs, specs,
//             tickets, ticket_dependencies, events, checkpoints, living at
//             .pi/extensions/yano-orchestrator/orchestratorStorage/
//             orchestrator.db. Nothing here replaces the existing per-task
//             reports/<slug>.plan.json phase gate — that keeps working
//             unchanged for tasks that use it. This is an ADDITIONAL,
//             opt-in way to model a task as a spec + a dependency graph of
//             canonical internal tickets, scheduled deterministically
//             (READY/BLOCKED/execution waves computed from data, never
//             stored redundantly) instead of a hand-declared phase list.
//
// Explicitly deferred to a follow-up (per the agreed "vertical slice
// first" scope): the Playbook engine, replanning, the integration phase,
// full crash/timeout retry with fencing tokens (a ticket left "running"
// when its process dies is surfaced as such by run_status/tickets_ready,
// not automatically requeued yet), budget enforcement, the architecture
// map/index generator, and vendoring To-Tickets. See docs/notes/development-notes.md,
// Revisione 26, for the full list and rationale.
//
// Honest limit: node:sqlite (DatabaseSync) is used directly, verified only
// against this sandbox's Node 22.22.2 — it is an experimental Node API
// (stable without a flag on this version, per the ExperimentalWarning it
// still prints). Whether the Node build `pi` itself bundles/uses also has
// node:sqlite available is NOT verified here — same class of "verified in
// isolation, not against the real binary" limit already flagged for
// Herdr elsewhere in this file.

const YANO_SCHEMA_VERSION = 1;
const YANO_EXTENSION_VERSION = "0.1.0-slice1";

function loadRuntimePackageVersion(): string | null {
	try {
		const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
		return typeof packageJson.version === "string" ? packageJson.version : null;
	} catch {
		return null;
	}
}

const YANO_RUNTIME_PACKAGE_VERSION = loadRuntimePackageVersion();

function yanoWorkspaceDir(projectCwd: string, explicitProject?: string): string {
	const modern = path.join(projectCwd, ".pi", "extensions", "yano-orchestrator");
	const readConfig = (dir: string): any | null => {
		try { return JSON.parse(fs.readFileSync(path.join(dir, "config", "project.json"), "utf8")); } catch { return null; }
	};
	const modernConfig = readConfig(modern);
	if (modernConfig && (!explicitProject || String(modernConfig.project) === String(explicitProject))) return modern;
	// Compatibility with projects scaffolded before the workspace rename. Do
	// not move or rewrite that state: select the existing extension directory
	// by its project config and durable database, then keep writing there.
	try {
		const extensionsRoot = path.join(projectCwd, ".pi", "extensions");
		for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = path.join(extensionsRoot, entry.name);
			if (!fs.existsSync(path.join(candidate, "orchestratorStorage", "orchestrator.db"))) continue;
			const config = readConfig(candidate);
			if (config && (!explicitProject || String(config.project) === String(explicitProject))) return candidate;
		}
	} catch { /* use the canonical path when no legacy workspace is present */ }
	return modern;
}

// Revisione 28: "logs" removed from this list (was created but never
// written to by any tool — dead scaffold). This workspace's own event
// trail already lives in SQLite (the `events` table, written by
// recordEvent()), so a second, parallel logs/*.jsonl location here would
// only duplicate it.
//
// Revisione 37: "reports", "prompts", and "logs" ADDED back — this time on
// purpose, at the operator's explicit request. Root-level reports/<slug>.md
// and prompts/<role>.md, and the ROOT-level logs/<instance>.jsonl (Revisione
// 18) all used to live directly under the project root, tracked by git like
// any other source file. The operator's point: these are process artifacts
// of THIS project's development with `yano-orchestrator` — the planner's
// task reports, the role prompts, the raw debug trace — not the project's
// own deliverable. If the scaffolded project is later pushed to a public
// GitHub repo, they'd sit right next to the real application code, fully
// public, revealing internal AI-orchestration process and possibly
// hand-tuned prompts that are effectively personal working notes. Moving
// all three under `.pi/extensions/yano-orchestrator/`, which has been
// gitignored by every scaffolded project since Revisione 31, makes "not
// tracked, not pushed, stays only on the machine where the project was
// developed" the default with zero extra configuration. See
// docs/notes/development-notes.md, Revisione 37, for the full rationale
// (including why prompts/ is NOT meant to be edited per-project in the
// first place — role prompts are customized in the extension itself, once,
// for every project, not forked per scaffold).
function yanoSubdirs(workspaceDir: string) {
	return {
		config: path.join(workspaceDir, "config"),
		specs: path.join(workspaceDir, "specs"),
		playbooks: path.join(workspaceDir, "playbooks"),
		diagrams: path.join(workspaceDir, "diagrams"),
		knowledge: path.join(workspaceDir, "knowledge"),
		policies: path.join(workspaceDir, "policies"),
		artifacts: path.join(workspaceDir, "artifacts"),
		overrides: path.join(workspaceDir, "overrides"),
		orchestratorStorage: path.join(workspaceDir, "orchestratorStorage"),
		reports: path.join(workspaceDir, "reports"),
		prompts: path.join(workspaceDir, "prompts"),
		logs: path.join(workspaceDir, "logs"),
	};
}

interface YanoProjectConfig {
	schema_version: number;
	extension_version: string;
	project: string;
	created_at: string;
	updated_at: string;
}

// Idempotent by construction: fs.mkdirSync(..., {recursive:true}) never
// fails on an already-existing directory, and config/project.json is only
// written fresh if it doesn't already exist (existing state is never
// destroyed/overwritten by re-running this) — required by the operator's
// plan §4 ("initialization must be idempotent... must not destroy existing
// state").
//
// `project` is identity.project — the MQTT topic-scope value (defaults to
// the literal string "default" if --project was never passed at launch,
// see registerFlag("project") above) — used ONLY as the fallback name on
// first-ever init. `projectNameOverride` (Revisione 28) is a separate,
// human-chosen display name (e.g. what the planner asked the user to call
// this project) that, when given, always wins and is written to
// config/project.json regardless of whether the config already existed —
// this is what lets a project have a real name distinct from the MQTT
// scope, which the planner never asks the user to change.
function yanoEnsureWorkspace(projectCwd: string, project: string, projectNameOverride?: string): YanoProjectConfig {
	const workspaceDir = yanoWorkspaceDir(projectCwd, project);
	const dirs = yanoSubdirs(workspaceDir);
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	const configPath = path.join(dirs.config, "project.json");
	const now = nowIso();
	let cfg: YanoProjectConfig;
	if (fs.existsSync(configPath)) {
		try {
			cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		} catch {
			// Malformed config from a previous run — rewrite it rather than
			// crashing init, but never silently lose the workspace/db that
			// already exist alongside it.
			cfg = { schema_version: YANO_SCHEMA_VERSION, extension_version: YANO_EXTENSION_VERSION, project, created_at: now, updated_at: now };
		}
		cfg.updated_at = now;
		cfg.extension_version = YANO_EXTENSION_VERSION; // record which code last touched this workspace
		if (projectNameOverride) cfg.project = projectNameOverride;
	} else {
		cfg = { schema_version: YANO_SCHEMA_VERSION, extension_version: YANO_EXTENSION_VERSION, project: projectNameOverride || project, created_at: now, updated_at: now };
	}
	fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
	return cfg;
}

// ━━ Canonical records + SQLite storage (Fase 2 / M0) ━━━━━━━━━━━━━━━━━━━━━
//
// RunRecord/SpecRecord/TicketRecord/DependencyRecord/DecisionHoldRecord/
// EventRecord, the OrchestratorStorage interface, and SQLiteOrchestratorStorage
// (the only implementation) were extracted verbatim into
// scripts/yano-orchestrator-storage.ts — that class had zero references to
// identity/pi/ctx/mqttClient/sendNotifications, making it the lowest-risk
// region to pull out of this file first. Imported below.

// ━━ Deterministic scheduler: READY/BLOCKED + execution waves ━━━━━━━━━━━━━━
//
// Pure functions over plain data (TicketRecord[]/DependencyRecord[]) — no
// SQL, no LLM reasoning, matching architecture.md's principle that
// everything past the Task Architect/spec-and-ticket authoring step is
// deterministic code (§1, §9-11). "Ready"/"blocked" are always COMPUTED,
// never stored as a ticket status, so there is exactly one place ticket
// state can drift from reality.

// yanoComputeReadyBlocked/yanoComputeExecutionWaves moved verbatim into
// scripts/orchestrator-tools/ticket-scheduling.ts (Fase 4 / M5) — used by
// both the ticket_* tools (moved alongside them) and run_status (stays
// below; imported above).

// ━━ Watchdog: detect tickets stuck RUNNING with no progress (Revisione 29) ━━
// Pure/deterministic given `nowMs` (never calls Date.now() itself) so it can
// be unit-tested with a controlled clock instead of actually waiting — see
// scripts/smoke-test-watchdog.mjs. `ticket.updated_at` while status ===
// "running" is exactly the ticket_claim timestamp (updateTicketStatus bumps
// it on every status change and nothing else touches a running ticket's row
// until ticket_complete), so no extra "last progress" column/event is
// needed — the existing field already is that signal.
interface StalledTicketInfo {
	run_id: string;
	ticket_id: string;
	title: string;
	assigned_instance: string | null;
	running_since: string;
	elapsed_ms: number;
}

// Fase 1 / M4: thin adapter over the shared, canonical detector
// (scripts/watcher/detect-stalled-tickets.mjs) — this file's own semantics
// (active-run scoping + inclusive `>=`) were chosen as the one source of
// truth both this watchdog and the standalone scripts/watch-stalls.mjs now
// delegate to. Behavior here is unchanged from before this refactor: this
// function still only considers runs with status === "active" and still
// excludes any run with an open decision hold (that remains an intentional
// pause, not a stall — a worker may have completed its preflight turn and
// exited while the planner waits for the user's answer).
export function yanoFindStalledTickets(storage: OrchestratorStorage, project: string, nowMs: number, stallMs: number): StalledTicketInfo[] {
	const runs = storage.listRuns(project);
	const activeRuns = runs.filter((r) => r.status === "active");
	const openHoldRunIds = new Set(activeRuns.filter((run) => storage.listDecisionHolds(run.id, "open").length > 0).map((run) => run.id));
	const tickets = activeRuns.flatMap((run) => storage.listTickets(run.id));
	return detectStalledTickets({ tickets, runs: activeRuns, openHoldRunIds }, nowMs, stallMs) as StalledTicketInfo[];
}

// ━━ Watchdog: detect runs stuck "completed" with no finalize/notify follow-up
// (Revisione 40) ━━ See WATCHDOG_FINALIZE_GRACE_MS above for why this exists
// and why it's a separate check from yanoFindStalledTickets: ticket_complete's
// own allDone branch already flips a run to "completed" the instant every one
// of its tickets reaches "done" — at that point there is, by definition,
// nothing left "running" for yanoFindStalledTickets to notice, even though the
// operator-facing half of the job (merge the worktree, send the completion
// notification) may never have happened. Pure/deterministic given `nowMs`,
// same testability discipline as yanoFindStalledTickets — see
// scripts/smoke-test-watchdog.mjs.
interface UnfinalizedRunInfo {
	run_id: string;
	objective: string;
	completed_at: string;
	elapsed_ms: number;
}

function yanoFindUnfinalizedRuns(storage: OrchestratorStorage, project: string, nowMs: number, graceMs: number): UnfinalizedRunInfo[] {
	// Completed is terminal. Finalization is an administrative/user gate, not an
	// operational liveness signal; returning it here used to wake planners
	// forever after a manual merge or an answered decision hold.
	void storage;
	void project;
	void nowMs;
	void graceMs;
	return [];
}

// ━━ Watchdog: detect tickets whose assigned instance is confirmably GONE
// (Revisione 42) ━━ See the WATCHDOG_AUTO_TERMINATE_* comment above for the
// real incident this covers. Pure/deterministic given a presence snapshot
// (never reads the live module-level `presence` Map directly, never calls
// Date.now()) so it stays unit-testable the same way as
// yanoFindStalledTickets/yanoFindUnfinalizedRuns — see
// scripts/smoke-test-instance-liveness.mjs. Unlike those two, this needs NO
// elapsed-time threshold at all: presence is either there (instance
// confirmably connected) or it isn't (LWT already fired, or the client-side
// staleSweepTimer already pruned it after STALE_AFTER_MS of silence) — a
// ticket "running" against an instance with no live presence card is not a
// guess, it's a fact.
interface OrphanedTicketInfo {
	run_id: string;
	ticket_id: string;
	title: string;
	assigned_instance: string;
	running_since: string;
}

function yanoFindOrphanedTickets(
	storage: OrchestratorStorage,
	project: string,
	presenceSnapshot: Map<string, { status: PresenceStatus }>,
	options: { ignoreOpenDecisionHolds?: boolean } = {},
): OrphanedTicketInfo[] {
	const orphaned: OrphanedTicketInfo[] = [];
	const runs = storage.listRuns(project).filter((r) => r.status === "active");
	for (const run of runs) {
		// The audit/reconciliation caller still needs to see the dangling state.
		// Operational watchdog callers can opt out so an intentional human gate
		// is not turned into a failure or a relaunch request.
		if (options.ignoreOpenDecisionHolds && storage.listDecisionHolds(run.id, "open").length > 0) continue;
		for (const t of storage.listTickets(run.id)) {
			if (t.status !== "running" || !t.assigned_instance) continue;
			const card = presenceSnapshot.get(t.assigned_instance);
			if (!card || card.status === "offline") {
				orphaned.push({ run_id: run.id, ticket_id: t.id, title: t.title, assigned_instance: t.assigned_instance, running_since: t.updated_at });
			}
		}
	}
	return orphaned;
}

function yanoReconcilePersistedState(storage: OrchestratorStorage, project: string, presenceSnapshot: Map<string, { status: PresenceStatus }>): number {
	let count = 0;
	for (const run of storage.listRuns(project).filter((candidate) => candidate.status === "active")) {
		const dangling = yanoFindOrphanedTickets(storage, project, presenceSnapshot).filter((ticket) => ticket.run_id === run.id);
		const open_holds = storage.listDecisionHolds(run.id, "open");
		if (!dangling.length && !open_holds.length) continue;
		const findings = {
			dangling: dangling.map((ticket) => ({ ticket_id: ticket.ticket_id, title: ticket.title, assigned_instance: ticket.assigned_instance, running_since: ticket.running_since })),
			open_holds: open_holds.map((hold) => ({ id: hold.id, question: hold.question, owner: hold.owner, generation: hold.generation, expires_at: hold.expires_at })),
		};
		storage.createCheckpoint(run.id, "reconcile_sweep", { findings, project, observed_at: nowIso() });
		storage.recordEvent(run.id, "reconcile_sweep", findings);
		count++;
	}
	return count;
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	pi.registerFlag("instance", {
		description: "Agent instance id (must match a key in agents/agents.yaml, e.g. coder-01). Required only for an orchestrated Yano agent; plain `pi` remains a normal human session.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("role", {
		description: "Role override (otherwise read from agents.yaml for --instance).",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("project", {
		description:
			"Project namespace — scopes the MQTT topic tree pi/<project>/... . Defaults to this project's own " +
			"identity (config/project.json, then package.json's name, then the directory name) so two different " +
			"projects never collide on a shared broker without you having to pass this on every launch — only " +
			"set it explicitly if you deliberately want two directories to share one topic tree.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("project-scope", {
		description: "Stable MQTT scope override for Yano system services; use only for an explicitly shared service namespace.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("broker", {
		description: "MQTT broker URL, e.g. mqtt://localhost:1883 or mqtts://host:8883",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("mqtt-username", { description: "MQTT username, if the broker requires auth", type: "string", default: undefined });
	pi.registerFlag("mqtt-password", { description: "MQTT password, if the broker requires auth", type: "string", default: undefined });
	pi.registerFlag("mqtt-tls-ca", { description: "CA certificate path for mqtts:// brokers", type: "string", default: undefined });
	pi.registerFlag("mqtt-tls-cert", { description: "Client certificate path for mutual TLS", type: "string", default: undefined });
	pi.registerFlag("mqtt-tls-key", { description: "Client private key path for mutual TLS", type: "string", default: undefined });
	pi.registerFlag("mqtt-allow-insecure", { description: "Disable TLS certificate verification (development only)", type: "boolean", default: false });
	pi.registerFlag("config-dir", { description: "Directory containing agents.yaml/roles.yaml", type: "string", default: "agents" });
	pi.registerFlag("prompts-dir", {
		description:
			"Directory containing this PROJECT's own custom <role>.md prompts (only consulted when --custom-prompts is " +
			"also passed — see that flag). Defaults to .pi/extensions/yano-orchestrator/prompts, the same place " +
			"`yano copy-prompts` writes to.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("custom-prompts", {
		description:
			"Revisione 47: by default, role prompts are ALWAYS read from the currently-installed package's own " +
			"prompts/ folder (next to this extension file) — never from a per-project copy — so a `yano update` " +
			"takes effect immediately for every project, with nothing to resync. Pass this flag to instead load " +
			"THIS project's own customized prompts (see `yano copy-prompts`) from --prompts-dir (or its default, " +
			"<project>/.pi/extensions/yano-orchestrator/prompts). Missing a specific <role>.md there — or the " +
			"whole directory not existing at all (e.g. `yano copy-prompts` was never run) — falls back automatically " +
			"to the installed package's own prompt for that role, file by file, never a hard error.",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("name", {
		description:
			"Display name for this agent's terminal pane/tab (used by multiplexers like herdr, via the terminal title). " +
			"Defaults to --instance, so panes are named exactly like the agent instance unless you override this.",
		type: "string",
		default: undefined,
	});

	// ━━ State ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let identity: {
		instance: string;
		displayName: string; // instance by default; overridable with --name, used for the terminal title (herdr et al.) and local status/notify text — never for MQTT topics/addressing, which always use `instance`
		role: string;
		playbook: string | null;
		project: string;
		team: string[];
		model: string;
		color: string;
		cwd: string;
		capacity: number;
		skills: string[]; // resolved role+instance skills (architecture.md §3-4) — used by ticket_claim's capability match
	} | null = null;
	let identityLeasePath: string | null = null;
	function acquireIdentityLease(root: string, project: string, instance: string): void {
		const key = crypto.createHash("sha256").update(`${projectKey(root, project)}\0${instance}`).digest("hex");
		const dir = path.join(traceRoot(), "agent-identities");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const leasePath = path.join(dir, `${key}.lock`);
		try {
			const fd = fs.openSync(leasePath, "wx", 0o600);
			fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, root, project, instance, created_at: nowIso() }));
			fs.closeSync(fd);
			identityLeasePath = leasePath;
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let stale = false;
		try {
			const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
			try { process.kill(Number(lease.pid), 0); } catch { stale = true; }
		} catch { stale = true; }
		if (!stale) throw new Error(`identità già in uso nel progetto: ${instance} (${root}); avvio rifiutato per evitare due agenti con lo stesso nome`);
		try { fs.unlinkSync(leasePath); } catch { /* another supervisor may have repaired it */ }
		const fd = fs.openSync(leasePath, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, root, project, instance, created_at: nowIso() }));
		fs.closeSync(fd);
		identityLeasePath = leasePath;
	}
	function releaseIdentityLease(): void {
		if (!identityLeasePath) return;
		try { fs.unlinkSync(identityLeasePath); } catch { /* best effort */ }
		identityLeasePath = null;
	}
	let client: MqttClient | null = null;
	let T: ReturnType<typeof topics> | null = null;
	const presence = new Map<string, PresenceCard>();
	const pendingReplies = new Map<string, PendingReply>();
	const inboundQueue = new Map<string, InboundContext>();
	const seenAssignments = new Map<string, number>(); // assignment_id -> seenAt, QoS1 redelivery dedupe
	const activityLog: ActivityEvent[] = [];
	// Live tool inventory for the bottom widget. Entries exist only between the
	// Pi tool start/end hooks, so the panel describes what is happening now,
	// not a stale history of previous calls.
	const activeOperations = new Map<string, { kind: string; label: string; started_at: number }>();
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let staleSweepTimer: NodeJS.Timeout | null = null;
	let watchdogTimer: NodeJS.Timeout | null = null;
	// Opened lazily by the ticket tools. Presence may still use it on each
	// heartbeat to reconcile ownership changes made by another instance (most
	// importantly: the planner completing a worker's ticket after review).
	let yanoStorage: SQLiteOrchestratorStorage | null = null;
	let presenceRevision = 0;
	let presencePublishChain: Promise<void> = Promise.resolve();
	// Retained MQTT presence arrives asynchronously after subscribe. Keep a
	// short bounded hydration barrier so the first agent_list cannot expose an
	// intermediate roster while the broker delivers retained peer states.
	let presenceHydration: Promise<void> = Promise.resolve();
	// The watchdogAlertLevel/watchdogRunAlerted/watchdogOrphanAlerted/
	// watchdogAutoTerminated alert-dedup caches moved to scripts/watcher/
	// watchdog-sweep.ts (Fase 2 / M3) — createWatchdogSweep() now owns them as
	// factory-closure state, created once per call, same lifetime as before
	// (this file only ever calls it once, below).
	// Tickets this instance currently holds "running" (ticket_claim..ticket_complete),
	// tracked here because agent_send's own inboundQueue (below) is a DIFFERENT
	// completion signal — an instance can be deep into real ticket work with a
	// long-since-fulfilled (or never-held) inbound entry, which is exactly the
	// mismatch an operator caught in production: docs-sync-02 showed "idle" in
	// the MQTT presence widget while its own pane was actively editing files for
	// minutes (Revisione 40, docs/notes/development-notes.md). Presence "busy" now
	// reflects EITHER signal, not just inboundQueue.
	const activeTicketIds = new Set<string>();
	function refreshActiveTicketIdsFromStorage(): void {
		if (!identity || !yanoStorage) return;
		try {
			const current = new Set<string>();
			for (const run of yanoStorage.listRuns(identity.project)) {
				for (const ticket of yanoStorage.listTickets(run.id)) {
					if (ticket.status === "running" && ticket.assigned_instance === identity.instance) current.add(ticket.id);
				}
			}
			activeTicketIds.clear();
			for (const ticketId of current) activeTicketIds.add(ticketId);
		} catch {
			// SQLite is advisory for presence. Keep the last local snapshot if the
			// database is temporarily locked or unavailable.
		}
	}
	function currentLoad(): number {
		refreshActiveTicketIdsFromStorage();
		return Math.max(inboundQueue.size, activeTicketIds.size);
	}
	function computeSelfStatus(): PresenceStatus {
		refreshActiveTicketIdsFromStorage();
		return inboundQueue.size > 0 || activeTicketIds.size > 0 ? "busy" : "idle";
	}
	let currentCtx: ExtensionContext | null = null;
	let currentInputScreenshots: unknown[] = [];
	// Collected by tool_execution_end below and consumed/reset at turn_end by
	// updateAgentMemory() (Revisione 67) — deterministic, zero-LLM-call input
	// for the "structured lessons" memory: which tool calls failed THIS turn,
	// so the next turn (or a resumed/restarted instance) can see it and the
	// repeat-detection in yano-agent-memory.mjs can flag "you already tried
	// this and it failed" instead of staying silent.
	let currentTurnToolFailures: Array<{ tool: string; error: string }> = [];
	function inputScreenshotReferences(event: any): unknown[] {
		const candidates = Array.isArray(event?.images) ? event.images : (Array.isArray(event?.message?.content) ? event.message.content : []);
		return candidates.filter((item: any) => item && (item.type === "image" || item.type === "input_image" || item.path || item.url || item.data)).map((item: any) => ({
			path: item.path,
			url: item.url,
			data: item.data,
			name: item.name || item.filename,
			mime_type: item.mime_type || item.mimeType,
		})).slice(0, 8);
	}
	let projectBootstrap = "";
	let projectBootstrapDelivered = false;
	let currentInbound: InboundContext | null = null;
	let contextCompactionInFlight = false;
	let reloadRequested = false;
	function reloadReady(): boolean {
		// Hidden model generation is not recoverable. Readiness means all
		// observable delegated work and persisted ticket ownership are quiescent;
		// the trace/checkpoint is the semantic continuation contract.
		refreshActiveTicketIdsFromStorage();
		const unresolvedReplies = [...pendingReplies.values()].some((entry) => !entry.result || entry.awaiting === true);
		return reloadRequested && !currentInbound && !unresolvedReplies && inboundQueue.size === 0 && activeTicketIds.size === 0;
	}
	let mqttConnected = false;
	let everConnected = false; // distinguishes "connecting…" (first attempt) from "reconnecting…" (dropped after being up) in the widget

	function pushActivity(ev: ActivityEvent) {
		activityLog.push(ev);
		if (activityLog.length > ACTIVITY_LOG_CAP) activityLog.shift();
	}
	function operationId(event: any): string {
		return String(event?.toolCallId ?? event?.tool_call_id ?? event?.id ?? `tool-${Date.now()}-${Math.random()}`);
	}
	function operationLabel(event: any): { kind: string; label: string } {
		const raw = event?.toolName ?? event?.tool_name ?? event?.name;
		const args = event?.args ?? event?.input ?? event?.parameters ?? {};
		const mcpDetail = typeof args === "object" && args
			? [args.server, args.server_name, args.mcp_server, args.tool, args.tool_name].filter(Boolean).join("/")
			: "";
		const name = mcpDetail || String(raw || "tool");
		if (name === "agent_send" || name === "agent_await" || name === "agent_get" || name === "agent_list") return { kind: "AGENT", label: name };
		if (/^(mcp__|mcp[-_:]|[A-Za-z0-9_-]+\.)/.test(name) || name.includes("mcp")) return { kind: "MCP", label: name.replace(/^mcp__/, "") };
		if (["bash", "read", "write", "edit", "grep", "find", "ls", "command", "shell"].includes(name)) return { kind: "CLI", label: name };
		if (/playbook|plan_/i.test(name)) return { kind: "PLAYBOOK", label: name };
		return { kind: "TOOL", label: name };
	}
	function beginOperation(event: any): void {
		const operation = operationLabel(event);
		activeOperations.set(operationId(event), { ...operation, started_at: Date.now() });
		requestPoolRedraw();
	}
	function endOperation(event: any): void {
		const id = operationId(event);
		if (activeOperations.has(id)) activeOperations.delete(id);
		else {
			const tool = String(event?.toolName ?? event?.tool_name ?? event?.name ?? "");
			for (const [key, operation] of activeOperations) if (operation.label === tool) activeOperations.delete(key);
		}
		requestPoolRedraw();
	}

	// ━━ Global trace store ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Tracing is deliberately outside the project checkout. It survives
	// worktree finalization, is not committed with the application, and can be
	// selected/deleted with `yano trace`. The operational ticket DB remains in
	// the project workspace; these files are the forensic trace only.

	// Contatore monotono per-processo (Revisione 20): due eventi di istanze
	// DIVERSE possono avere lo stesso timestamp ISO (risoluzione al
	// millisecondo) se capitano abbastanza vicini — successo in un run di
	// test reale, dove ha rotto l'ordinamento cronologico di
	// review-log.mjs proprio sulla coppia agent_send_out/wake_in che è il
	// caso che più conta diagnosticare. `seq` da solo non basta a ordinare
	// tra istanze diverse (ogni processo ha il proprio contatore), ma dà a
	// review-log.mjs un aggancio per riconoscere e correggere il caso
	// specifico invio→risveglio via `assignment_id` (vedi lì).
	let logSeq = 0;

	function logEvent(type: string, data: Record<string, unknown> = {}): void {
		if (!identity) return;
		try {
			const config = getTraceConfig({ cwd: identity.cwd, project: identity.project });
			if (!traceEnabled(config.mode, "events")) return;
			const paths = ensureTraceProject({ cwd: identity.cwd, project: identity.project, instance: identity.instance });
			const line = `${JSON.stringify({ ts: nowIso(), seq: ++logSeq, instance: identity.instance, role: identity.role, project: identity.project, project_key: paths.projectKey, trace_mode: config.mode, type, ...redactRuntimeProjection(data) })}\n`;
			fs.appendFileSync(paths.instanceLog!, line, { mode: 0o600 });
		} catch {
			// best-effort — tracing non deve mai rompere l'orchestrazione reale
		}
	}

	function tracePayload(type: string, data: Record<string, unknown>, minimum: "standard" | "full" = "standard"): void {
		if (!identity) return;
		try {
			const config = getTraceConfig({ cwd: identity.cwd, project: identity.project });
			if (!traceEnabled(config.mode, minimum)) return;
			const paths = ensureTraceProject({ cwd: identity.cwd, project: identity.project, instance: identity.instance });
			const line = `${JSON.stringify({ ts: nowIso(), seq: ++logSeq, instance: identity.instance, role: identity.role, project: identity.project, project_key: paths.projectKey, trace_mode: config.mode, type, ...redactRuntimeProjection(data) })}\n`;
			fs.appendFileSync(paths.instanceLog!, line, { mode: 0o600 });
		} catch {
			// best-effort
		}
	}

	// Pi exposes the authoritative post-provider context estimate through
	// getContextUsage(). Keep a branch-size fallback as well: immediately after
	// compaction Pi intentionally reports tokens=null until the next response,
	// and older Pi builds may not expose the helper at all. We never persist the
	// branch itself here, only bounded size metadata, so every agent log can be
	// inspected by the zero-token watcher without leaking the conversation.
	function contextUsageSnapshot(ctx: any): Record<string, unknown> {
		const branch = (() => {
			try { return ctx?.sessionManager?.getBranch?.() ?? []; } catch { return []; }
		})();
		const branchChars = contextTextLength(branch);
		const estimatedTokens = Math.max(0, Math.ceil(branchChars / 4));
		let usage: any = null;
		try { usage = ctx?.getContextUsage?.() ?? null; } catch { usage = null; }
		const contextWindowTokens = Number(usage?.contextWindow ?? ctx?.model?.contextWindow ?? 0) || null;
		const piTokens = Number.isFinite(usage?.tokens) ? Number(usage.tokens) : null;
		const effectiveTokens = piTokens ?? estimatedTokens;
		const ratio = contextWindowTokens ? effectiveTokens / contextWindowTokens : null;
		return {
			context_tokens: piTokens,
			effective_context_tokens: effectiveTokens,
			estimated_context_tokens: estimatedTokens,
			context_window_tokens: contextWindowTokens,
			context_ratio: ratio,
			context_percent: Number.isFinite(usage?.percent) ? Number(usage.percent) : (ratio === null ? null : ratio * 100),
			context_tokens_source: piTokens === null ? "branch_estimate" : "pi_getContextUsage",
			context_chars: branchChars,
			context_entries: Array.isArray(branch) ? branch.length : 0,
		};
	}

	function logContextUsage(ctx: any, point: string, extra: Record<string, unknown> = {}): void {
		logEvent("context_usage", { point, ...contextUsageSnapshot(ctx), ...extra });
	}

	// ━━ Agent status snapshot for the report (Revisione 19) ━━━━━━━━━━━━━━━
	// A live-test showed why this is needed: watching herdr panes alone, it's
	// hard to tell whether the team is actually following the planner's phase
	// plan (Revisione 18) or just all busy at once again — the presence
	// widget shows the CURRENT state, but nothing kept a record of what the
	// state was at each point in the task. This renders a one-line snapshot
	// of every known agent's status (including this one, which the `presence`
	// map deliberately excludes — see onPresenceMessage) for embedding
	// directly in the report, so the report alone (not the herdr panes, not
	// logs/*.jsonl) is enough for the user or another AI to verify after the
	// fact whether the plan was actually respected.
	function agentStatusSnapshot(): string {
		if (!identity) return "(stato non disponibile)";
		const self = {
			instance: identity.instance,
			role: identity.role,
			status: computeSelfStatus(),
			current_load: currentLoad(),
			capacity: identity.capacity,
			self: true,
		};
		const others = [...presence.values()].filter((c) => c.status !== "offline").map((c) => ({
			instance: c.instance,
			role: c.role,
			status: c.status,
			current_load: c.current_load,
			capacity: c.capacity,
			self: false,
		}));
		const all = [self, ...others].sort((a, b) => a.instance.localeCompare(b.instance));
		return all.map((a) => `${a.instance}(${a.role})=${a.status}${a.self ? "·io" : ""}[${a.current_load}/${a.capacity}]`).join(", ");
	}

	function rememberAssignment(id: string): boolean {
		// Returns true if this is a NEW assignment_id (should be processed),
		// false if already seen (QoS1 duplicate delivery — drop it).
		if (seenAssignments.has(id)) return false;
		seenAssignments.set(id, Date.now());
		if (seenAssignments.size > SEEN_ASSIGNMENTS_CAP) {
			const oldestKey = seenAssignments.keys().next().value;
			if (oldestKey) seenAssignments.delete(oldestKey);
		}
		return true;
	}
	// Dequeues the oldest pending bug/suggestion for this project (see
	// claimNextQueuedFeedback in yano-feedback.mjs — extracted there so the
	// dequeue-and-classify decision is unit-testable). Before 2026-09-06 this
	// only ever looked at type="bug", so a suggestion sitting in
	// "pending_planner"/"queued" was NEVER surfaced to the planner no matter
	// how long it stayed idle — bugs got a FIFO catch-up, suggestions got
	// silently stuck forever. preferredType lets a live feedback_received
	// notification check the queue matching what just arrived first, while
	// still respecting that queue's own FIFO order (see the smoke test).
	function wakeNextQueuedFeedback(reason: string, preferredType?: "bug" | "suggestion"): void {
		if (!identity || identity.role !== "planner" || computeSelfStatus() !== "idle") return;
		let db: any = null;
		try {
			db = openFeedbackDatabase();
			const result = claimNextQueuedFeedback(db, identity.project, { preferredType });
			if (!result) return;
			const imageBlocks = (result.claimed.screenshots || []).flatMap((shot: any) => {
				const source = shot?.preview_url || shot?.data || "";
				const match = String(source).match(/^data:([^;,]+)?;base64,(.+)$/s);
				return match ? [{ type: "image", data: match[2], mimeType: shot.mime_type || match[1] || "image/png" }] : [];
			});
			const content: any = [{ type: "text", text: buildQueuedFeedbackWakeMessage(result.claimed, result.type) }, ...imageBlocks];
			pi.sendMessage({ customType: "feedback-inbound", content, display: true, details: { feedback_id: result.claimed.id, reason, feedback_type: result.type, screenshot_count: imageBlocks.length } } as any, { deliverAs: "followUp", triggerTurn: true });
			logEvent("feedback_queue_wake", { feedback_id: result.claimed.id, reason, status: result.claimed.status, feedback_type: result.type });
		} catch (error) {
			logEvent("feedback_queue_wake_failed", { reason, error: error instanceof Error ? error.message : String(error) });
		} finally { try { db?.close(); } catch { /* best effort */ } }
	}
	function handleFeedbackReceived(payload: any): void {
		if (!identity || identity.role !== "planner" || payload?.project_id !== identity.project) return;
		logEvent("feedback_received", { feedback_id: payload.feedback_id ?? null, feedback_type: payload.feedback_type ?? null, screenshot_count: Array.isArray(payload.screenshots) ? payload.screenshots.length : 0, planner_status: computeSelfStatus() });
		wakeNextQueuedFeedback("feedback_received", payload?.feedback_type === "suggestion" ? "suggestion" : "bug");
	}

	function scheduleEviction(assignment_id: string): void {
		// Keep a resolved/timed-out entry around briefly so a slow agent_get
		// still sees the final result, then free it — otherwise pendingReplies
		// grows unbounded over a long-running session for sends nobody polls.
		const t = setTimeout(() => { pendingReplies.delete(assignment_id); }, 5 * 60_000);
		try { (t as any).unref?.(); } catch { /* ignore */ }
	}

	function publishPresence(_requestedStatus: PresenceStatus): Promise<void> {
		const revision = ++presenceRevision;
		presencePublishChain = presencePublishChain
			.catch(() => {})
			.then(async () => {
				// If several transitions were queued before MQTT flushed, only the
				// newest one is allowed to publish. This prevents an older busy
				// snapshot from landing after a newer idle snapshot.
				if (revision !== presenceRevision || !identity || !client || !T) return;
				const heartbeat = nowIso();
				const card: PresenceCard = {
					instance: identity.instance,
					role: identity.role,
					project: identity.project,
					project_key: projectKey(identity.cwd, identity.project),
					team: identity.team,
					model: identity.model,
					skills: [],
					tools: [],
					mcp: [],
					status: computeSelfStatus(),
					capacity: identity.capacity,
					current_load: currentLoad(),
					color: identity.color,
					started_at: heartbeat,
					last_heartbeat: heartbeat,
					reload_requested: reloadRequested,
					reload_ready: reloadReady(),
					yano_runtime_version: YANO_RUNTIME_PACKAGE_VERSION,
				};
				// Application-level liveness. A PID and an MQTT connection can remain
				// alive while the event loop is wedged; the watcher consumes this
				// bounded heartbeat file and can distinguish that case without tokens.
				try {
					const heartbeatDir = path.join(traceRoot(), "heartbeats", card.project_key);
					fs.mkdirSync(heartbeatDir, { recursive: true, mode: 0o700 });
					const heartbeatPath = path.join(heartbeatDir, `${identity.instance}.json`);
					const temporary = `${heartbeatPath}.${process.pid}.tmp`;
					fs.writeFileSync(temporary, JSON.stringify({ ...card, observed_at: heartbeat }), { mode: 0o600 });
					fs.renameSync(temporary, heartbeatPath);
				} catch {
					// A diagnostic heartbeat must never break agent work.
				}
				try {
					await client.publishAsync(T.agentStatus(identity.instance), JSON.stringify(card), { qos: 1, retain: true });
				} catch {
					// best-effort — presence is advisory, never fatal to the agent turn
				}
			});
		return presencePublishChain;
	}

	function handleCommand(env: CommandEnvelope) {
		if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
			pushActivity({ channel: "self", from: env.sender_instance, summary: `dropped: hop limit exceeded`, timestamp: nowIso() });
			return;
		}
		if (reloadRequested) {
			logEvent("reload_work_rejected", { assignment_id: env.assignment_id, sender_instance: env.sender_instance, reason: "reload barrier active" });
			return;
		}
		if (!rememberAssignment(env.assignment_id)) return; // duplicate QoS1 delivery

		const inbound: InboundContext = {
			assignment_id: env.assignment_id,
			hops: env.hops,
			reply_to: env.reply_to,
			sender_instance: env.sender_instance,
			response_schema: env.response_schema ?? null,
			prompt_preview: String(env.prompt || "").slice(0, 800),
			fulfilled: false,
		};
		inboundQueue.set(env.assignment_id, inbound);
		currentInbound = inbound;

		try {
			pi.sendMessage(
				{
					customType: "orchestrator-inbound",
					content: `[task from ${env.sender_instance} (${env.sender_role})]\n\n${env.prompt}`,
					display: true,
					details: { assignment_id: env.assignment_id, sender_instance: env.sender_instance, response_schema: env.response_schema ?? null },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			inboundQueue.delete(env.assignment_id);
			currentInbound = null;
			return;
		}

		pi.appendEntry("orchestrator-log", { event: "inbound_command", assignment_id: env.assignment_id, sender: env.sender_instance, hops: env.hops });
		logEvent("wake_in", {
			assignment_id: env.assignment_id,
			sender_instance: env.sender_instance,
			sender_role: env.sender_role,
			target_instance: env.target_instance ?? null,
			target_role: env.target_role ?? null,
			hops: env.hops,
			prompt_preview: env.prompt.slice(0, 200),
		});
		void publishPresence("busy");
	}

	function handleContextCompactRequest(env: ContextCompactRequestEnvelope): void {
		if (!identity || !currentCtx) return;
		if (contextCompactionInFlight) {
			logEvent("context_compaction_skipped", { request_id: env.request_id, reason: "already_in_flight" });
			return;
		}
		if (typeof (currentCtx as any).compact !== "function") {
			logEvent("context_compaction_failed", { request_id: env.request_id, reason: "pi_compact_unavailable" });
			return;
		}
		contextCompactionInFlight = true;
		logContextUsage(currentCtx, "compact_requested", {
			request_id: env.request_id,
			requested_by_instance: env.requested_by_instance,
			reason: env.reason,
		});
		try {
			(currentCtx as any).compact({
				customInstructions: env.custom_instructions || "Preserva obiettivo, vincoli, decisioni, stato dei ticket e prossimi passi; mantieni il contesto operativo verificabile.",
				onComplete: (result: any) => {
					logEvent("context_compaction_completed", {
						request_id: env.request_id,
						reason: env.reason,
						compaction_tokens_before: result?.tokensBefore ?? null,
						estimated_tokens_after: result?.estimatedTokensAfter ?? null,
						first_kept_entry_id: result?.firstKeptEntryId ?? null,
						restart_mode: "pi_native_compaction",
					});
					const after = contextUsageSnapshot(currentCtx);
					const compactedTokens = Number(result?.estimatedTokensAfter);
					logEvent("context_usage", {
						point: "compact_completed",
						...after,
						...(Number.isFinite(compactedTokens) ? {
							context_tokens: compactedTokens,
							effective_context_tokens: compactedTokens,
							context_tokens_source: "pi_compaction_result",
							context_ratio: after.context_window_tokens ? compactedTokens / Number(after.context_window_tokens) : null,
							context_percent: after.context_window_tokens ? (compactedTokens / Number(after.context_window_tokens)) * 100 : null,
						} : {}),
						request_id: env.request_id,
						restart_mode: "pi_native_compaction",
					});
					contextCompactionInFlight = false;
					void publishPresence(computeSelfStatus());
				},
				onError: (error: Error) => {
					logEvent("context_compaction_failed", { request_id: env.request_id, reason: env.reason, error: error?.message || String(error) });
					contextCompactionInFlight = false;
				},
			});
		} catch (error) {
			contextCompactionInFlight = false;
			logEvent("context_compaction_failed", { request_id: env.request_id, reason: env.reason, error: error instanceof Error ? error.message : String(error) });
		}
	}

	function handleReloadPrepare(env: ReloadPrepareEnvelope): void {
		if (!identity) return;
		reloadRequested = true;
		logEvent("reload_prepare_received", {
			requested_by_instance: env.requested_by_instance,
			requested_by_role: env.requested_by_role,
			reload_ready: reloadReady(),
			reason: env.reason,
		});
		void publishPresence(computeSelfStatus());
	}

	function handleReloadCancel(env: ReloadCancelEnvelope): void {
		if (!identity) return;
		reloadRequested = false;
		logEvent("reload_prepare_cancelled", {
			requested_by_instance: env.requested_by_instance,
			requested_by_role: env.requested_by_role,
			reason: env.reason,
		});
		void publishPresence(computeSelfStatus());
	}

	function handleResponse(env: ResponseEnvelope) {
		const entry = pendingReplies.get(env.assignment_id);
		if (!entry) {
			// Fencing: either already resolved (and cleaned up) or a response for
			// an assignment we no longer track (e.g. reassigned after a timeout).
			pushActivity({ channel: "self", from: env.responder_instance, summary: `stale response ignored (assignment_id ${env.assignment_id})`, timestamp: nowIso() });
			return;
		}
		entry.result = { response: env.response, error: env.error ?? null };
		if (entry.timer) clearTimeout(entry.timer);
		entry.resolve(entry.result);
		scheduleEviction(env.assignment_id);
		if (reloadRequested) void publishPresence(computeSelfStatus());

		// Revisione 30: a real incident showed this reply landing while the
		// sender's own turn had long since ended (agent_send was fire-and-forget,
		// nobody called agent_await/agent_get again) — entry.resolve() above only
		// satisfies a Promise nobody is still awaiting, so the reply is silently
		// absorbed and the sender never finds out work is done. Unlike
		// handleCommand (which always wakes the RECIPIENT of a task), nothing
		// previously woke the SENDER when its reply came back. Fix: unless a
		// turn is actively blocked inside agent_await for this exact entry
		// (entry.awaiting — that turn already gets the result as agent_await's
		// own return value, a second wake would just be a redundant duplicate),
		// wake the sender's turn with the response content, exactly like an
		// inbound task does.
		if (!entry.awaiting) {
			try {
				pi.sendMessage(
					{
						customType: "orchestrator-response",
						content:
							`[risposta ricevuta] da ${env.responder_instance} (assignment_id ${env.assignment_id})\n\n` +
							(env.error
								? `Errore: ${env.error}`
								: typeof env.response === "string"
									? env.response
									: JSON.stringify(env.response, null, 2)),
						display: true,
						details: { assignment_id: env.assignment_id, responder_instance: env.responder_instance, response: env.response, error: env.error ?? null },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				// best-effort — a failed wake-up must never crash the message handler;
				// the result is still sitting in pendingReplies for a future
				// agent_get/agent_await to pick up manually.
			}
		}
	}

	// Revisione 42 — see TerminateEnvelope/agent_terminate/WATCHDOG_AUTO_TERMINATE_*
	// above. This runs in the TARGET instance's own process (its own message
	// handler dispatches here — a "terminate" envelope for instance X only
	// ever reaches X, since it's published on X's own per-instance command
	// topic), so it's a genuine self-directed shutdown, not a remote kill -9:
	// the process gets to publish "offline" and close its MQTT connection
	// cleanly (cleanShutdown() below is the exact same path session_shutdown
	// already uses) before exiting. Best-effort throughout, same discipline
	// as the rest of this file — but unlike every other best-effort path
	// here, this one is SUPPOSED to end the process, so the final step is a
	// real process.exit(), deliberately with a non-zero code to distinguish
	// "terminated on request" from a normal exit in any process-level
	// monitoring outside this extension's own visibility (herdr, systemd,
	// whatever the operator's environment uses).
	function handleTerminate(env: TerminateEnvelope): void {
		if (!identity) return;
		logEvent("agent_terminate_received", { requested_by_instance: env.requested_by_instance, requested_by_role: env.requested_by_role, reason: env.reason });
		herdrReportAgent(identity.displayName, "blocked", identity.instance);
		void cleanShutdown().finally(() => {
			// Test seam (Revisione 42): the smoke-test harness (scripts/
			// smoke-test-*.mjs) runs every fake "instance" as a plain closure
			// sharing ONE real Node process (see FakeInstance) — an unconditional
			// process.exit() here would kill the whole test runner, not just
			// "this instance". In production each instance IS its own OS process
			// (a separate `pi` CLI invocation), so this only ever matters under
			// test — cleanShutdown() above (offline presence + MQTT disconnect)
			// still runs for real either way, only the actual exit is skipped.
			if (process.env.PI_ORCH_TEST_NO_EXIT === "1") return;
			process.exit(1);
		});
	}

	// The widget installed by installPoolWidget() only actually redraws when
	// setWidget() is called again with fresh render closures — there is no
	// separate "just repaint" signal, so every place that changes what the
	// widget should show (a peer's presence changes, our own connection
	// state flips, a stale peer gets pruned) must re-install it. Without
	// this, the pane only shows whatever was true at the moment it happened
	// to last redraw for some unrelated reason (e.g. its own boot), which is
	// exactly why only the last-started pane (whose install happened after
	// the others had already published) showed the full peer list, while the
	// earlier panes never updated when new peers joined afterwards.
	function requestPoolRedraw(): void {
		if (currentCtx?.hasUI) {
			try { installPoolWidget(currentCtx); } catch { /* ignore */ }
		}
	}

	function onPresenceMessage(topicStr: string, payload: Buffer) {
		try {
			const card = JSON.parse(payload.toString("utf-8")) as PresenceCard;
			if (!card || typeof card.instance !== "string") return;
			// Defence in depth: the subscription is already scoped to T.project,
			// but a stale/duplicate extension, a retained card from an older
			// session, or a broker wildcard mistake must never be allowed to put a
			// different project's agent in this roster. Validate both the payload
			// identity and the exact topic before storing it.
			if (!identity || !T || card.project !== identity.project || card.project_key !== projectKey(identity.cwd, identity.project) || topicStr !== T.agentStatus(card.instance)) {
				logEvent("presence_ignored_scope_mismatch", {
					topic: topicStr,
					card_instance: card.instance,
					card_project: card.project ?? null,
					card_project_key: card.project_key ?? null,
					expected_project: identity?.project ?? null,
				});
				return;
			}
			if (identity && card.instance === identity.instance) return;
			// Offline is a tombstone, not a peer. Keeping it in the map made the
			// first agent_list after launch show dead agents until staleSweepTimer.
			if (card.status === "offline") presence.delete(card.instance);
			else presence.set(card.instance, card);
			requestPoolRedraw();
		} catch {
			// ignore malformed retained payloads
		}
	}

	function onRoleOrTeamMessage(kind: "role" | "team", name: string, payload: Buffer) {
		try {
			const obj = JSON.parse(payload.toString("utf-8"));
			if (obj && obj.type === "command") {
				// Role-broadcast task: delivered to every live instance of that role.
				// No claim/first-wins arbitration at this stage — see docs/notes/development-notes.md.
				if (identity && obj.target_role === identity.role && obj.sender_instance !== identity.instance) {
					handleCommand(obj as CommandEnvelope);
				}
				pushActivity({ channel: `${kind}:${name}`, from: obj.sender_instance ?? "?", summary: `command → role ${obj.target_role}`, timestamp: nowIso() });
				return;
			}
			// Generic visible event (agent_publish_event) — just logged, never
			// auto-triggers a turn. This is the pub/sub visibility the flat coms
			// peer model didn't have: agents can see what happened without being
			// addressed directly.
			pushActivity({ channel: `${kind}:${name}`, from: obj.from ?? "?", summary: String(obj.summary ?? "event"), timestamp: nowIso() });
		} catch {
			// ignore malformed payloads
		}
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const flags = readCliFlags(pi);
		const cwd = ctx.cwd || process.cwd();

		if (!flags.instance) {
			// The extension is globally auto-loaded by Pi. A bare `pi` is an
			// ordinary human session, not a malformed Yano worker: leave it
			// completely alone until an explicit --instance opts into orchestration.
			return;
		}

		// Revisione 30: a real incident traced back to an instance launched with
		// its cwd already INSIDE a task worktree (".../.worktrees/<slug>/")
		// instead of the project root. Every path this extension computes
		// (worktreePaths, yanoWorkspaceDir → the SQLite orchestrator.db,
		// reportPath, locksPath, ...) is built by joining onto identity.cwd on
		// the assumption that it IS the project root — launched from inside a
		// worktree instead, they all silently resolve one level too deep (a
		// nested, empty, throwaway ".worktrees/<slug>/.worktrees/<slug>/..."
		// tree, with its own brand-new empty orchestrator.db) rather than
		// erroring. That's exactly what happened: the instance couldn't find
		// the ticket/run its own delegator referenced — they were in the REAL
		// orchestrator.db at the project root — and reasoned right past the
		// mismatch instead of stopping. Refuse to start rather than silently
		// computing wrong paths for an entire session.
		if (cwd.split(path.sep).includes(".worktrees")) {
			ctx.ui?.notify?.(
				`orchestrator: rifiuto di avviarmi — la cwd (${cwd}) è già dentro una worktree (".worktrees/..."). ` +
					"Questa istanza va lanciata dalla ROOT del progetto, non da dentro una worktree, altrimenti ogni percorso " +
					"che questa estensione calcola (SQLite orchestratorStorage, report, lock file, la worktree stessa) verrebbe " +
					"risolto in una copia annidata e isolata, invisibile a tutte le altre istanze. Rilanciami con la cwd impostata " +
					"sulla root del progetto (Herdr: tab con cwd `<root-progetto>`).",
				"error",
			);
			return;
		}

		const cfg = loadConfig(cwd, flags.configDir || "agents");
		const resolved = resolveCapabilities(flags.instance, cfg, flags.role);
		const role = flags.role || resolved.role;
		const defaultProject = resolveDefaultProject(cwd);
		const project = flags.project || defaultProject;
		if (flags.project && flags.project !== defaultProject) {
			ctx.ui?.notify?.(
				`orchestrator: questo agente usa lo scope MQTT esplicito "${flags.project}", ` +
					`ma la root corrente risolverebbe "${defaultProject}". Tutte le istanze dello stesso team ` +
					`devono usare lo stesso --project; agent_list non mostrerà agenti avviati sull'altro scope.`,
				"warning",
			);
		}
		const color = flags.color && isValidHex(flags.color) ? flags.color : fallbackColor(flags.instance);
		const displayName = flags.name || flags.instance;

		identity = {
			instance: flags.instance,
			displayName,
			role,
			playbook: resolved.playbook,
			project,
			team: resolved.teams,
			model: resolved.model,
			color,
			cwd,
			capacity: resolved.capacity,
			skills: resolved.skills,
		};
		projectBootstrap = "";
		projectBootstrapDelivered = false;
		try {
			acquireIdentityLease(cwd, project, flags.instance);
		} catch (error) {
			ctx.ui?.notify?.(`orchestrator: avvio rifiutato — ${error instanceof Error ? error.message : String(error)}`, "error");
			identity = null;
			return;
		}
		T = topics(project, process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : (flags.projectScope || projectKey(cwd, project)));

		// Existing projects get a deterministic, lightweight documentation
		// preflight before the planner explores the code deeply. The scan is
		// read-only; only a missing shared project summary is initialized. The
		// planner still owns the human gate and delegates document creation or
		// refresh to docs-sync after confirmation.
		if (role === "planner") {
			try {
				const scan = scanProject({ root: cwd });
				if (scan.initialized) {
					const summary = ensureProjectSummary(scan);
					projectBootstrap = projectBootstrapPrompt({ ...scan, project_memory: { ...scan.project_memory, exists: true } });
					logEvent("project_documentation_preflight", {
						project_root: cwd,
						project_memory: summary.file,
						project_memory_created: summary.created,
						needs_documentation_gate: scan.needs_documentation_gate,
						manifest_count: scan.manifests.length,
						entrypoint_count: scan.entrypoints.length,
						documentation_findings: scan.docs.relevant,
					});
				}
			} catch (error) {
				logEvent("project_documentation_preflight_failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}

		// `yano start` supplies an expected mode. Enforce it at the extension
		// boundary too, so an old project config cannot silently downgrade a new
		// session back to events-only tracing.
		const expectedTraceMode = process.env.YANO_EXPECTED_TRACE_MODE;
		if (expectedTraceMode && ["off", "events", "standard", "full"].includes(expectedTraceMode)) {
			const currentTrace = getTraceConfig({ cwd, project });
			if (!traceEnabled(currentTrace.mode, expectedTraceMode)) setTraceMode({ cwd, project, mode: expectedTraceMode });
		}

		// Names the pane, three ways at once since none could be confirmed
		// working from this sandbox: herdrRenamePane() directly renames the
		// pane label (the mechanism confirmed from herdr's own CLI help on
		// your machine — most likely to actually fix the "new agent" list
		// showing the project folder instead of the instance); herdrReportAgent()
		// is herdr's documented state-reporting protocol; setTerminalTitle() is
		// a harmless fallback for any other terminal/multiplexer. All three
		// default to --instance so panes match the agent identity out of the
		// box; pass --name to show something else instead.
		setTerminalTitle(displayName);
		herdrReportAgent(displayName, "idle", flags.instance);
		herdrRenamePane(displayName);
		herdrRenameTab(displayName);
		paseoDetectAndLog({ logEvent });

		const brokerUrl = flags.brokerUrl || DEFAULT_BROKER_URL;
		logEvent("session_start", {
			project,
			team: resolved.teams,
			broker: brokerUrl,
			trace_expected_mode: expectedTraceMode || null,
			trace_root: getTraceConfig({ cwd, project }).root,
			yano_expected_version: process.env.YANO_EXPECTED_YANO_VERSION || null,
			yano_runtime_version: YANO_RUNTIME_PACKAGE_VERSION,
			extension_version: YANO_EXTENSION_VERSION,
			...(flags.project && flags.project !== defaultProject ? { project_scope_override: true, default_project: defaultProject } : {}),
		});
		logEvent("trace_preflight", {
			actual_mode: getTraceConfig({ cwd, project }).mode,
			expected_mode: expectedTraceMode || null,
			data_dir: getTraceConfig({ cwd, project }).root,
			yano_expected_version: process.env.YANO_EXPECTED_YANO_VERSION || null,
			yano_runtime_version: YANO_RUNTIME_PACKAGE_VERSION,
			extension_version: YANO_EXTENSION_VERSION,
			version_match: process.env.YANO_EXPECTED_YANO_VERSION && YANO_RUNTIME_PACKAGE_VERSION
				? process.env.YANO_EXPECTED_YANO_VERSION === YANO_RUNTIME_PACKAGE_VERSION
				: null,
		});
		logContextUsage(ctx, "session_start");

		// Install the widget immediately, BEFORE the broker connection is even
		// attempted, so there's always something visible at the bottom of the
		// editor — it shows "connecting…" until the first successful connect,
		// then the live peer list. Previously this was only installed after a
		// successful `await mqtt.connectAsync(...)`, so if the broker wasn't up
		// yet at launch, the extension gave up silently and nothing ever
		// appeared — no widget, no retry, until you restarted `pi`.
		//
		// Deliberately NOT also calling ctx.ui.setStatus() here: that writes
		// into pi's own core status bar (the row with cwd/context%/model proxy),
		// and since the widget already shows the same "who am I" info, the two
		// used to duplicate the same line. The widget is now the single source
		// of truth for orchestrator state.
		try {
			installPoolWidget(ctx);
		} catch {
			// hasUI may be false — non-fatal
		}

		// mqtt.connect() (not connectAsync) returns immediately and manages its
		// own reconnect loop (reconnectPeriod below) forever — the extension
		// never "gives up": if the broker isn't reachable yet, or drops later,
		// it just keeps retrying in the background and self-heals once it's up.
		try {
			const tlsFile = (file?: string) => file ? fs.readFileSync(path.resolve(cwd, file)) : undefined;
			client = mqtt.connect(brokerUrl, {
				protocolVersion: 5,
				clientId: `pi-${project}-${identity.instance}-${ulid().slice(-8)}`,
				username: flags.mqttUsername,
				password: flags.mqttPassword,
				ca: tlsFile(flags.mqttTlsCa),
				cert: tlsFile(flags.mqttTlsCert),
				key: tlsFile(flags.mqttTlsKey),
				rejectUnauthorized: !flags.mqttAllowInsecure,
				clean: true,
				reconnectPeriod: 2000,
				connectTimeout: 10_000,
				will: {
					topic: T.agentStatus(identity.instance),
					payload: JSON.stringify({ instance: identity.instance, role, project, project_key: projectKey(cwd, project), status: "offline", last_heartbeat: nowIso() }),
					qos: 1,
					retain: true,
				},
			});
		} catch (err) {
			ctx.ui?.notify?.(`orchestrator: MQTT client init failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		client.on("message", (topicStr, payload) => {
			if (!identity || !T) return;
			if (topicStr === T.agentCommands(identity.instance)) {
				try {
					const env = JSON.parse(payload.toString("utf-8")) as CommandEnvelope | ContextCompactRequestEnvelope | TerminateEnvelope | ReloadPrepareEnvelope | ReloadCancelEnvelope;
					if (env.type === "feedback_received") handleFeedbackReceived(env);
					else if (env.type === "command") handleCommand(env);
					else if (env.type === "context_compact_request") handleContextCompactRequest(env);
					else if (env.type === "reload_prepare") handleReloadPrepare(env);
					else if (env.type === "reload_cancel") handleReloadCancel(env);
					else if (env.type === "terminate") handleTerminate(env);
				} catch { /* ignore malformed */ }
				return;
			}
			if (topicStr === T.agentResponses(identity.instance)) {
				try {
					const env = JSON.parse(payload.toString("utf-8")) as ResponseEnvelope;
					if (env.type === "response") handleResponse(env);
				} catch { /* ignore malformed */ }
				return;
			}
			if (topicStr.endsWith("/status") && topicStr.includes("/agents/")) {
				onPresenceMessage(topicStr, payload);
				return;
			}
			const roleMatch = topicStr.match(/\/roles\/([^/]+)\/tasks$/);
			if (roleMatch) { onRoleOrTeamMessage("role", roleMatch[1], payload); return; }
			const teamMatch = topicStr.match(/\/teams\/([^/]+)\/events$/);
			if (teamMatch) { onRoleOrTeamMessage("team", teamMatch[1], payload); return; }
		});

		client.on("error", (err) => {
			pi.appendEntry("orchestrator-log", { event: "mqtt_error", message: err instanceof Error ? err.message : String(err) });
		});

		client.on("reconnect", () => {
			mqttConnected = false;
			requestPoolRedraw(); // widget's own "● mqtt" indicator picks up reconnecting/connecting via everConnected
		});

		client.on("offline", () => {
			mqttConnected = false;
			requestPoolRedraw();
		});

		// Fires on the FIRST successful connect and again after every
		// reconnect — subscriptions and presence are re-established each time
		// (clean:true sessions don't survive a disconnect on the broker side).
		client.on("connect", () => {
			void (async () => {
				if (!identity || !T || !client) return;
				try {
					await client.subscribeAsync(T.agentCommands(identity.instance), { qos: 1 });
					await client.subscribeAsync(T.agentResponses(identity.instance), { qos: 1 });
					// Presence is published retained at QoS 1. Subscribe at the same
					// level so a freshly restarted planner deterministically receives
					// every retained peer card before it renders/queries the fleet.
					await client.subscribeAsync(T.agentStatusWildcard(), { qos: 1 });
					await client.subscribeAsync(T.roleTasks(role), { qos: 1 });
					for (const team of identity.team) {
						await client.subscribeAsync(T.teamEvents(team), { qos: 0 });
					}
					mqttConnected = true;
					everConnected = true;
					presenceHydration = new Promise((resolve) => {
						const timer = setTimeout(resolve, 200);
						try { (timer as any).unref?.(); } catch { /* bounded barrier */ }
					});
					await publishPresence(computeSelfStatus());
					pi.appendEntry("orchestrator-log", { event: "connected", instance: identity.instance, role, project, broker: brokerUrl });
					logEvent("connected", { broker: brokerUrl });
					setTerminalTitle(identity.displayName); // reassert — some terminals/pi's own TUI redraws can clear a title set before the app fully took over the screen
					try {
						ctx.ui.notify(`orchestrator connesso · ${identity.instance} (${role}) · broker ${brokerUrl}`, "info");
					} catch {
						// hasUI may be false — non-fatal
					}
					requestPoolRedraw();
				} catch (err) {
					ctx.ui?.notify?.(`orchestrator: subscribe failed — ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			})();
		});

		heartbeatTimer = setInterval(() => {
			if (mqttConnected) void publishPresence(computeSelfStatus());
		}, HEARTBEAT_MS);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }

		staleSweepTimer = setInterval(() => {
			const now = Date.now();
			let changed = false;
			for (const [id, card] of presence) {
				if (now - Date.parse(card.last_heartbeat) > STALE_AFTER_MS) {
					presence.delete(id); // client-side staleness backstop; LWT should normally beat us to it
					changed = true;
				}
			}
			if (changed) requestPoolRedraw();
		}, STALE_AFTER_MS);
		try { (staleSweepTimer as any).unref?.(); } catch { /* ignore */ }

		// Planner-only periodic stall sweep (Revisione 29) — see WATCHDOG_* above
		// for why this exists. Runs unconditionally on this interval regardless
		// of MQTT connection state (watchdogSweep only touches local SQLite plus
		// best-effort MQTT/WhatsApp/pi.sendMessage, each independently guarded);
		// harmless no-op for every non-planner role and until a run actually
		// exists.
		if (identity.role === "planner") {
			watchdogTimer = setInterval(() => { void watchdogSweep(Date.now()); }, WATCHDOG_INTERVAL_MS);
			try { (watchdogTimer as any).unref?.(); } catch { /* ignore */ }
		}
	});

	// ━━ before_agent_start: inject role-specific behavior ━━━━━━━━━━━━━━━━
	// Without this, the LLM has the agent_send/agent_await tools but no
	// instruction to actually use them to delegate/hand off — it would just
	// try to do everything itself. This is what turns "planner, coder and
	// reviewer are all just Pi agents with the same tools" into the
	// planner → coder → reviewer → planner pipeline the operator expects.
	pi.on("before_agent_start", async (_event: any, ctx) => {
		if (!identity) return;
		const flags = readCliFlags(pi);
		const cfg = loadConfig(identity.cwd, flags.configDir || "agents");
		const roleCfg = cfg.roles[identity.role];
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		const lastUser = [...branch].reverse().find((entry: any) => entry?.role === "user");
		const branchText = Array.isArray(lastUser?.content)
			? lastUser.content.map((part: any) => part?.text || part?.content || "").join(" ")
			: String(lastUser?.content || "");
		const codeMemQuery = (currentInbound?.prompt_preview || branchText || `${identity.role} ${identity.project} architecture`).slice(0, 800);
		const codeMem = collectCodeMemContext({ root: identity.cwd, query: codeMemQuery, maxChars: 6_000 });
		logEvent("code_mem_context_queried", { ok: codeMem.ok, reason: codeMem.reason, query_hash: crypto.createHash("sha256").update(codeMem.query || codeMemQuery).digest("hex").slice(0, 12), query_chars: (codeMem.query || codeMemQuery).length, chars: codeMem.context.length });
		// Revisione 47: per default i prompt vengono SEMPRE letti dalla cartella
		// prompts/ del pacchetto installato (resolveGlobalPromptsDir(), risolta
		// dalla posizione reale di QUESTO file, mai da un percorso ipotizzato) —
		// mai da una copia locale del progetto, che prima (Revisione 37-46)
		// restava silenziosamente indietro ad ogni `yano update`. Solo
		// --custom-prompts fa eccezione: guarda PRIMA nella cartella locale del
		// progetto (--prompts-dir, default .pi/extensions/yano-orchestrator/prompts,
		// creata da `yano copy-prompts`), poi ricade sul pacchetto installato per
		// qualunque file quella cartella non abbia — file per file, non tutto o
		// niente: personalizzare un solo ruolo non fa "congelare" gli altri.
		const globalPromptsDir = resolveGlobalPromptsDir();
		const localPromptsDirRaw = flags.promptsDir || path.join(".pi", "extensions", "yano-orchestrator", "prompts");
		const localPromptsDir = path.isAbsolute(localPromptsDirRaw) ? localPromptsDirRaw : path.join(identity.cwd, localPromptsDirRaw);
		const primaryDir = flags.customPrompts ? localPromptsDir : globalPromptsDir;
		const fallbackDir = flags.customPrompts ? globalPromptsDir : null;
		const template = loadRolePrompt(primaryDir, fallbackDir, identity.role, roleCfg);
		const rules = identity.role === "planner" ? loadYanoRules({ root: identity.cwd, project: identity.project }) : null;
		const rulesPrompt = rules && (rules.global.length || rules.project.length)
			? `\n\n## Regole Yano obbligatorie\nSegui sempre queste regole globali e specifiche del progetto. Se una regola è in conflitto con una richiesta, fermati e informa l'utente.\n${[...rules.global.map((rule: any) => `- [globale] ${rule.text}`), ...rules.project.map((rule: any) => `- [progetto] ${rule.text}`)].join("\n")}`
			: "";
		logEvent("role_prompt_resolved", {
			custom_prompts: !!flags.customPrompts,
			primary_dir: primaryDir,
			fallback_dir: fallbackDir,
			rules_global: rules?.global.length || 0,
			rules_project: rules?.project.length || 0,
		});
		const systemPrompt = template
			.replaceAll("{{INSTANCE}}", identity.instance)
			.replaceAll("{{ROLE}}", identity.role)
			.replaceAll("{{ROLE_LABEL}}", roleCfg?.label || identity.role)
			.replaceAll("{{BRIEF}}", roleCfg?.brief || "")
			.replaceAll("{{CAPABILITIES}}", roleCapabilitiesPrompt(roleCfg))
			.replaceAll("{{PROJECT}}", identity.project)
			.replaceAll("{{TEAM}}", identity.team.join(", "))
			.replaceAll("{{SLUG_REMINDER}}", SLUG_REMINDER)
			.replaceAll("{{WORKER_TOOLS_INTRO}}", WORKER_TOOLS_INTRO)
			.replaceAll("{{DIAGRAM_TIP}}", DIAGRAM_TIP)
			.replaceAll("{{TURN_CLOSE_NOTE}}", TURN_CLOSE_NOTE)
			.replaceAll("{{TICKET_CLAIM_STEP0}}", TICKET_CLAIM_STEP0) + rulesPrompt + CONTEXT_EFFICIENCY_PROTOCOL + REPORT_ARTIFACT_PROTOCOL + apiRegistryPrompt(identity.cwd) + (codeMem.context ? `\n\n## Orientamento code-mem (consultazione bounded)\nUsa questi risultati per scegliere quali file approfondire. Sono orientamento, non prova definitiva: verifica ogni informazione critica nel codice, nei test e nel runtime. Non riversare l'intero repository nel contesto.\n${codeMem.context}` : "") + loadAgentMemory({ root: identity.cwd, role: identity.role, instance: identity.instance }) +
			(identity.role === "planner" && !projectBootstrapDelivered && projectBootstrap ? projectBootstrap : "");
		if (identity.role === "planner" && projectBootstrap) {
			projectBootstrapDelivered = true;
			logEvent("project_documentation_gate_presented", { project_memory: path.join(identity.cwd, ".pi", "extensions", "yano-orchestrator", "memory", "project.md") });
		}
		herdrReportAgent(identity.displayName, "working", identity.instance);
		// had_pending_inbound:false qui è il segnale diagnostico chiave per "un
		// agente è partito da solo": significa che questo turno sta iniziando
		// SENZA nessun comando in coda mai ricevuto via MQTT — vedi
		// scripts/review-log.mjs, che lo segnala esplicitamente.
		logEvent("turn_start", { had_pending_inbound: [...inboundQueue.values()].some((i) => !i.fulfilled) });
		return { systemPrompt };
	});

	// Pi exposes the raw image attachment on `input`, before the message is
	// normalized for the current model. Switch here (not only in
	// before_agent_start) so a pinned text-only model cannot cause Pi to replace
	// the attachment with "image omitted" before the model selection changes.
	pi.on("input", async (event: any) => {
		if (!identity) return;
		currentInputScreenshots = inputScreenshotReferences(event);
		await switchImageTurnToAuto({ event, ctx: currentCtx, setModel: (model) => pi.setModel(model), log: logEvent });
	});

	// If a pinned provider fails because of quota/credit or provider transport,
	// switch once to llmProxy auto and resume the failed turn. Tool/application
	// errors are intentionally not handled here.
	pi.on("message_end", async (event: any, ctx: any) => {
		const message = event?.message;
		if (message?.role !== "assistant" || !message?.errorMessage) return;
		await switchPinnedModelToAuto({
			message,
			ctx,
			autoModel: llmProxyAutoModel(ctx),
			setModel: (model) => pi.setModel(model),
			resume: async () => {
				const sendUserMessage = (pi as any).sendUserMessage;
				if (typeof sendUserMessage !== "function") throw new Error("Pi non espone sendUserMessage per la ripresa del turno");
				await sendUserMessage.call(pi, "Il provider/modello selezionato non è disponibile. Ho attivato il routing automatico llmProxy: riprendi il task dal checkpoint osservabile senza ricominciare da capo.", { deliverAs: "followUp", triggerTurn: true });
			},
			log: logEvent,
		});
	});

	// Record context at every completed turn. This is the stable observation
	// point used by the external watcher: the agent is at a safe point and Pi's
	// usage estimate reflects the latest provider response.
	pi.on("turn_end", async (_event: any, ctx: any) => {
		logContextUsage(ctx, "turn_end", { turn_index: _event?.turnIndex ?? null });
		// Snapshot-then-reset regardless of outcome below: a failure while
		// writing memory must not leak this turn's failures into the NEXT
		// turn's update (which would misattribute them to the wrong round).
		const toolFailures = currentTurnToolFailures;
		currentTurnToolFailures = [];
		try {
			const branch = ctx?.sessionManager?.getBranch?.() ?? [];
			const memory = updateAgentMemory({ root: identity!.cwd, project: identity!.project, role: identity!.role, instance: identity!.instance, turnIndex: _event?.turnIndex ?? null, branch, toolFailures });
			logEvent("agent_memory_updated", { turn_index: _event?.turnIndex ?? null, project_memory_chars: memory.project_chars, role_memory_chars: memory.role_chars, preferences_updated: memory.preferences_updated, memory_files: memory.files, tool_failures: toolFailures.length });
		} catch (error) {
			logEvent("agent_memory_update_failed", { turn_index: _event?.turnIndex ?? null, error: error instanceof Error ? error.message : String(error) });
		}
	});

	pi.on("session_before_compact", async (event: any, ctx: any) => {
		logContextUsage(ctx, "before_compact", {
			reason: event?.reason ?? null,
			will_retry: event?.willRetry ?? null,
			compaction_tokens_before: event?.preparation?.tokensBefore ?? null,
		});
	});

	pi.on("session_compact", async (event: any, ctx: any) => {
		const entry = event?.compactionEntry;
		logEvent("context_compacted", {
			reason: event?.reason ?? null,
			from_extension: event?.fromExtension ?? false,
			will_retry: event?.willRetry ?? null,
			compaction_tokens_before: entry?.tokensBefore ?? null,
			estimated_tokens_after: entry?.estimatedTokensAfter ?? null,
			first_kept_entry_id: entry?.firstKeptEntryId ?? null,
		});
		logContextUsage(ctx, "after_compact", { compaction_reason: event?.reason ?? null });
		contextCompactionInFlight = false;
		void publishPresence(computeSelfStatus());
	});

	pi.on("session_compact_failed", async (event: any, ctx: any) => {
		logEvent("context_compaction_failed", {
			reason: event?.reason ?? null,
			error: event?.errorMessage ?? null,
			aborted: event?.aborted ?? false,
			will_retry: event?.willRetry ?? null,
		});
		logContextUsage(ctx, "compact_failed", { compaction_reason: event?.reason ?? null });
		contextCompactionInFlight = false;
	});

	// Pi exposes these lifecycle hooks in the live harness. They are kept
	// best-effort so older Pi builds can still load the extension; when present
	// they provide the tool inventory needed by `yano trace --mode full`.
	pi.on("tool_execution_start", async (event: any) => {
		beginOperation(event);
		// A tool call is observable progress for every running ticket owned by
		// this instance. Refresh the SQLite progress clock so a long but active
		// implementation/review cycle is not mistaken for a stalled ticket.
		try {
			if (identity && yanoStorage && activeTicketIds.size > 0) {
				for (const ticketId of activeTicketIds) yanoStorage.touchTicketProgress(ticketId, identity.instance, "tool_execution_start");
			}
		} catch {
			// Progress telemetry is advisory and must never break the tool call.
		}
		logEvent("tool_execution_start", {
			tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null,
			tool: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
		});
		tracePayload("tool_execution_start_payload", { tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null, args: event?.args ?? null }, "standard");
	});
	pi.on("tool_execution_end", async (event: any) => {
		endOperation(event);
		const ok = event?.isError === true ? false : event?.error ? false : true;
		logEvent("tool_execution_end", {
			tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null,
			tool: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
			ok,
		});
		tracePayload("tool_execution_end_payload", { tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null, error: event?.error ?? null, result: event?.result ?? event?.output ?? null }, "standard");
		if (!ok) {
			const tool = String(event?.toolName ?? event?.tool_name ?? event?.name ?? "tool");
			const errorText = String(event?.error?.message ?? event?.error ?? event?.result ?? event?.output ?? "errore non specificato");
			currentTurnToolFailures.push({ tool, error: errorText });
			if (currentTurnToolFailures.length > 20) currentTurnToolFailures.shift();
		}
	});

	// ━━ Widget ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Real crash, not just a cosmetic bug: my earlier hand-rolled truncation
	// (Revisione 8) measured "width" by JS string length. That's wrong for
	// ⚡/● — both render as double-width glyphs in most terminals but are a
	// single UTF-16 code unit in JS, so every line undercounted its own width
	// by one column per icon. Under most terminal widths that slack just sat
	// there unnoticed; at the exact width pi's TUI hit here, the miscount
	// pushed the rendered line one column past the pane's actual width, and
	// pi's own crash guard treats *any* overflowing custom-widget line as a
	// fatal error (not a truncation) — "Rendered line 16 exceeds terminal
	// width (127 > 126)", which killed the whole `pi` process, not just the
	// widget. Fixed by dropping the hand-rolled measuring entirely and using
	// pi-tui's own visibleWidth()/truncateToWidth() — exactly what pi's own
	// crash message names as the fix for "a custom TUI component not
	// truncating its output".
	//
	// SAFETY_MARGIN: while building a standalone reproduction of this fix (no
	// real pi-tui available in this sandbox, so I verified against
	// string-width/cli-truncate — the same ANSI+wide-char-aware family of
	// tooling) I found that even THOSE dedicated libraries can misjudge a
	// leading ⚡ by exactly one column during truncation (string-width alone
	// correctly measures "⚡" as width 2, but cli-truncate's truncation still
	// produced a line 1 column over the requested width when ⚡ led the
	// string) — i.e. this exact class of off-by-one is apparently easy to hit
	// even in widely-used, dedicated width-handling code, not just in my own
	// first attempt. Since I can't fully verify pi-tui's own functions don't
	// have some equivalent quirk from in here, and a single overflowing
	// column is a hard CRASH (not a cosmetic glitch), every line is
	// deliberately budgeted to width-1 rather than the exact width — one
	// wasted column is a non-issue; crashing pi again is not.
	const SAFETY_MARGIN = 1;

	function renderPool(width: number, theme: Theme): string[] {
		const w = Math.max(0, width - SAFETY_MARGIN);
		if (!identity) return [truncateToWidth(theme.fg("dim", "orchestrator: not connected"), w)];

		// Header: "⚡ name (role) · model" on the left, "● mqtt" (green/red,
		// connecting/reconnecting spelled out only while not connected) right
		// aligned. No "@ project" — the ⚡ vs ● icon already distinguishes "this
		// is me" from a peer, so the project label was redundant noise.
		const modelSuffix = identity.model ? ` · ${identity.model}` : "";
		const left = theme.fg("accent", `⚡ ${identity.displayName} (${identity.role})`) + theme.fg("dim", modelSuffix);

		const mqttWord = mqttConnected ? "mqtt" : everConnected ? "mqtt · reconnecting…" : "mqtt · connecting…";
		const mqttColor = mqttConnected ? "success" : "error";
		const right = theme.fg(mqttColor, "●") + " " + theme.fg(mqttColor, mqttWord);

		const pad = Math.max(0, w - visibleWidth(left) - visibleWidth(right));
		const header = truncateToWidth(`${left}${" ".repeat(pad)}${right}`, w);

		const presenceRows = mqttConnected
			? [...presence.values()].filter((c) => c.status !== "offline").map((c) => {
				const dotColor = c.status === "idle" ? "success" : c.status === "busy" ? "warning" : "error";
				const modelPart = c.model ? theme.fg("dim", ` · ${c.model}`) : "";
				const line = theme.fg(dotColor, "●") + " " + theme.fg("accent", `${c.instance} `) + theme.fg("dim", `(${c.role})`) + modelPart + " " + theme.fg("muted", c.status);
				return truncateToWidth(line, w);
			})
			: [];
		if (mqttConnected && presenceRows.length === 0) {
			presenceRows.push(truncateToWidth(theme.fg("dim", "  (nessun altro agente online per ora)"), w));
		}

		// The widget itself spans the bottom area exposed by Pi. Reserve a
		// right-hand column inside it for transient operations while retaining
		// the peer roster on the left. Every rendered line is truncated to the
		// safety-budgeted width to keep Pi's TUI crash guard satisfied.
		const operations = [...activeOperations.values()].slice(-8);
		if (operations.length === 0) return [header, ...presenceRows];
		const rightWidth = Math.min(52, Math.max(30, Math.floor(w * 0.42)));
		const leftWidth = Math.max(0, w - rightWidth - 3);
		const rightRows = operations.map((operation) => {
			const playbook = identity.playbook ? ` · ${identity.playbook}` : "";
			const text = `${operation.kind} ${operation.label}${operation.kind !== "PLAYBOOK" ? playbook : ""}`;
			return theme.fg(operation.kind === "MCP" ? "accent" : operation.kind === "AGENT" ? "warning" : "muted", text);
		});
		const rows = [];
		const count = Math.max(presenceRows.length, rightRows.length);
		for (let index = 0; index < count; index++) {
			const left = truncateToWidth(presenceRows[index] || "", leftWidth);
			const right = rightRows[index] ? truncateToWidth(rightRows[index], rightWidth) : "";
			const gap = " ".repeat(Math.max(1, w - visibleWidth(left) - visibleWidth(right)));
			rows.push(truncateToWidth(`${left}${gap}${right}`, w));
		}
		return [header, ...rows];
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		try {
			ctx.ui.setWidget(
				"orchestrator-pool",
				(_tui, theme) => ({
					render: (width: number) => renderPool(width, theme),
					invalidate: () => {},
				}),
				{ placement: "belowEditor" },
			);
		} catch {
			// hasUI may be false
		}
	}

	// ━━ YanoOrchestrator storage handle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Opened lazily (first tool call that needs it, or an explicit
	// orchestrator_init) rather than at session_start, so every role that
	// never touches the ticket layer never pays for it. One open handle per
	// process, closed on shutdown alongside the MQTT client.
	function ensureYanoStorage(): OrchestratorStorage {
		if (!identity) throw new Error("orchestrator not initialised");
		if (yanoStorage) return yanoStorage;
		yanoEnsureWorkspace(identity.cwd, identity.project);
		const dbPath = path.join(yanoSubdirs(yanoWorkspaceDir(identity.cwd, identity.project)).orchestratorStorage, "orchestrator.db");
		const storage = new SQLiteOrchestratorStorage(dbPath);
		storage.init();
		yanoStorage = storage;
		return storage;
	}
	// Best-effort MQTT signal on top of the SQLite write that already
	// happened — SQLite is the source of truth (already durable by the time
	// this is called), MQTT is just "something happened" visibility, so a
	// lost/failed publish here is never allowed to fail the tool call.
	async function yanoPublishEvent(runId: string, type: string, payload: unknown): Promise<void> {
		try {
			if (client && T) await client.publishAsync(T.runEvents(runId), JSON.stringify({ type, run_id: runId, payload, timestamp: nowIso() }), { qos: 0 });
		} catch {
			// best-effort
		}
	}
	async function yanoPublishAgentEvent(type: string, payload: unknown): Promise<void> {
		try {
			if (client && T && identity) await client.publishAsync(T.agentEvents(identity.instance), JSON.stringify({ type, instance: identity.instance, project: identity.project, payload, timestamp: nowIso() }), { qos: 0 });
		} catch {
			// best-effort
		}
	}

	// ━━ Watchdog sweep (Fase 2 / M3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	//
	// watchdogSweep() itself now lives in scripts/watcher/watchdog-sweep.ts —
	// see createWatchdogSweep(...) below (placed after sendNotifications is
	// defined, since it's one of the injected dependencies and — unlike the
	// hoisted `function` declarations also injected here — a `const`, so it
	// must already be initialised at this point in the file).

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// A bug reported in the planner chat must be persisted before diagnosis. This
	// tool gives the planner the same durable intake used by REST, including the
	// screenshot references supplied with the user's message.
	pi.registerTool({
		name: "feedback_create",
		label: "Persist Bug or Suggestion",
		description: "Persist a user-reported bug or suggestion before analysing it. Planner-only. For a bug received with an image, include its local path or HTTPS URL in screenshots; the record is created before any fix is attempted.",
		parameters: Type.Object({
			type: Type.Union([Type.Literal("bug"), Type.Literal("suggestion")]),
			message: Type.String({ description: "Faithful user report, including route and observed behaviour." }),
			resolution: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("user_confirmation")])),
			screenshots: Type.Optional(Type.Array(Type.Any({ description: "Screenshot path, HTTPS URL, or attachment descriptor." }))),
			username: Type.Optional(Type.String({ description: "Credenziale utente per i test E2E; obbligatoria per i bug." })),
			password: Type.Optional(Type.String({ description: "Password per i test E2E; obbligatoria per i bug e salvata cifrata." })),
		}),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("feedback_create: tool riservato al planner.");
			const db = openFeedbackDatabase();
			try {
				const result = await createFeedbackRecord(db, {
					type: params.type,
					project_id: identity.project,
					message: params.message,
					resolution: params.resolution,
					screenshots: params.screenshots?.length ? params.screenshots : currentInputScreenshots,
					test_username: params.username,
					test_password: params.password,
					notify: false,
				});
				claimFeedback(db, result.id);
				const claimed = listFeedback(db, { project_id: identity.project, type: params.type, statuses: ["processing"] }).find((item: any) => item.id === result.id) || result;
				currentInputScreenshots = [];
				logEvent("feedback_persisted_from_planner_chat", { feedback_id: claimed.id, feedback_type: claimed.type, screenshot_count: claimed.screenshots?.length ?? 0 });
				return { content: [{ type: "text" as const, text: JSON.stringify({ feedback_id: claimed.id, status: claimed.status, screenshots: claimed.screenshots }, null, 2) }], details: { feedback_id: claimed.id, status: claimed.status, screenshot_count: claimed.screenshots?.length ?? 0 } };
			} finally { db.close(); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("feedback_create ")) + theme.fg("accent", `${(args as any).type ?? "bug"} · ${String((args as any).message ?? "").slice(0, 60)}`), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; return new Text(theme.fg("success", `→ ${d?.feedback_id ?? "feedback"} persistito (${d?.screenshot_count ?? 0} screenshot)`), 0, 0); },
	});

	// The auto-improver is an observer. Prompt instructions alone are not a
	// sufficient safety boundary because a resumed/stale Pi transcript can still
	// request bash/edit/write. Give that role a narrow runtime tool surface and
	// keep the only write operation below inside the global Yano data directory.
	pi.registerTool({
		name: "api_request",
		label: "Registered REST API Request",
		description: "Call one user-registered REST API. Only registered hosts, declared methods and configured credentials are allowed; never an arbitrary URL fetch.",
		parameters: Type.Object({
			api: Type.String({ description: "Registered API name from the REST API registry." }),
			method: Type.String({ description: "Declared HTTP method: GET, POST, PUT, PATCH or DELETE." }),
			path: Type.String({ description: "Path relative to the registered base URL, for example /api/status." }),
			body: Type.Optional(Type.Any({ description: "JSON request body when required by the API." })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("api_request: identity non disponibile");
			const api = getProjectApi(identity.cwd, params.api);
			if (!api || api.enabled === false) throw new Error(`api_request: API registrata non disponibile: ${params.api}`);
			const method = String(params.method || "").toUpperCase();
			if (!api.methods.includes(method)) throw new Error(`api_request: metodo ${method} non dichiarato per ${api.name}`);
			if (!String(params.path || "").startsWith("/") || String(params.path).includes("\\") || String(params.path).includes("..")) throw new Error("api_request: path deve essere relativo e sicuro (inizia con /, senza ..)");
			const requestedPath = new URL(params.path, "https://placeholder.invalid").pathname;
			const endpoint = (api.endpoints || []).find((candidate: any) => candidate.method === method && candidate.path === requestedPath);
			if (!endpoint) throw new Error(`api_request: endpoint non rilevato nella sorgente registrata: ${method} ${requestedPath}`);
			const url = new URL(params.path, `${api.base_url}/`);
			if (url.origin !== new URL(api.base_url).origin) throw new Error("api_request: host fuori dal registro");
			const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
			const secret = resolveApiSecret(api);
			if (api.auth_env && !secret) throw new Error(`api_request: credenziale mancante; configura ${api.auth_env} con yano config set ${api.auth_env} --stdin`);
			if (secret) headers[api.auth_header || "x-api-key"] = secret;
			if (params.body !== undefined) headers["content-type"] = "application/json";
			const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
			try {
				const response = await fetch(url, { method, headers, body: params.body === undefined ? undefined : JSON.stringify(params.body), signal: controller.signal });
				const text = (await response.text()).slice(0, 50_000); let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* plain response */ }
				return { content: [{ type: "text" as const, text: JSON.stringify({ api: api.name, method, path: params.path, status: response.status, ok: response.ok, response: parsed }, null, 2) }], details: { api: api.name, method, path: params.path, status: response.status, ok: response.ok, response_chars: text.length } };
			} finally { clearTimeout(timer); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("api_request ")) + theme.fg("accent", `${(args as any).api ?? "?"} ${(args as any).method ?? "GET"} ${(args as any).path ?? "/"}`), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; return new Text(theme.fg(d?.ok ? "success" : "error", `${d?.ok ? "✓" : "✗"} ${d?.status ?? "?"} ${d?.api ?? "API"}`), 0, 0); },
	});
	pi.registerTool({
		name: "auto_improve_web_search",
		label: "Auto-Improve Web Search",
		description: "Search public GitHub and npm indexes for comparable software. Read-only, bounded and available only to auto-improver.",
		parameters: Type.Object({ query: Type.String({ description: "Capability-focused comparison query, not a secret." }) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "auto-improver") throw new Error("auto_improve_web_search: tool riservato al ruolo auto-improver.");
			try {
				const result = await searchPublicAlternatives({ query: params.query });
				return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { query: params.query, result_count: result.results.length, read_only: true } };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `auto_improve_web_search: ${error instanceof Error ? error.message : String(error)}` }], details: { query: params.query, read_only: true, error: true } };
			}
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("auto_improve_web_search ")) + theme.fg("accent", (args as any).query ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; return new Text(theme.fg(d?.error ? "error" : "success", d?.error ? "✗ web search failed" : `✓ ${d?.result_count ?? 0} candidates`), 0, 0); },
	});

	pi.registerTool({
		name: "auto_improve_web_fetch",
		label: "Auto-Improve Web Fetch",
		description: "Fetch one explicit public HTTPS source for the comparison report. Read-only, bounded and available only to auto-improver.",
		parameters: Type.Object({ url: Type.String({ description: "Official HTTPS repository, documentation or package URL to verify." }) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "auto-improver") throw new Error("auto_improve_web_fetch: tool riservato al ruolo auto-improver.");
			try {
				const result = await fetchPublicSource({ url: params.url });
				return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { url: params.url, status: result.status, read_only: true } };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `auto_improve_web_fetch: ${error instanceof Error ? error.message : String(error)}` }], details: { url: params.url, read_only: true, error: true } };
			}
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("auto_improve_web_fetch ")) + theme.fg("accent", (args as any).url ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { const d = result.details as any; return new Text(theme.fg(d?.error ? "error" : "success", d?.error ? "✗ source fetch failed" : `✓ HTTP ${d?.status ?? "?"}`), 0, 0); },
	});

	pi.registerTool({
		name: "auto_improve_complete",
		label: "Auto-Improve Complete",
		description: "Complete an auto-improve audit by writing its Markdown report to the current project's docs/reports directory. Available only to the auto-improver role.",
		parameters: Type.Object({
			audit_id: Type.String(),
			report_file: Type.String(),
			report_markdown: Type.String(),
			summary: Type.String(),
		}),
		async execute(_callId, params) {
			if (!identity || identity.role !== "auto-improver") throw new Error("auto_improve_complete: tool riservato al ruolo auto-improver.");
			if (!/^AUDIT-[A-Z0-9-]+$/i.test(params.audit_id)) throw new Error("auto_improve_complete: audit_id non valido.");
			const globalRoot = path.resolve(path.join(traceRoot(), "auto-improver"));
			// Pi commonly returns the report path relative to the project's data
			// root ("reports/AUDIT-....md"). Resolve that form explicitly; an
			// absolute path is still accepted only after the same containment check.
			const projectRoot = path.resolve(path.join(globalRoot, "projects", projectKey(identity.cwd, identity.project)));
			const projectReportsRoot = path.resolve(path.join(identity.cwd, "docs", "reports"));
			const rawReportFile = String(params.report_file || "");
			const reportFile = path.resolve(path.isAbsolute(rawReportFile) ? rawReportFile : path.join(projectRoot, rawReportFile));
			const inGlobalRoot = reportFile === globalRoot || reportFile.startsWith(`${globalRoot}${path.sep}`);
			const inProjectReports = reportFile.startsWith(`${projectReportsRoot}${path.sep}`);
			if (!inGlobalRoot && !inProjectReports) {
				throw new Error("auto_improve_complete: report_file deve restare nel data-root auto-improver o in docs/reports del progetto.");
			}
			if ((!inGlobalRoot && !path.basename(reportFile).startsWith("auto-improvement-")) || (inGlobalRoot && !reportFile.endsWith(`${path.sep}reports${path.sep}${params.audit_id}.md`))) {
				throw new Error("auto_improve_complete: report_file non corrisponde all'audit richiesto.");
			}
			fs.mkdirSync(path.dirname(reportFile), { recursive: true });
			fs.writeFileSync(reportFile, params.report_markdown.endsWith("\n") ? params.report_markdown : `${params.report_markdown}\n`, { mode: 0o600 });
			const output = execFileSync("yano", ["auto-improve", "complete", "--project-root", identity.cwd, "--audit-id", params.audit_id, "--report-file", reportFile, "--summary", params.summary, "--json"], { cwd: identity.cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
			return { content: [{ type: "text" as const, text: output.trim() || `auto-improve ${params.audit_id}: completed` }], details: { audit_id: params.audit_id, report_file: reportFile, read_only_project: true } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("auto_improve_complete ")) + theme.fg("accent", (args as any).audit_id ?? "?"), 0, 0); },
		renderResult(_result, _options, theme) { return new Text(theme.fg("success", "✓ audit completed (project docs/reports)"), 0, 0); },
	});

	pi.registerTool({
		name: "agent_control",
		label: "Agent Control",
		description: "Deterministic control-plane surface for status and allow-listed process operations. It never accepts free-form shell commands.",
		parameters: Type.Object({
			verb: Type.String(),
			target: Type.Optional(Type.String()),
			args: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const policy = loadControlPolicy(identity.cwd);
			if (!policy.verbs.includes(params.verb)) throw new Error(`agent_control: verb "${params.verb}" is not in the allow-list.`);
			if (["launch", "relaunch", "terminate"].includes(params.verb) && identity.role !== "planner") {
				throw new Error(`agent_control: verb "${params.verb}" is planner-only.`);
			}
			if (params.verb === "status") {
				return { content: [{ type: "text" as const, text: `agent_control status: ${presence.size} peer(s), mqtt=${mqttConnected ? "connected" : "disconnected"}.` }], details: { verb: params.verb, peers: presence.size, mqtt_connected: mqttConnected } };
			}
			if (!params.target || !CONTROL_BINARIES.has(params.target)) throw new Error(`agent_control: target binary "${params.target ?? "?"}" is not allowlisted.`);
			const args = params.args ?? [];
			const result = await new Promise<{ ok: boolean; code: number | null; error?: string }>((resolve) => {
				execFile(params.target!, args, { cwd: identity!.cwd, timeout: 10_000 }, (error, _stdout, _stderr) => {
					resolve({ ok: !error, code: error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0, error: error ? String(error.message || error) : undefined });
				});
			});
			logEvent("agent_control", { verb: params.verb, target: params.target, args, ok: result.ok, code: result.code });
			return { content: [{ type: "text" as const, text: `agent_control ${params.verb}: ${params.target} (${result.ok ? "ok" : "postcondition failed"}).` }], details: { verb: params.verb, target: params.target, args, ...result } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("agent_control ")) + theme.fg("accent", `${(args as any).verb ?? "?"} ${(args as any).target ?? ""}`), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg((result.details as any)?.ok === false ? "warning" : "success", `→ ${(result.details as any)?.verb ?? "?"}`), 0, 0); },
	});

	pi.registerTool({
		name: "agent_list",
		label: "Agent List",
		description: "List the current agent and known peer instances (role, team, status) discovered via MQTT presence. The current instance is marked self=true and is not a valid delegation target. Presence is retained, so peers appear immediately even if they connected before you.",
		parameters: Type.Object({}),
		async execute() {
			// MQTT retained messages are delivered asynchronously after subscribe;
			// wait for the bounded initial hydration before exposing the roster.
			await presenceHydration;
			// Revisione 41 bug fix: the "offline" presence payload published on
			// LWT/clean shutdown deliberately carries only instance/role/project/
			// status/last_heartbeat (see the two `client.publishAsync(...,
			// {status:"offline", ...})` call sites) — it never had a `team`/
			// `capacity`/`current_load` to report in the first place, an agent
			// that's gone is gone. This tool assumed every PresenceCard was the
			// full shape and crashed (`Cannot read properties of undefined
			// (reading 'join')`) the first time ANY known peer went offline —
			// found while testing the agent_send presence-warning fix below,
			// which calls this same map. Default the missing fields instead of
			// assuming they're always present.
			const selfAgent = identity ? {
				instance: identity.instance,
				role: identity.role,
				team: identity.team ?? [],
				status: computeSelfStatus(),
				capacity: identity.capacity ?? 0,
				current_load: currentLoad(),
				self: true,
			} : null;
			const peers = [...presence.values()].filter((c) => c.status !== "offline").map((c) => ({
				instance: c.instance, role: c.role, team: c.team ?? [], status: c.status, capacity: c.capacity ?? 0, current_load: c.current_load ?? 0, self: false,
			}));
			const agents = selfAgent ? [selfAgent, ...peers] : peers;
			const lines = agents.length === 0
				? `No agent identity available for MQTT project "${identity?.project ?? "?"}" (the orchestrator may still be initialising).`
				: agents.map((a) => `${a.status === "idle" ? "●" : a.status === "busy" ? "◐" : "✗"} ${a.instance} (${a.role}) team=[${a.team.join(",")}] load=${a.current_load}/${a.capacity}${a.self ? " [self — do not delegate to this instance]" : ""}`).join("\n");
			return { content: [{ type: "text" as const, text: `${agents.length} agent(s) in project "${identity?.project ?? "?"}" (current instance included; self is not a delegation target):\n${lines}` }], details: { agents, project: identity?.project ?? null } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const agents = (result.details as any)?.agents ?? [];
			return new Text(theme.fg("accent", `⚡ ${agents.length} agent(s)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "agent_send",
		label: "Agent Send",
		description:
			"Send a task command to a peer agent, addressed either by exact instance id (target_instance, 1:1) or by role " +
			"(target_role, fans out to every live instance of that role — no claim arbitration at this stage, all of them will receive it). " +
			"Returns immediately with an assignment_id. Use agent_get (non-blocking) or agent_await (blocking) to retrieve the reply.\n\n" +
			"Every send inherits a hop count from whatever inbound task you're currently replying to, and is dropped once it exceeds " +
			`${MAX_HOPS} hops — a safety net against runaway auto-forwarding loops within ONE delegation chain. If you are deliberately ` +
			"starting a NEW round of work that is only logically related to a previous one (e.g. planner kicking off another full " +
			"correction cycle after reviewing a completed review, rather than just relaying/replying within the same chain), pass " +
			"new_round: true so it isn't mistaken for a runaway loop and dropped.\n\n" +
			"Pass slug whenever this send is part of a task (almost always) — it auto-appends a one-line audit event to that task's " +
			"report (reports/<slug>.md), recording who sent to whom, when, and a snapshot of every known agent's status at that " +
			"exact moment (Revisione 19), so the report alone shows whether the team followed the planner's phase plan. Best-effort: " +
			"if the report doesn't exist yet (or the slug is wrong), the send itself still succeeds, this just silently skips.",
		parameters: Type.Object({
			target_instance: Type.Optional(Type.String({ description: "Exact instance id, e.g. coder-01" })),
			target_role: Type.Optional(Type.String({ description: "Role name, e.g. coder — broadcasts to all live instances of that role" })),
			prompt: Type.String({ description: "The task/prompt to send." }),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
			new_round: Type.Optional(Type.Boolean({
				description:
					"Set true to start a fresh hop-count chain (0) instead of inheriting hops from the inbound task you're currently " +
					"handling. Use this when you're intentionally beginning a new round of work, not simply forwarding/replying within " +
					"the current one — otherwise a multi-round correction cycle can silently hit the hop limit and get dropped.",
			})),
			slug: Type.Optional(Type.String({
				description: "Task slug (same one used for worktree_create), if this send is part of a task — see above for what it enables.",
			})),
		}),
		async execute(_callId, params) {
			if (!identity || !client || !T) throw new Error("orchestrator not initialised");
			if (!params.target_instance && !params.target_role) throw new Error("agent_send: provide target_instance or target_role");
			const hops = params.new_round ? 0 : currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) throw new Error(`orchestrator: hop limit reached (${hops} >= ${MAX_HOPS})`);

			// Deterministic phase gate (Revisione 21) — refuses a send to a role
			// that belongs to a locked phase of this task's structured plan (see
			// plan_set/plan_advance above). Best-effort in scope, not in
			// enforcement: it only applies when a structured plan exists for
			// this slug — no plan_set call ever made for this task means no
			// gate, exactly the old ungated behavior. But once a plan DOES
			// exist, a genuine violation is refused for real, for ANY sender —
			// this is the one check in the whole file that's allowed to block
			// a send outright, on purpose (everything else here is advisory).
			if (params.slug) {
				try {
					const wt = requireWorktree(params.slug);
					const plan = readPlan(wt.path, params.slug);
					if (plan) {
						const targetRole = params.target_role ?? (params.target_instance ? presence.get(params.target_instance)?.role : undefined);
						if (targetRole) {
							assertRoleHandoffAllowed(identity.role, targetRole, params.slug);
							const phase = findPhaseForRole(plan, targetRole);
							if (phase && phase.status === "locked") {
								const blocker = plan.phases.find((p) => p.phase < phase.phase && p.status !== "complete");
								throw new Error(
									`agent_send: refused — "${targetRole}" belongs to phase ${phase.phase} of the plan for "${params.slug}", which is still ` +
										`locked${blocker ? ` (phase ${blocker.phase} isn't marked complete yet — call plan_advance on it first)` : ""}. ` +
										"Use plan_get to see the current plan and what's still pending.",
								);
							}
						}
					}
				} catch (err) {
					// Only a genuine gate violation propagates. Anything else that
					// went wrong while trying to CHECK the gate (bad slug, no
					// worktree, unreadable plan file) fails open — same best-
					// effort principle as the audit-line block further down: a
					// bookkeeping problem must never block a send that has
					// nothing to do with it.
					if (err instanceof Error && err.message.startsWith("agent_send: refused")) throw err;
				}
			}

			// Revisione 41: agent_send used to report success (a real
			// assignment_id, no warning of any kind) even when nobody was
			// actually subscribed to receive it — an MQTT publish doesn't fail
			// just because no one is listening. A planner that forgot to
			// actually launch the target role's instance first (see
			// prompts/planner.md, "Meccanismo di selezione", sezione 40) got no
			// feedback at all until the agent_send timeout fired 30 minutes
			// later (Revisione 30) — plenty of time to have already told the
			// user "delegated to the coder" while no coder existed. Check
			// presence NOW, before publishing, and surface a loud warning in
			// the tool's own return value if nobody live matches the target.
			// Still send regardless (the instance may be about to come online,
			// or this presence snapshot may be a beat stale) — this only makes
			// the silence visible immediately instead of half an hour later.
			const hasLiveMatch = () => params.target_instance
				? presence.get(params.target_instance)?.status !== "offline" && presence.has(params.target_instance)
				: [...presence.values()].some((c) => c.role === params.target_role && c.status !== "offline");
			// Retained MQTT presence can arrive just after the connect callback of a
			// newly started peer. Give that retained snapshot one short event-loop
			// window before declaring the target absent; otherwise two agents started
			// back-to-back are incorrectly escalated to watcher.
			let liveMatch = hasLiveMatch();
			if (!liveMatch) {
				await new Promise((resolve) => setTimeout(resolve, 150));
				liveMatch = hasLiveMatch();
			}
			const requestedTarget = params.target_instance || `role:${params.target_role}`;
			const livePlanners = [...presence.values()].filter((card) => card.role === "planner" && card.status !== "offline");
			let route: "target" | "planner" | "watcher" = "target";
			let fallbackTarget: string | null = null;
			let watcherBootstrap: { attempted: boolean; ok: boolean; detail?: string } = { attempted: false, ok: false };
			const ensureWatcherForFallback = (): { attempted: boolean; ok: boolean; detail?: string } => {
				if (!identity || process.env.PI_ORCH_TEST_NO_EXIT === "1") return { attempted: false, ok: false, detail: "test harness: bootstrap skipped" };
				try {
					const output = execFileSync("yano", ["watcher", "start", "--project-root", identity.cwd, "--project", identity.project], {
						cwd: identity.cwd,
						encoding: "utf8",
						timeout: 20_000,
						maxBuffer: 2_000_000,
					});
					return { attempted: true, ok: true, detail: String(output || "").trim().slice(-500) };
				} catch (error) {
					return { attempted: true, ok: false, detail: error instanceof Error ? error.message : String(error) };
				}
			};
			const noLiveTargetWarning = liveMatch
				? null
				: `⚠️ Nessuna istanza online per ${params.target_instance ? `"${params.target_instance}"` : `il ruolo "${params.target_role}"`} in questo progetto: la delega viene inoltrata automaticamente a planner o watcher.`;
			if (noLiveTargetWarning) {
				if (livePlanners.length) {
					route = "planner";
					fallbackTarget = livePlanners[0].instance;
				} else {
					route = "watcher";
					watcherBootstrap = ensureWatcherForFallback();
				}
				logEvent("agent_send_no_live_target", {
					target: requestedTarget,
					route,
					fallback_target: fallbackTarget,
					watcher_bootstrap: watcherBootstrap,
				});
			}

			const assignment_id = ulid();
			const env: CommandEnvelope = {
				type: "command",
				assignment_id,
				sender_instance: identity.instance,
				sender_role: identity.role,
				target_instance: params.target_instance,
				target_role: params.target_role,
				project: identity.project,
				prompt: params.prompt,
				reply_to: T.agentResponses(identity.instance),
				hops,
				timestamp: nowIso(),
				response_schema: (params.response_schema as object | undefined) ?? null,
			};

			let destTopic: string;
			if (route === "planner" && fallbackTarget) {
					destTopic = T.agentCommands(fallbackTarget);
					env.target_instance = fallbackTarget;
					env.target_role = "planner";
					env.prompt = `[yano-routing] Destinatario originale offline: ${requestedTarget}. Prendi in carico il messaggio originale e decidi se rilanciare o sostituire l'agente; non lasciare il flusso in attesa.\n\n${params.prompt}`;
				await client.publishAsync(destTopic, JSON.stringify(env), { qos: 1 });
			} else if (route === "watcher") {
				destTopic = T.agentFallback();
				// The watcher is a process, not a Pi peer. Keep the original command
				// intact inside a routing envelope so it can be replayed after it has
				// spawned planner-01. Retained QoS1 closes the startup race.
				await client.publishAsync(destTopic, JSON.stringify({
					type: "agent_route_fallback",
					fallback_id: ulid(),
					project: identity.project,
					original_target: requestedTarget,
					original: env,
					timestamp: nowIso(),
				}), { qos: 1, retain: true });
			} else {
				destTopic = params.target_instance ? T.agentCommands(params.target_instance) : T.roleTasks(params.target_role!);
				await client.publishAsync(destTopic, JSON.stringify(env), { qos: 1 });
			}

			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res) => { resolveFn = res; });
			const entry: PendingReply = {
				resolve: resolveFn,
				timer: null,
				promise,
				target: params.target_instance || `role:${params.target_role}`,
				created_at: nowIso(),
				prompt_preview: params.prompt.slice(0, 200),
			};
			entry.timer = setTimeout(() => {
				if (entry.result) return;
				entry.result = { error: "timeout" };
				entry.resolve(entry.result);
				scheduleEviction(assignment_id);
				// Revisione 30: nobody ever replied within TIMEOUT_MS (default 30
				// min) — same silent-black-hole risk as handleResponse above, but
				// for the "target never answered at all" case (dead/hung/ignored
				// the assignment) instead of "answered but nobody was listening".
				// Wake the sender (unless it's actively blocked in agent_await,
				// which already gets this via its own race) and, since a
				// half-hour of silence on a real delegation is a genuinely
				// actionable signal, also notify configured channels — mirrors the
				// watchdog's escalation for the same class of "something's
				// stuck and nobody would otherwise know" problem, just reached
				// via a different code path (agent_send timeout vs. a stale
				// ticket).
				if (!entry.awaiting) {
					try {
						pi.sendMessage(
							{
								customType: "orchestrator-timeout",
								content:
									`[nessuna risposta] ${entry.target} non ha risposto entro ${Math.round(TIMEOUT_MS / 60000)} minuti ` +
									`(assignment_id ${assignment_id}, prompt: "${entry.prompt_preview}${params.prompt.length > 200 ? "…" : ""}"). ` +
									"L'istanza target potrebbe essere bloccata, offline, o aver ignorato l'assegnazione — controlla agent_list/agent_activity " +
									"e valuta se riassegnare il lavoro.",
								display: true,
								details: { assignment_id, target: entry.target, timeout_ms: TIMEOUT_MS },
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch { /* best-effort, see handleResponse's identical guard */ }
					void sendNotifications(
						`⏱️ Nessuna risposta da ${entry.target} entro ${Math.round(TIMEOUT_MS / 60000)} min (assignment ${assignment_id}) — ${identity?.instance ?? "?"} è stato risvegliato per decidere come procedere.`,
					).then((r) => logEvent("notification_dispatch", { ok: r.ok, detail: r.detail, channels: r.channels, reason: "agent_send_timeout", assignment_id, target: entry.target }));
				}
			}, TIMEOUT_MS);
			try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
			pendingReplies.set(assignment_id, entry);

			pi.appendEntry("orchestrator-log", { event: "outbound_command", assignment_id, target: entry.target, hops });
			logEvent("agent_send_out", { assignment_id, target: entry.target, hops, new_round: !!params.new_round, prompt_preview: params.prompt.slice(0, 200), route, fallback_target: fallbackTarget, watcher_bootstrap: watcherBootstrap });

			// Best-effort audit line in the task's report (Revisione 19) — never
			// lets a report-bookkeeping problem fail the actual send, which is
			// the thing that matters. Silently skipped if slug wasn't passed, the
			// worktree doesn't exist yet, or the report hasn't been created yet
			// (e.g. the very first agent_send of a task, sent by the planner
			// BEFORE it creates reports/<slug>.md — nothing to append to yet).
			if (params.slug) {
				try {
					const wt = requireWorktree(params.slug);
					const file = reportPath(wt.path, params.slug);
					if (fs.existsSync(file)) {
						const line =
							`\n> _[evento] agent_send: \`${identity.instance}\` (\`${identity.role}\`) → \`${entry.target}\`` +
							` — assignment_id \`${assignment_id}\`, hops ${hops}${params.new_round ? ", new_round" : ""} — alle ${nowIso()}_\n` +
							`> _Stato team in quel momento: ${agentStatusSnapshot()}_\n`;
						fs.appendFileSync(file, line);
					}
				} catch {
					// best-effort — see comment above
				}
			}

			return {
				content: [{
					type: "text" as const,
					text: `agent_send → ${entry.target}\nassignment_id ${assignment_id}${noLiveTargetWarning ? `\n\n${noLiveTargetWarning}` : ""}`,
				}],
				details: { assignment_id, target: entry.target, hops, no_live_target: !!noLiveTargetWarning, route, fallback_target: fallbackTarget, watcher_bootstrap: watcherBootstrap },
			};
		},
		renderCall(args, theme) {
			const tgt = (args as any).target_instance || `role:${(args as any).target_role}` || "?";
			return new Text(theme.fg("toolTitle", theme.bold("agent_send ")) + theme.fg("accent", tgt), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const base = theme.fg("success", "→ ") + theme.fg("accent", d?.target ?? "?") + theme.fg("dim", "  assignment_id ") + theme.fg("warning", d?.assignment_id ?? "?");
			return new Text(d?.no_live_target ? theme.fg("warning", "⚠ nessuna istanza online  ") + base : base, 0, 0);
		},
	});

	pi.registerTool({
		name: "agent_get",
		label: "Agent Get",
		description: "Non-blocking poll of a pending agent_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({ assignment_id: Type.String({ description: "assignment_id returned by agent_send." }) }),
		async execute(_callId, params) {
			const entry = pendingReplies.get(params.assignment_id);
			if (!entry) {
				return { content: [{ type: "text" as const, text: `agent_get: unknown or already-resolved assignment_id ${params.assignment_id}` }], details: { status: "unknown" } };
			}
			if (entry.result) {
				const r = entry.result;
				const text = r.error ? `agent_get: error — ${r.error}` : `agent_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return { content: [{ type: "text" as const, text }], details: { status: r.error ? "error" : "complete", response: r.response, error: r.error ?? null } };
			}
			return { content: [{ type: "text" as const, text: "agent_get: pending" }], details: { status: "pending" } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_get ")) + theme.fg("warning", (args as any).assignment_id ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const status = (result.details as any)?.status ?? "?";
			const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	pi.registerTool({
		name: "agent_await",
		label: "Agent Await",
		description: "Block until a pending agent_send reply lands or the timeout fires. Default timeout 30 minutes (PI_ORCH_TIMEOUT_MS).",
		parameters: Type.Object({
			assignment_id: Type.String({ description: "assignment_id returned by agent_send." }),
			timeout_ms: Type.Optional(Type.Number()),
		}),
		async execute(_callId, params) {
			const entry = pendingReplies.get(params.assignment_id);
			if (!entry) {
				return { content: [{ type: "text" as const, text: `agent_await: unknown assignment_id ${params.assignment_id}` }], details: { error: "unknown assignment_id" } };
			}
			const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : TIMEOUT_MS;
			const timed = new Promise<{ error: string }>((resolve) => {
				const t = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
				try { (t as any).unref?.(); } catch { /* ignore */ }
			});
			// Revisione 30: mark this entry as actively awaited for the duration of
			// the race, so handleResponse / agent_send's own timeout branch know a
			// live turn is already about to receive the result directly (as this
			// call's return value) and skip their redundant wake-up. Always reset
			// in finally — the race can end via either branch, or throw.
			entry.awaiting = true;
			let winner: { response?: any; error?: string };
			try {
				winner = await Promise.race([entry.promise, timed]);
			} finally {
				entry.awaiting = false;
			}
			if ((winner as any).error) {
				return { content: [{ type: "text" as const, text: `agent_await: error — ${(winner as any).error}` }], details: { error: (winner as any).error } };
			}
			const resp = (winner as any).response;
			return { content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }], details: { response: resp, assignment_id: params.assignment_id, target: entry.target } };
		},
		renderCall(args, theme) {
			const assignmentId = String((args as any).assignment_id ?? "?");
			const target = pendingReplies.get(assignmentId)?.target ?? "?";
			return new Text(theme.fg("toolTitle", theme.bold("agent_await ")) + theme.fg("accent", target) + theme.fg("dim", " - ") + theme.fg("warning", assignmentId), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return d?.error ? new Text(theme.fg("error", `✗ ${d.error}`), 0, 0) : new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});

	pi.registerTool({
		name: "agent_publish_event",
		label: "Agent Publish Event",
		description:
			"Publish a visible event to one of your teams' event channel — e.g. \"finished implementing backend auth\". " +
			"Other team members see it via agent_activity without you addressing them directly. This is NOT a task command " +
			"and never triggers another agent's turn.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name (must be one you belong to)." }),
			summary: Type.String({ description: "Short human-readable description of what happened." }),
		}),
		async execute(_callId, params) {
			if (!identity || !client || !T) throw new Error("orchestrator not initialised");
			if (!identity.team.includes(params.team)) throw new Error(`agent_publish_event: not a member of team "${params.team}"`);
			await client.publishAsync(T.teamEvents(params.team), JSON.stringify({ from: identity.instance, summary: params.summary, timestamp: nowIso() }), { qos: 0 });
			return { content: [{ type: "text" as const, text: `published to team:${params.team}` }], details: { team: params.team } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_publish_event ")) + theme.fg("accent", (args as any).team ?? "?"), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "published"), 0, 0);
		},
	});

	pi.registerTool({
		name: "agent_activity",
		label: "Agent Activity",
		description: "Show recent events seen on your role/team channels — what other agents have done or dispatched, without you having to ask them directly.",
		parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "Max events to return (default 20)." })) }),
		async execute(_callId, params) {
			const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 20;
			const recent = activityLog.slice(-limit);
			const text = recent.length === 0 ? "No activity observed yet." : recent.map((e) => `[${e.timestamp}] ${e.channel} — ${e.from}: ${e.summary}`).join("\n");
			return { content: [{ type: "text" as const, text }], details: { events: recent } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_activity")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const n = ((result.details as any)?.events ?? []).length;
			return new Text(theme.fg("accent", `⚡ ${n} event(s)`), 0, 0);
		},
	});

	// Revisione 42 — the code-level "kill" half of "kill blocked instances and
	// recreate them": deterministic (no LLM judgment needed to actually make
	// the target exit — MQTT delivery aside, the target's own handleTerminate()
	// always runs the same clean-shutdown path), planner-only, and used both
	// manually (planner decides an instance is wedged, e.g. after an
	// agent_send that timed out) and automatically by watchdogSweep() for the
	// opt-in WATCHDOG_AUTO_TERMINATE_* hard-stuck tier. "Recreate" is
	// deliberately NOT this tool's job — see the honest-limit note on
	// paseoDetectAndLog()/herdrRenamePane() above: there is no verified way
	// for this extension to spawn a brand-new Herdr pane from
	// inside another instance's process, so relaunching stays a planner
	// action via the same Bash-driven mechanism already used for initial team
	// selection (prompts/planner.md, "Selezione dinamica del team").
	pi.registerTool({
		name: "agent_terminate",
		label: "Agent Terminate",
		description:
			"Force a peer instance to shut down cleanly RIGHT NOW (publishes offline presence, closes its MQTT connection, " +
			"exits) — planner-only. Use this when an instance is confirmably wedged (e.g. agent_list still shows it, but an " +
			"agent_send to it has already timed out, or a watchdog stall alert named it) and you've decided waiting longer " +
			"isn't worth it. This does NOT relaunch anything — after calling this, you MUST relaunch the instance yourself " +
			"(same Herdr mechanism as when you first launched the team) before delegating to it again; if you don't, " +
			"nothing will ever pick up its unfinished ticket. Best-effort delivery only: if the target is already gone, this " +
			"is a harmless no-op (nobody receives it).",
		parameters: Type.Object({
			target_instance: Type.String({ description: "Exact instance id to terminate, e.g. coder-01." }),
			reason: Type.String({ description: "Why you're terminating it — recorded in the event log and shown to the target before it exits." }),
		}),
		async execute(_callId, params) {
			if (!identity || !client || !T) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner") {
				throw new Error(`agent_terminate: only the planner role may terminate a peer instance (this instance is "${identity.role}").`);
			}
			if (params.target_instance === identity.instance) {
				throw new Error("agent_terminate: refusing to terminate yourself — call this from a different instance, or just stop your own turn.");
			}
			const card = presence.get(params.target_instance);
			const wasLive = !!card && card.status !== "offline";
			const env: TerminateEnvelope = {
				type: "terminate",
				requested_by_instance: identity.instance,
				requested_by_role: identity.role,
				reason: params.reason,
				timestamp: nowIso(),
			};
			await client.publishAsync(T.agentCommands(params.target_instance), JSON.stringify(env), { qos: 1 });
			logEvent("agent_terminate_sent", { target: params.target_instance, reason: params.reason, was_live: wasLive });
			return {
				content: [{
					type: "text" as const,
					text:
						`agent_terminate → ${params.target_instance}${wasLive ? "" : " (⚠️ nessuna presence online per questa istanza — probabile no-op)"}\n` +
						"Verifica con agent_list tra qualche secondo che sia sparita, poi rilanciala tu con Herdr (stesso flusso della " +
						"selezione del team) prima di delegare di nuovo — questo tool non rilancia nulla da solo.",
				}],
				details: { target: params.target_instance, was_live: wasLive },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_terminate ")) + theme.fg("accent", (args as any).target_instance ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return new Text((d?.was_live ? theme.fg("warning", "⚠ ") : "") + theme.fg("success", "→ terminate inviato a ") + theme.fg("accent", d?.target ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("worktree_create ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", d?.worktree_path ?? "?") + (d?.reused ? theme.fg("dim", " (reused)") : ""), 0, 0);
		},
	});

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
	pi.registerTool({
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
		async execute(_callId, _params) {
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
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("worktree_list_open")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const n = d?.open?.length ?? 0;
			return new Text(n > 0 ? theme.fg("accent", `→ ${n} open`) : theme.fg("dim", "→ none open"), 0, 0);
		},
	});

	// ━━ Multi-channel notifications (Fase 2 / M2) ━━━━━━━━━━━━━━━━━━━━━━━━━━━
	//
	// loadEnvFile/globalYanoConfig/getEnvVar/sendWhatsAppNotification/
	// sendTelegramNotification/sendEmailNotification/userMessageContext/
	// sendNotifications were extracted (dedented, identity injected as an
	// explicit parameter) into scripts/yano-notifications.ts. Thin wrappers
	// below keep every existing call site in this file unchanged.
	const sendWhatsAppNotification = (message: string) => notifications.sendWhatsAppNotification(message, identity);
	const sendTelegramNotification = (message: string) => notifications.sendTelegramNotification(message, identity);
	const sendEmailNotification = (message: string) => notifications.sendEmailNotification(message, identity);
	const sendNotifications = (message: string) => notifications.sendNotifications(message, identity);

	// createWatchdogSweep()'s dependency object closes over the live
	// identity/yanoStorage/client/T `let` bindings via getters (each can be
	// reassigned later — see scripts/watcher/watchdog-sweep.ts's header for
	// why a plain value snapshot here would go stale), and over
	// sendNotifications directly: unlike the hoisted `function` declarations
	// also passed below, sendNotifications is a `const` (Fase 2 / M2), so this
	// call must be positioned after its declaration above, not up where
	// watchdogSweep used to live — the setInterval that actually invokes
	// watchdogSweep (session_start, further below) only fires long after this
	// synchronous setup finishes, so where the setInterval registration
	// itself sits textually doesn't matter.
	const watchdogSweep = createWatchdogSweep({
		getIdentity: () => identity,
		getYanoStorage: () => yanoStorage,
		getClient: () => client,
		getTopics: () => T,
		presence,
		pi,
		logEvent,
		yanoPublishEvent,
		sendNotifications,
		withTimeout,
		projectKey,
		writeWatchdogHeartbeat,
		yanoFindStalledTickets,
		yanoFindUnfinalizedRuns,
		yanoFindOrphanedTickets,
		WATCHDOG_STALL_MS,
		WATCHDOG_AUTO_TERMINATE_ENABLED,
		WATCHDOG_AUTO_TERMINATE_MS,
		WATCHDOG_FINALIZE_GRACE_MS,
	});

	pi.registerTool({
		name: "notify_whatsapp",
		label: "Notify WhatsApp",
		description:
			"Send a WhatsApp-only message via Evolution API to the fixed destination number configured in .env (DESTINATION_PHONE_NUMBER), " +
			"from the WhatsApp connection named in EVOLUTION_INSTANCE_NAME. worktree_finalize already calls this automatically on " +
			"success (Revisione 19) — use this tool directly only for other cases, e.g. notifying the user when you escalate after " +
			"repeated failed correction rounds instead of finalizing. Silently reports back if .env isn't configured rather than " +
			"throwing, since WhatsApp notification is optional infrastructure, not a required part of any task.",
		parameters: Type.Object({
			message: Type.String({ description: "The WhatsApp message text to send." }),
		}),
		async execute(_callId, params) {
			const result = await sendWhatsAppNotification(params.message);
			logEvent("whatsapp_notify", { ok: result.ok, detail: result.detail, manual: true });
			return {
				content: [{ type: "text" as const, text: result.ok ? `notify_whatsapp: message sent.` : `notify_whatsapp: NOT sent — ${result.detail}` }],
				details: { ok: result.ok, detail: result.detail },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("notify_whatsapp")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return d?.ok ? new Text(theme.fg("success", "✓ sent"), 0, 0) : new Text(theme.fg("error", `✗ ${d?.detail ?? "not sent"}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "notify_all",
		label: "Notify All Channels",
		description:
			"Send a notification through every configured channel: WhatsApp via Evolution API, Telegram via the Bot API, and email via SendGrid. " +
			"Each channel is optional; the tool reports the result independently and never fails the task because a channel is unavailable.",
		parameters: Type.Object({
			message: Type.String({ description: "The notification text to send through all configured channels." }),
		}),
		async execute(_callId, params) {
			const result = await sendNotifications(params.message);
			logEvent("notification_dispatch", { ok: result.ok, detail: result.detail, channels: result.channels, manual: true });
			return {
				content: [{ type: "text" as const, text: result.ok ? `notify_all: ${result.detail}` : `notify_all: no channel sent the message — ${result.detail}` }],
				details: result,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("notify_all")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return d?.ok ? new Text(theme.fg("success", "✓ channels dispatched"), 0, 0) : new Text(theme.fg("warning", "⚠ no channel sent"), 0, 0);
		},
	});

	pi.registerTool({
		name: "finalize_evidence_collect",
		label: "Collect Finalize Evidence",
		description: "Collect one typed, idempotent finalize evidence record and bind it to the current worktree commit.",
		parameters: Type.Object({ run_id: Type.Optional(Type.String()), slug: Type.String(), kind: Type.Union([Type.Literal("test"), Type.Literal("workspace"), Type.Literal("commit"), Type.Literal("merge"), Type.Literal("push")]), source: Type.String(), observed_value: Type.Optional(Type.String()), idempotency_key: Type.String() }),
		async execute(_callId, params) {
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
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("finalize_evidence_collect ")) + theme.fg("accent", (args as any).kind ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.evidence?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "finalize_evidence_list",
		label: "List Finalize Evidence",
		description: "List redacted finalize evidence for a task slug.",
		parameters: Type.Object({ slug: Type.String() }),
		async execute(_callId, params) {
			const evidence = ensureYanoStorage().listFinalizeEvidence(params.slug).map((item) => redactRuntimeProjection(item));
			return { content: [{ type: "text" as const, text: `${evidence.length} finalize evidence record(s) for ${params.slug}.` }], details: { evidence } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("finalize_evidence_list ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.evidence ?? []).length)), 0, 0); },
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("worktree_finalize ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.merged) return new Text(theme.fg("success", "✓ merged & cleaned up"), 0, 0);
			if (d?.blocked_dirty_main) return new Text(theme.fg("error", "✗ blocked — main checkout is dirty"), 0, 0);
			return new Text(theme.fg("error", "✗ conflict — left for manual resolution"), 0, 0);
		},
	});

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
	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("worktree_abandon ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "✓ worktree removed"), 0, 0);
		},
	});

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
	function reportsDir(base: string): string {
		return yanoSubdirs(yanoWorkspaceDir(base)).reports;
	}

	function reportPath(worktreePath: string, slug: string): string {
		return path.join(reportsDir(worktreePath), `${slug}.md`);
	}

	function locksPath(worktreePath: string): string {
		return path.join(worktreePath, ".orchestrator-locks.json");
	}

	interface FileLock {
		file: string;
		holder: string;
		claimed_at: string;
		ttl_minutes: number;
	}

	function readLocks(worktreePath: string): FileLock[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(locksPath(worktreePath), "utf-8"));
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	function writeLocks(worktreePath: string, locks: FileLock[]): void {
		fs.writeFileSync(locksPath(worktreePath), JSON.stringify(locks, null, 2));
	}

	function lockExpired(lock: FileLock): boolean {
		return Date.now() - new Date(lock.claimed_at).getTime() > lock.ttl_minutes * 60_000;
	}

	function assertSafeRelativeFile(file: string): void {
		if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
			throw new Error(`"${file}" must be a relative path inside the worktree (no leading "/", no "..").`);
		}
	}

	function requireWorktree(slug: string): { path: string; branch: string } {
		if (!SLUG_RE.test(slug)) throw new Error(`"${slug}" is not a valid kebab-case slug.`);
		const wt = worktreePaths(identity!.cwd, slug);
		if (!fs.existsSync(wt.path)) throw new Error(`No worktree found for slug "${slug}" at ${wt.path} — call worktree_create first.`);
		return wt;
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
	type PlanPhaseStatus = "locked" | "unlocked" | "complete";
	interface PlanPhase {
		phase: number;
		roles: string[];
		note?: string;
		status: PlanPhaseStatus;
	}
	interface Plan {
		slug: string;
		phases: PlanPhase[];
		created_at: string;
		updated_at: string;
	}

	function planPath(worktreePath: string, slug: string): string {
		return path.join(reportsDir(worktreePath), `${slug}.plan.json`);
	}

	function planMarkdownPath(worktreePath: string, slug: string): string {
		return path.join(reportsDir(worktreePath), `${slug}.plan.md`);
	}

	function readPlan(worktreePath: string, slug: string): Plan | null {
		try {
			const raw = fs.readFileSync(planPath(worktreePath, slug), "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed && Array.isArray(parsed.phases)) return parsed as Plan;
			return null;
		} catch {
			return null;
		}
	}

	function renderPlanMarkdown(plan: Plan): string {
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

	function writePlan(worktreePath: string, slug: string, plan: Plan): void {
		fs.mkdirSync(path.dirname(planPath(worktreePath, slug)), { recursive: true });
		fs.writeFileSync(planPath(worktreePath, slug), JSON.stringify(plan, null, 2));
		fs.writeFileSync(planMarkdownPath(worktreePath, slug), renderPlanMarkdown(plan));
	}

	// Best-effort audit line in the task's report, same spirit as report_append/
	// agent_send's own auto-footer (Revisione 19) — never lets a report-
	// bookkeeping problem fail the plan operation itself.
	function appendPlanAudit(worktreePath: string, slug: string, text: string): void {
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
	function findPhaseForRole(plan: Plan, role: string): PlanPhase | undefined {
		const normalized = role.trim().toLowerCase();
		return plan.phases.find((p) => p.roles.some((r) => r.trim().toLowerCase() === normalized));
	}

	// Phase ordering alone does not prevent shortcuts when coder and reviewer
	// share a phase. Keep the core code handoff deterministic while also
	// recognising the dedicated refactor coding role.
	function assertRoleHandoffAllowed(senderRole: string, targetRole: string, slug: string): void {
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
	}

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("plan_set ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const plan = (result.details as any)?.plan as Plan | undefined;
			return new Text(theme.fg("success", "→ plan: ") + theme.fg("accent", plan ? `${plan.phases.length} fasi` : "?"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
				if (tickets.some((ticket) => !ticket || ticket.run_id !== params.run_id)) throw new Error("plan_advance: every ticket_id must exist and belong to run_id.");
				const incomplete = tickets.filter((ticket) => ticket!.status !== "done");
				if (incomplete.length) throw new Error(`plan_advance: phase ${params.completed_phase} has incomplete ticket(s): ${incomplete.map((ticket) => `${ticket!.id}=${ticket!.status}`).join(", ")}.`);
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("plan_advance ")) + theme.fg("accent", `${(args as any).slug ?? "?"} phase ${(args as any).completed_phase ?? "?"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const plan = (result.details as any)?.plan as Plan | undefined;
			const unlocked = plan?.phases.find((p) => p.status === "unlocked");
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", unlocked ? `fase ${unlocked.phase} sbloccata` : "nessuna fase successiva"), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_get",
		label: "Plan Get",
		description: "Read the current structured execution plan for a task, if one exists (plan_set may never have been called — that's not an error, just means this task has no gate). Any role may call this.",
		parameters: Type.Object({ slug: Type.String({ description: "Task slug — same one used for worktree_create." }) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const wt = requireWorktree(params.slug);
			const plan = readPlan(wt.path, params.slug);
			if (!plan) {
				return { content: [{ type: "text" as const, text: `plan_get: no structured plan for "${params.slug}" — agent_send isn't gated for this task.` }], details: { plan: null } };
			}
			return { content: [{ type: "text" as const, text: renderPlanMarkdown(plan) }], details: { plan } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("plan_get ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const plan = (result.details as any)?.plan as Plan | null;
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", plan ? `${plan.phases.length} fasi` : "nessun piano strutturato"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("report_append ")) + theme.fg("accent", (args as any).slug ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("success", "→ appended to ") + theme.fg("accent", (result.details as any)?.report_path ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("file_claim ")) + theme.fg("accent", (args as any).file ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return d?.claimed
				? new Text(theme.fg("success", "✓ claimed"), 0, 0)
				: new Text(theme.fg("error", `✗ held by ${d?.held_by ?? "?"}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "file_release",
		label: "File Release",
		description: "Release a file claimed with file_claim once you're done editing it, so other agents in the same worktree can claim it. Idempotent — a no-op if you don't hold it.",
		parameters: Type.Object({
			slug: Type.String({ description: "Task slug — same one used for worktree_create." }),
			file: Type.String({ description: "Path to the file, relative to the worktree root — same one passed to file_claim." }),
		}),
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("file_release ")) + theme.fg("accent", (args as any).file ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("dim", (result.details as any)?.released ? "→ released" : "→ no-op"), 0, 0);
		},
	});

	// ━━ YanoOrchestrator ticket/dependency tools (Revisione 26) ━━━━━━
	// See the module-scope section above for the storage/scheduler design.
	// This is a first vertical slice, additive on top of the existing
	// plan_set/plan_advance phase gate (not a replacement) — a task may use
	// either mechanism, or both, depending on what the planner picks.

// ━━ Playbook tools (Fase 4 / M4) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// playbook_bind/evidence_record/transition/evidence_list/effect_list/
	// effect_ack/effect_claim/effect_fail (8 of the 9 playbook_* tools) moved
	// verbatim into scripts/orchestrator-tools/playbooks.ts — wired below via
	// deps, all registered together here. playbook_reconcile (right below)
	// stays: it needs the plan-gate cluster, not yet extracted.
	for (const tool of createPlaybookTools({
		getIdentity: () => identity,
		ensureYanoStorage,
	})) pi.registerTool(tool);

	pi.registerTool({
		name: "playbook_reconcile",
		label: "Reconcile Playbook",
		description: "Compare a bound Playbook with its structured plan and ticket DAG. Persists a deterministic diff and never invents or mutates work.",
		parameters: Type.Object({
			run_id: Type.String(),
			slug: Type.String(),
			idempotency_key: Type.String(),
			mappings: Type.Array(Type.Object({ state_id: Type.String(), phase: Type.Integer({ minimum: 1 }), ticket_ids: Type.Array(Type.String()) })),
		}),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("playbook_reconcile: only planner may reconcile a run.");
			if (!params.idempotency_key.trim()) throw new Error("playbook_reconcile: idempotency_key is required.");
			const storage = ensureYanoStorage();
			const binding = storage.getPlaybookBinding(params.run_id);
			if (!binding) throw new Error(`playbook_reconcile: run "${params.run_id}" has no bound Playbook.`);
			const plan = readPlan(requireWorktree(params.slug).path, params.slug);
			if (!plan) throw new Error(`playbook_reconcile: no structured plan for "${params.slug}".`);
			const states = (binding.snapshot as any)?.states ?? [];
			const stateIds = new Set(states.map((state: any) => state.id));
			const seenStates = new Set<string>();
			const seenTickets = new Set<string>();
			const diff: any[] = [];
			for (const mapping of params.mappings) {
				if (!stateIds.has(mapping.state_id)) diff.push({ kind: "unknown_state", state_id: mapping.state_id });
				if (seenStates.has(mapping.state_id)) diff.push({ kind: "duplicate_state", state_id: mapping.state_id });
				seenStates.add(mapping.state_id);
				if (!plan.phases.some((phase) => phase.phase === mapping.phase)) diff.push({ kind: "unknown_phase", state_id: mapping.state_id, phase: mapping.phase });
				for (const ticketId of mapping.ticket_ids) {
					if (seenTickets.has(ticketId)) diff.push({ kind: "duplicate_ticket", ticket_id: ticketId });
					seenTickets.add(ticketId);
					const ticket = storage.getTicket(ticketId);
					if (!ticket || ticket.run_id !== params.run_id) diff.push({ kind: "ticket_not_in_run", ticket_id: ticketId });
				}
			}
			for (const state of states) if (!seenStates.has(state.id)) diff.push({ kind: "unmapped_state", state_id: state.id });
			const tickets = storage.listTickets(params.run_id);
			for (const ticket of tickets) if (!seenTickets.has(ticket.id)) diff.push({ kind: "unmapped_ticket", ticket_id: ticket.id, status: ticket.status });
			const phaseByTicket = new Map<string, number>();
			for (const mapping of params.mappings) for (const ticketId of mapping.ticket_ids) phaseByTicket.set(ticketId, mapping.phase);
			for (const dependency of storage.listDependencies(params.run_id)) {
				const dependentPhase = phaseByTicket.get(dependency.ticket_id);
				const prerequisitePhase = phaseByTicket.get(dependency.depends_on_id);
				if (dependentPhase !== undefined && prerequisitePhase !== undefined && prerequisitePhase > dependentPhase) diff.push({ kind: "dependency_phase_inversion", ticket_id: dependency.ticket_id, depends_on_id: dependency.depends_on_id });
			}
			const outcome = diff.length ? "needs_replan" : "coherent";
			const payload = { outcome, run_id: params.run_id, slug: params.slug, playbook_checksum: binding.checksum, generation: storage.getPlaybookRuntimeState(params.run_id)?.generation ?? 0, idempotency_key: params.idempotency_key, diff };
			const prior = storage.listCheckpoints(params.run_id).find((checkpoint: any) => checkpoint.label === "playbook_reconciliation" && checkpoint.payload?.idempotency_key === params.idempotency_key);
			if (!prior) { storage.createCheckpoint(params.run_id, "playbook_reconciliation", payload); storage.recordEvent(params.run_id, "playbook_reconciliation", payload); }
			return { content: [{ type: "text" as const, text: `playbook_reconcile: ${outcome} (${diff.length} finding(s)).` }], details: { reconciliation: payload, idempotent: !!prior } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_reconcile ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.reconciliation?.outcome ?? "?"), 0, 0); },
	});

// playbook_evidence_list moved above with its 7 siblings (Fase 4 / M4).
// ━━ Capability-card tools (Fase 4 / M3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// capability_card_verify/list/invalidate moved verbatim into
	// scripts/orchestrator-tools/capability-cards.ts — wired below via deps.
	for (const tool of createCapabilityCardTools({
		getIdentity: () => identity,
		ensureYanoStorage,
	})) pi.registerTool(tool);

// playbook_effect_list/ack/claim/fail moved above with their siblings
	// (Fase 4 / M4).

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("orchestrator_init")), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "→ workspace ready"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("run_create ")) + theme.fg("accent", String((args as any).objective ?? "?").slice(0, 60)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const run = (result.details as any)?.run;
			return new Text(theme.fg("success", "→ run ") + theme.fg("accent", run?.id ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("spec_create ")) + theme.fg("accent", (args as any).title ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const spec = (result.details as any)?.spec;
			return new Text(theme.fg("success", "→ spec ") + theme.fg("accent", spec?.id ?? "?"), 0, 0);
		},
	});

// ━━ Ticket tools (Fase 4 / M5) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// ticket_create/tickets_ready/ticket_claim/ticket_complete/ticket_requeue/
	// ticket_recovery_get moved verbatim into
	// scripts/orchestrator-tools/tickets.ts — wired below via deps.
	// activeTicketIds/publishPresence/computeSelfStatus stay here (Revisione
	// 40 presence wiring) and are passed straight through.
	for (const tool of createTicketTools({
		getIdentity: () => identity,
		ensureYanoStorage,
		logEvent,
		yanoPublishEvent,
		sendNotifications,
		activeTicketIds,
		publishPresence,
		computeSelfStatus,
	})) pi.registerTool(tool);

// ━━ Decision-hold tools (Fase 4 / M0) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// decision_hold_create/get/list/answer/cancel/escalate moved verbatim into
	// scripts/orchestrator-tools/decision-holds.ts — wired below via deps.
	for (const tool of createDecisionHoldTools({
		getIdentity: () => identity,
		ensureYanoStorage,
		logEvent,
		sendNotifications,
		yanoPublishEvent,
	})) pi.registerTool(tool);

// ━━ Retention-policy tools (Fase 4 / M1) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// retention_policy_set/preview/apply moved verbatim into
	// scripts/orchestrator-tools/retention-policy.ts — wired below via deps.
	for (const tool of createRetentionPolicyTools({
		getIdentity: () => identity,
		ensureYanoStorage,
	})) pi.registerTool(tool);

	pi.registerTool({
		name: "benchmark_record",
		label: "Record Benchmark",
		description: "Record a reproducible benchmark result against versioned hard thresholds.",
		parameters: Type.Object({ project: Type.String(), name: Type.String(), dataset: Type.String(), metrics: Type.Record(Type.String(), Type.Number()), thresholds: Type.Record(Type.String(), Type.Number()) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("benchmark_record: only planner may record benchmarks.");
			const benchmark = ensureYanoStorage().recordBenchmark(params);
			return { content: [{ type: "text" as const, text: `benchmark_record: ${benchmark.name} ${benchmark.status}.` }], details: { benchmark: redactRuntimeProjection(benchmark) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("benchmark_record ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.benchmark?.status ?? "?"), 0, 0); },
	});

// ━━ Governance-proposal tools (Fase 4 / M2) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// governance_proposal_create/validate/approve/reject moved verbatim into
	// scripts/orchestrator-tools/governance-proposals.ts — wired below via deps.
	for (const tool of createGovernanceProposalTools({
		getIdentity: () => identity,
		ensureYanoStorage,
	})) pi.registerTool(tool);

	pi.registerTool({
		name: "package_manifest_audit",
		label: "Audit Package Manifest",
		description: "Audit package name, public yano binary and distributed Playbook assets, recording checksum and findings.",
		parameters: Type.Object({}),
		async execute(_callId, _params) {
			if (!identity || identity.role !== "planner") throw new Error("package_manifest_audit: only planner may audit the package.");
			const audit = ensureYanoStorage().auditPackageManifest();
			return { content: [{ type: "text" as const, text: `package_manifest_audit: ${audit.status}.` }], details: { audit: redactRuntimeProjection(audit) } };
		},
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("package_manifest_audit")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.audit?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
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
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const storage = ensureYanoStorage();
			const run = storage.getRun(params.run_id);
			if (!run) throw new Error(`run_status: no run "${params.run_id}".`);
			const tickets = storage.listTickets(params.run_id);
			const deps = storage.listDependencies(params.run_id);
			const buckets = yanoComputeReadyBlocked(tickets, deps);
			const waves = yanoComputeExecutionWaves(tickets, deps);
			const events = storage.listEvents(params.run_id, { limit: 50 });
			const checkpoints = storage.listCheckpoints(params.run_id);
			const playbook_binding = redactRuntimeProjection(storage.getPlaybookBinding(params.run_id));
			const playbook_state = storage.getPlaybookRuntimeState(params.run_id);
			const playbook_evidence = storage.listPlaybookEvidence(params.run_id).map((item) => redactRuntimeProjection(item));
			const capability_cards = storage.listCapabilityCards(params.run_id).map((card) => redactRuntimeProjection(card));
			const playbook_effects = storage.listPlaybookEffects(params.run_id).map((effect) => redactRuntimeProjection(effect));
			const decision_holds = storage.listDecisionHolds(params.run_id).map((hold) => redactRuntimeProjection(hold));
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
				details: { run, finalization_status: run.finalization_status || (run.status === "completed" ? "pending_finalize" : "not_started"), tickets, dependencies: deps, ...buckets, waves, recent_events: events, checkpoints, playbook_binding, playbook_state, playbook_evidence, capability_cards, playbook_effects, decision_holds, stalled_tickets: stalled, unfinalized_run: unfinalized.length > 0 },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("run_status ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const run = (result.details as any)?.run;
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", run?.status ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
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
		async execute(_callId, params) {
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
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("run_watchdog_check")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const n = ((result.details as any)?.stalled ?? []).length + ((result.details as any)?.unfinalized ?? []).length;
			return n === 0 ? new Text(theme.fg("success", "→ nessun blocco"), 0, 0) : new Text(theme.fg("warning", `→ ${n} bloccat${n === 1 ? "o" : "i"}`), 0, 0);
		},
	});

	// ━━ agent_end: capture turn output and publish the response ━━━━━━━━━━
	//
	// Revisione 48 — reclamo reale dell'operatore: herdr suonava ad OGNI
	// istanza che finiva un turno, planner incluso ma anche ciascuno dei
	// worker (coder/reviewer/specialisti) — con un team di 6+ worker attivi,
	// un ding quasi costante, per turni che l'operatore non ha alcun motivo
	// di guardare (i worker coordinano tra loro via MQTT, non tramite
	// l'utente). Questo report-agent(..., "idle", ...) è l'unico segnale
	// verso herdr che questa estensione emette ad ogni fine turno — secondo
	// la documentazione ufficiale (herdr.dev/docs/integrations/), è così che
	// herdr sa che un pannello è tornato "idle", e tutto lascia intendere
	// (anche se non confermato contro un herdr reale in questa sandbox) che
	// sia questa transizione a far scattare il suono "done" automatico.
	// Fix: riporta "idle" a fine turno SOLO per il planner — è l'unico ruolo
	// che l'operatore segue davvero dal vivo, ed è anche l'unico caso in cui
	// "il turno è finito" coincide semanticamente con "sto aspettando che tu
	// mi dica/chieda qualcosa" (per un worker, un turno finito vuol dire solo
	// "sto aspettando il prossimo task via MQTT", niente che l'operatore
	// debba notare). Il report "idle" INIZIALE a session_start (poco sotto,
	// prima ancora del primo turno) resta invariato per OGNI ruolo — serve
	// solo a far comparire il pannello con il nome giusto nella sidebar di
	// herdr, non è legato al suono.
	// Limite onesto: se dopo questo fix senti ancora un ding per un worker,
	// il suono non dipende da questo report-agent (herdr potrebbe rilevare
	// "fine turno" anche da altro, es. il prompt di shell che ritorna) — il
	// fallback confermato dalla documentazione è personalizzare
	// `[ui.sound.agents]`/`[ui.sound]` nel tuo config.toml di herdr (vedi
	// docs/notes/development-notes.md, Revisione 48).
	pi.on("agent_end", async (_event, ctx) => {
		if (identity && identity.role === "planner") herdrReportAgent(identity.displayName, "idle", identity.instance);
		const inbound = [...inboundQueue.values()].reverse().find((i) => !i.fulfilled);
		// had_inbound:false è lo stesso segnale di before_agent_start's
		// had_pending_inbound, controllato di nuovo a fine turno: un turno che
		// finisce senza aver mai avuto un inbound da soddisfare è un turno che
		// l'agente ha fatto di propria iniziativa, non su assegnazione.
		logEvent("agent_end", { had_inbound: !!inbound, assignment_id: inbound?.assignment_id ?? null });
		logContextUsage(ctx, "agent_end");
		if (!identity) return;

		let lastAssistantText = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			const anyEntry = entry as any;
			if (anyEntry?.type === "message" && anyEntry?.message?.role === "assistant") {
				const content = anyEntry.message.content;
				if (typeof content === "string") lastAssistantText = content;
				else if (Array.isArray(content)) {
					const textParts = content.filter((c: any) => c?.type === "text").map((c: any) => c.text);
					if (textParts.length) lastAssistantText = textParts.join("\n");
				}
			}
		}
		tracePayload("assistant_response", {
			assignment_id: inbound?.assignment_id ?? null,
			text: lastAssistantText,
		}, "standard");
		if (identity) {
			const config = getTraceConfig({ cwd: identity.cwd, project: identity.project });
			if (traceEnabled(config.mode, "full")) {
				tracePayload("visible_session_branch", {
					assignment_id: inbound?.assignment_id ?? null,
					branch: ctx.sessionManager.getBranch(),
				}, "full");
			}
		}
		if (identity.role === "planner") {
			await yanoPublishAgentEvent("planner_task_completed", { assignment_id: inbound?.assignment_id ?? null });
		}
		if (!inbound || !client) {
			if (identity.role === "planner") wakeNextQueuedFeedback("planner_turn_end");
			return;
		}

		let response: any = lastAssistantText;
		let error: string | null = null;
		if (inbound.response_schema) {
			try { response = JSON.parse(lastAssistantText); } catch { /* leave as raw text if not valid JSON */ }
		}

		const env: ResponseEnvelope = {
			type: "response",
			assignment_id: inbound.assignment_id,
			responder_instance: identity.instance,
			response,
			error,
			timestamp: nowIso(),
		};
		try {
			await client.publishAsync(inbound.reply_to, JSON.stringify(env), { qos: 1 });
			inbound.fulfilled = true;
			inboundQueue.delete(inbound.assignment_id);
			if (currentInbound === inbound) currentInbound = null;
			pi.appendEntry("orchestrator-log", { event: "response_sent", assignment_id: inbound.assignment_id });
			void publishPresence(computeSelfStatus());
			if (identity.role === "planner") wakeNextQueuedFeedback("planner_turn_end");
		} catch (err) {
			pi.appendEntry("orchestrator-log", { event: "response_send_failed", assignment_id: inbound.assignment_id, error: err instanceof Error ? err.message : String(err) });
		}
	});

	// ━━ /orchestrator slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.registerCommand("orchestrator", {
		description: "Show known peers and recent activity (or force a presence re-publish).",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (trimmed === "refresh") {
				await publishPresence(computeSelfStatus());
			}
			try {
				ctx.ui.notify(`orchestrator: ${presence.size} peer(s), ${activityLog.length} recent event(s)`, "info");
			} catch { /* ignore */ }
		},
	});

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// withTimeout guards every network call here: if the broker is
	// unreachable (e.g. never actually connected — see the mosquitto bind
	// bug fixed in mqtt/mosquitto.conf), a QoS1 publishAsync/endAsync can
	// hang forever waiting for a connection that will never come, which
	// previously made Ctrl+C completely unresponsive. Shutdown must always
	// terminate within a bounded time no matter what state the connection is in.
	function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
		// Deliberately NOT unref'd: this is a watchdog whose only job is to
		// force the shutdown sequence to move on after `ms`. An unref'd timer
		// is only guaranteed to fire if something ELSE is keeping the event
		// loop alive in the meantime — if the mqtt client's own retry timers
		// happen to be unref'd too (or get cleared), an unref'd watchdog can be
		// abandoned entirely instead of firing, defeating its whole purpose.
		return Promise.race([
			p,
			new Promise<undefined>((resolve) => {
				setTimeout(() => resolve(undefined), ms);
			}),
		]);
	}

	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (heartbeatTimer) { try { clearInterval(heartbeatTimer); } catch { /* ignore */ } heartbeatTimer = null; }
		if (staleSweepTimer) { try { clearInterval(staleSweepTimer); } catch { /* ignore */ } staleSweepTimer = null; }
		if (watchdogTimer) { try { clearInterval(watchdogTimer); } catch { /* ignore */ } watchdogTimer = null; }
		if (client && identity && T) {
			try {
				// Clean disconnect: publish offline explicitly rather than relying
				// solely on the broker's LWT (which only fires on ungraceful drop).
				// Bounded to 2s — best-effort, never allowed to block shutdown.
				await withTimeout(
					client.publishAsync(T.agentStatus(identity.instance), JSON.stringify({ instance: identity.instance, role: identity.role, project: identity.project, project_key: projectKey(identity.cwd, identity.project), status: "offline", last_heartbeat: nowIso() }), { qos: 1, retain: true }),
					2000,
				);
			} catch { /* best-effort */ }
			// Try a graceful end first (bounded), then force-close regardless —
			// force:true drops any queued/in-flight packets instead of waiting
			// for them, guaranteeing the socket actually closes.
			try { await withTimeout(client.endAsync(), 1500); } catch { /* ignore */ }
			try { client.end(true); } catch { /* ignore */ }
			client = null;
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("orchestrator-pool", undefined); } catch { /* ignore */ }
		}
		releaseIdentityLease();
		if (yanoStorage) {
			try { yanoStorage.close(); } catch { /* ignore */ }
			yanoStorage = null;
		}
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });

	// SIGINT/SIGTERM: registering our own listener takes over full
	// responsibility for terminating the process (Node only auto-exits on
	// these signals when there are zero listeners) — so we must explicitly
	// exit once cleanup is done, and a second Ctrl+C while still shutting
	// down force-exits immediately rather than silently doing nothing.
	function handleTermSignal(): void {
		if (shuttingDown) {
			process.exit(1);
			return;
		}
		void cleanShutdown().finally(() => process.exit(0));
	}
	process.on("SIGINT", handleTermSignal);
	process.on("SIGTERM", handleTermSignal);
}
