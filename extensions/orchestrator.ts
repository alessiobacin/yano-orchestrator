/**
 * orchestrator — MQTT-based agent bus for Pi, replacing coms.ts's socket
 * transport and flat peer-to-peer paradigm with the role/instance/capability
 * model from docs/architecture.md.
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
 * Explicitly NOT implemented here (see docs/development-notes.md): the Scheduler
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
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../scripts/playbook-loader.mjs";
import { ensureTraceProject, getTraceConfig, traceEnabled } from "../scripts/yano-trace-storage.mjs";

// ESM-safe lazy require, used only inside SQLiteOrchestratorStorage's
// constructor to resolve node:sqlite on first actual use (see the
// "MultiAgentOrchestrator ticket/dependency layer" section below) — a
// top-level `import "node:sqlite"` would resolve it eagerly for every role,
// even ones that never touch a ticket tool.
const moaRequire = createRequire(import.meta.url);

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
const CONTROL_BINARIES = new Set(["tmux", "herdr", "pi", "yano"]);

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
// docs/development-notes.md), the run sits "completed" forever with no
// worktree merged and no human notified, and moaFindStalledTickets() above
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
// instead of relaunching a coder. moaFindStalledTickets() would eventually
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
// moaFindOrphanedTickets()/watchdogSweep() below for what this drives: an
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
	                          // claim arbitration at this stage — see docs/development-notes.md)
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

type PresenceStatus = "idle" | "busy" | "offline";

interface PresenceCard {
	instance: string;
	role: string;
	project: string;
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
	fulfilled: boolean;
}

// ━━ Config: agents.yaml / roles.yaml (architecture.md §2-4) ━━━━━━━━━━━━━━━━

interface RoleConfig {
	activation?: "always" | "lazy";
	playbook?: string;
	model?: { provider?: string; model?: string };
	skills?: string[];
	cli?: string[];
	mcp?: string[];
	teams?: string[];
	// Human-readable name and mission for a specialist role that has no
	// bespoke prompts/<role>.md file — see loadRolePrompt()/prompts/specialist.md.
	label?: string;
	brief?: string;
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

function topics(project: string) {
	return {
		agentCommands: (id: string) => `pi/${project}/agents/${id}/commands`,
		agentResponses: (id: string) => `pi/${project}/agents/${id}/responses`,
		agentStatus: (id: string) => `pi/${project}/agents/${id}/status`,
		agentStatusWildcard: () => `pi/${project}/agents/+/status`,
		roleTasks: (role: string) => `pi/${project}/roles/${role}/tasks`,
		teamEvents: (team: string) => `pi/${project}/teams/${team}/events`,
		// MultiAgentOrchestrator ticket/dependency layer (see below): "something
		// happened" signals only — SQLite (orchestratorStorage/orchestrator.db)
		// is the source of truth for what's actually true, this topic is just
		// pub/sub visibility on top of it, same split the operator asked for.
		// QoS 0, not retained: a client that (re)connects always reads the real
		// state from SQLite via run_status/tickets_ready, never from a replayed
		// MQTT message.
		runEvents: (runId: string) => `pi/${project}/runs/${runId}/events`,
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

const SENSITIVE_PROJECTION_KEY = /(?:secret|password|token|authorization|api[_-]?key|private[_-]?key)/i;
function redactRuntimeProjection(value: unknown, key?: string): unknown {
	if (key && SENSITIVE_PROJECTION_KEY.test(key)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map((item) => redactRuntimeProjection(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactRuntimeProjection(childValue, childKey)]));
	}
	return value;
}

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

// Revisione 38 (see docs/development-notes.md) — a real incident: the
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
		const cfgPath = path.join(cwd, ".pi", "extensions", "multiAgentOrchestrator", "config", "project.json");
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
	"Lavora sempre dentro worktree_path (mai nella directory principale del progetto — usa worktree_create con lo slug indicato se manca). Usa report_append (non il tool generico di scrittura file) per aggiungere una sezione \"## Round N — {{ROLE}}\" al report, e file_claim/file_release prima di modificare un file che altri agenti dello stesso team potrebbero toccare in parallelo. Quando hai finito rispondi con agent_send a chi ti ha coinvolto (o a target_role: \"coder\" se hai trovato un problema che richiede una modifica al codice). Non chiamare mai worktree_finalize: lo fa solo il planner a fine ciclo.";

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
	const fromPrimary = readRolePromptFile(primaryDir, role);
	if (fromPrimary !== null) return fromPrimary;
	if (fallbackDir) {
		const fromFallback = readRolePromptFile(fallbackDir, role);
		if (fromFallback !== null) return fromFallback;
	}
	if (roleCfg?.brief) {
		const specialistFromPrimary = readRolePromptFile(primaryDir, "specialist");
		if (specialistFromPrimary !== null) return specialistFromPrimary;
		if (fallbackDir) {
			const specialistFromFallback = readRolePromptFile(fallbackDir, "specialist");
			if (specialistFromFallback !== null) return specialistFromFallback;
		}
		return BUILTIN_SPECIALIST_PROMPT;
	}
	return DEFAULT_ROLE_PROMPTS[role] || `Sei l'agente ${role}, istanza {{INSTANCE}} nel progetto {{PROJECT}}. Usa agent_list/agent_send/agent_get/agent_await per collaborare con gli altri agenti.`;
}

function roleCapabilitiesPrompt(roleCfg?: RoleConfig): string {
	const skills = roleCfg?.skills?.length ? roleCfg.skills.join(", ") : "nessuna skill dichiarata";
	const cli = roleCfg?.cli?.length ? roleCfg.cli.join(", ") : "nessuna CLI dichiarata";
	const mcp = roleCfg?.mcp?.length ? roleCfg.mcp.join(", ") : "nessun MCP dichiarato";
	const activation = roleCfg?.activation === "lazy" ? "lazy: installazione/verifica eseguita quando il planner lancia questo ruolo" : "core: prerequisiti verificati da yano init/doctor";
	const playbook = roleCfg?.playbook || "default-orchestration";
	return `## Contratto delle capacità (enforced da roles.yaml)\n- Playbook: ${playbook}\n- Attivazione: ${activation}\n- Skill autorizzate: ${skills}\n- CLI autorizzate: ${cli}\n- MCP autorizzati: ${mcp}\nUsa solo queste capacità. Se una è mancante, interrompi il round, descrivi il comando/documentazione per risolvere e informa il planner; non sostituirla silenziosamente con strumenti equivalenti.`;
}

// Sets the terminal window/tab title via the standard OSC 0/2 escape
// sequence (ESC ] 0 ; <title> BEL) — the convention tmux/iTerm2/Terminal.app
// read to name a pane. Harmless secondary fallback for whatever multiplexer
// happens to be hosting `pi` (including a plain terminal tab). NOT relied on
// for herdr itself — see herdrReportAgent() below for herdr's actual naming
// mechanism, confirmed from https://herdr.dev/docs/integrations/ and
// https://herdr.dev/docs/cli-reference/.
function setTerminalTitle(title: string): void {
	try {
		if (process.stdout && process.stdout.isTTY) {
			process.stdout.write(`\x1b]0;${title}\x07`);
		}
	} catch {
		// non-fatal: not a TTY, or stdout not writable in this context
	}
}

// herdr injects HERDR_ENV=1, HERDR_PANE_ID, HERDR_BIN_PATH (and
// HERDR_SOCKET_PATH) into every process it manages. herdr's documented way
// for a managed process to report/override its own display name+state is
// `"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source <id> --agent
// <label> --state <idle|working|blocked|unknown>` — this is what actually
// controls the name shown in herdr's sidebar/"new agent" list (the OSC
// terminal-title trick above does NOT do this: herdr has its own explicit
// agent-state protocol, separate from the terminal title). --source is our
// own instance id (so herdr can tell repeated reports apart); --agent is the
// human-facing label (--name if given, otherwise --instance, so panes are
// named like the agent by default, per the original request). Complete no-op
// outside herdr (HERDR_ENV unset) so this is always safe to call.
//
// Honest limit: I verified this against herdr's own published docs (CLI +
// integrations reference), not against a live herdr binary — this sandbox
// has no herdr installed and no device bridge to your Mac in this session.
// If it doesn't take effect, the manual fallback confirmed in the same docs
// is `herdr agent rename <target> <name>` run from any terminal (target =
// pane id or live agent name), or the rename_pane keybinding inside herdr.
function herdrReportAgent(label: string, state: "idle" | "working" | "blocked" | "unknown", source: string): void {
	const bin = process.env.HERDR_BIN_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !bin || !paneId) return; // not running under herdr — no-op
	try {
		execFile(bin, ["pane", "report-agent", paneId, "--source", source, "--agent", label, "--state", state], () => {
			// best-effort: a failure here (older herdr version, binary moved,
			// etc.) must never break the extension or the agent's turn.
		});
	} catch {
		// ignore — see above
	}
}

// Directly renames the pane label in herdr's sidebar/"new agent" list — the
// explicit, user-confirmed fallback (from herdr's own CLI help on their
// machine) for when herdrReportAgent()'s state-reporting protocol above
// doesn't change what's shown there (e.g. because that list is a saved
// launch-profile name, not live per-turn state — see docs/development-notes.md
// Revisione 7/10). herdr exposes this as `herdr agent rename <pane_id>
// <name>` in some versions and `herdr pane rename <pane_id> <name>` in
// others; since I can't confirm which one exists on any given install from
// this sandbox, both are tried in order and the second only runs if the
// first fails (wrong-subcommand exit, not a real error) — so this stays a
// harmless no-op if herdr's actual CLI shape differs from both guesses.
// Same HERDR_ENV/HERDR_BIN_PATH/HERDR_PANE_ID no-op guard as
// herdrReportAgent(): does nothing outside herdr.
function herdrRenamePane(name: string): void {
	const bin = process.env.HERDR_BIN_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !bin || !paneId) return; // not running under herdr — no-op
	try {
		execFile(bin, ["agent", "rename", paneId, name], (err) => {
			if (!err) return; // succeeded, no need to try the alternate subcommand
			try {
				execFile(bin, ["pane", "rename", paneId, name], () => {
					// best-effort — if this also fails, there's nothing more we can
					// safely guess at from here; the manual fallback (running either
					// command yourself, or the rename_pane keybinding) still works.
				});
			} catch {
				// ignore
			}
		});
	} catch {
		// ignore
	}
}

// paseo (https://paseo.sh) — client-daemon tool for managing agent
// sessions. NOTE (Revisione 23, see docs/development-notes.md): confirmed in a
// real user test that `paseo run --provider <x> -- <text>` treats
// everything after `--provider` as a natural-language PROMPT for the
// agent, not literal argv to exec — there's no documented exec/shell
// subcommand. That means `paseo run` cannot be used to spawn a `pi -e
// extensions/orchestrator.ts --instance ... --role ...` process the way
// herdr can; prompts/planner.md no longer offers paseo as a launch option
// (tmux is the background-launch fallback instead — see "Selezione
// dinamica del team", punto 8). This detection stub is kept only for the
// case where a user runs an already-launched instance (started some other
// way) inside a paseo-managed pty by hand — PASEO_AGENT_ID (confirmed from
// paseo.sh/docs/cli + CHANGELOG.md, added v0.1.34) still gets set in that
// case, and it's harmless to log it if so.
//
// Honest limit, deliberately NOT worked around by guessing: unlike herdr,
// I found NO documented paseo command for a running process to report its
// own state or rename itself from the inside (herdrReportAgent()/
// herdrRenamePane()'s equivalent) — only higher-level commands run from
// OUTSIDE the process (`paseo workspace rename <id>`, `paseo project
// rename <id>`) that need an id this process has no confirmed way to
// obtain from its own env. Inventing a call here would repeat the exact
// mistake this project's own herdr integration was careful to avoid
// (fabricating a CLI surface never verified against a real binary) — so
// this stays a detection-only stub: it logs that we're running under
// paseo (useful for scripts/review-log.mjs) and is a safe no-op otherwise.
function paseoDetectAndLog(): void {
	const agentId = process.env.PASEO_AGENT_ID;
	if (!agentId) return; // not running under paseo — no-op
	try {
		logEvent("paseo_detected", { paseo_agent_id: agentId });
	} catch {
		// ignore — logging must never break the extension
	}
}

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

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (err, stdout, stderr) => {
			if (err) reject(new Error(stderr?.toString().trim() || err.message));
			else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
		});
	});
}

function worktreePaths(projectCwd: string, slug: string): { path: string; branch: string } {
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
async function ensureWorktreesGitignored(projectCwd: string): Promise<void> {
	// Covers .worktrees/ (task worktrees) — logs/ used to need the same
	// treatment (Revisione 18) until Revisione 37 moved it under
	// .pi/extensions/multiAgentOrchestrator/, which every scaffolded project
	// has gitignored wholesale since Revisione 31, so it no longer needs its
	// own entry here.
	const patterns: Array<{ dir: string; comment: string }> = [
		{ dir: ".worktrees/", comment: "# yano-orchestrator: per-task git worktrees (see docs/development-notes.md)" },
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

async function assertGitRepo(cwd: string): Promise<void> {
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
function normalizePath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

async function findExistingWorktree(projectCwd: string, wtPath: string): Promise<boolean> {
	const { stdout } = await execGit(["worktree", "list", "--porcelain"], projectCwd);
	const target = normalizePath(wtPath);
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		if (normalizePath(line.slice("worktree ".length).trim()) === target) return true;
	}
	return false;
}

// ━━ MultiAgentOrchestrator ticket/dependency layer (Revisione 26) ━━━━━━━━━━
//
// First vertical slice of the ticket/DAG/SQLite orchestration layer agreed
// with the operator on top of the existing MQTT+worktree+roster+phase-gate
// system (see docs/development-notes.md). Deliberate split, as specified by the
// operator:
//
//   MQTT   -> "something happened" — fast pub/sub signals (ticket_ready,
//             ticket_started, ticket_done, run_completed, ...), same bus
//             agent_send/agent_publish_event already use.
//   SQLite -> "what is actually true" — durable state for runs, specs,
//             tickets, ticket_dependencies, events, checkpoints, living at
//             .pi/extensions/multiAgentOrchestrator/orchestratorStorage/
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
// map/index generator, and vendoring To-Tickets. See docs/development-notes.md,
// Revisione 26, for the full list and rationale.
//
// Honest limit: node:sqlite (DatabaseSync) is used directly, verified only
// against this sandbox's Node 22.22.2 — it is an experimental Node API
// (stable without a flag on this version, per the ExperimentalWarning it
// still prints). Whether the Node build `pi` itself bundles/uses also has
// node:sqlite available is NOT verified here — same class of "verified in
// isolation, not against the real binary" limit already flagged for
// herdr/tmux elsewhere in this file.

const MOA_SCHEMA_VERSION = 1;
const MOA_STORAGE_SCHEMA_VERSION = 9;
const MOA_EXTENSION_VERSION = "0.1.0-slice1";

function moaWorkspaceDir(projectCwd: string): string {
	return path.join(projectCwd, ".pi", "extensions", "multiAgentOrchestrator");
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
// all three under `.pi/extensions/multiAgentOrchestrator/`, which has been
// gitignored by every scaffolded project since Revisione 31, makes "not
// tracked, not pushed, stays only on the machine where the project was
// developed" the default with zero extra configuration. See
// docs/development-notes.md, Revisione 37, for the full rationale
// (including why prompts/ is NOT meant to be edited per-project in the
// first place — role prompts are customized in the extension itself, once,
// for every project, not forked per scaffold).
function moaSubdirs(workspaceDir: string) {
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

interface MoaProjectConfig {
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
function moaEnsureWorkspace(projectCwd: string, project: string, projectNameOverride?: string): MoaProjectConfig {
	const workspaceDir = moaWorkspaceDir(projectCwd);
	const dirs = moaSubdirs(workspaceDir);
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	const configPath = path.join(dirs.config, "project.json");
	const now = nowIso();
	let cfg: MoaProjectConfig;
	if (fs.existsSync(configPath)) {
		try {
			cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		} catch {
			// Malformed config from a previous run — rewrite it rather than
			// crashing init, but never silently lose the workspace/db that
			// already exist alongside it.
			cfg = { schema_version: MOA_SCHEMA_VERSION, extension_version: MOA_EXTENSION_VERSION, project, created_at: now, updated_at: now };
		}
		cfg.updated_at = now;
		cfg.extension_version = MOA_EXTENSION_VERSION; // record which code last touched this workspace
		if (projectNameOverride) cfg.project = projectNameOverride;
	} else {
		cfg = { schema_version: MOA_SCHEMA_VERSION, extension_version: MOA_EXTENSION_VERSION, project: projectNameOverride || project, created_at: now, updated_at: now };
	}
	fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
	return cfg;
}

// ━━ Canonical records (storage-agnostic — this is the shape Planner code
// talks to; SQLiteOrchestratorStorage below is just one implementation) ━━

type RunStatus = "active" | "completed" | "failed" | "cancelled";
type TicketStatus = "pending" | "running" | "done" | "failed" | "cancelled";
type DecisionHoldStatus = "open" | "answered" | "expired" | "cancelled" | "blocked";

interface RunRecord {
	id: string;
	project: string;
	objective: string;
	domain: string;
	status: RunStatus;
	created_at: string;
	updated_at: string;
}

interface SpecRecord {
	id: string;
	run_id: string;
	title: string;
	content: string;
	file_path: string | null;
	created_at: string;
}

interface TicketRecord {
	id: string;
	run_id: string;
	spec_id: string | null;
	title: string;
	description: string;
	domain: string;
	status: TicketStatus;
	required_capabilities: string[];
	required_playbook: string | null;
	acceptance_criteria: string[];
	assigned_instance: string | null;
	result_summary: string | null;
	created_at: string;
	updated_at: string;
}

interface DependencyRecord {
	ticket_id: string;
	depends_on_id: string;
}

interface DecisionHoldRecord {
	id: string;
	run_id: string;
	ticket_id: string | null;
	generation: number;
	question: string;
	context: unknown;
	owner: string;
	playbook_checksum?: string | null;
	escalated_to?: string | null;
	escalation_version?: number;
	status: DecisionHoldStatus;
	answer: string | null;
	resolution_metadata: unknown;
	created_at: string;
	expires_at: string | null;
	updated_at: string;
}

interface EventRecord {
	id: number;
	run_id: string;
	ticket_id: string | null;
	type: string;
	payload: unknown;
	created_at: string;
}

// ━━ OrchestratorStorage abstraction ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Planner/tool code below only ever talks to this interface, never to raw
// SQL — the operator's plan (§6) asked explicitly for this so a future
// storage backend could be swapped in without touching orchestration logic.
// SQLite is the only implementation for this slice; nothing else is planned
// for V1.

interface OrchestratorStorage {
	init(): void;
	getSchemaVersion(): number;
	createRun(input: { id?: string; project: string; objective: string; domain?: string }): RunRecord;
	getRun(id: string): RunRecord | null;
	listRuns(project?: string): RunRecord[];
	updateRunStatus(id: string, status: RunStatus): void;
	createSpec(input: { id?: string; run_id: string; title: string; content: string; file_path?: string | null }): SpecRecord;
	getSpec(id: string): SpecRecord | null;
	createTicket(input: {
		id?: string;
		run_id: string;
		spec_id?: string | null;
		title: string;
		description?: string;
		domain?: string;
		required_capabilities?: string[];
		acceptance_criteria?: string[];
		required_playbook?: string | null;
	}): TicketRecord;
	getTicket(id: string): TicketRecord | null;
	listTickets(run_id: string): TicketRecord[];
	updateTicketStatus(id: string, status: TicketStatus, extra?: { assigned_instance?: string | null; result_summary?: string | null }): TicketRecord;
	requeueTicketForRecovery(id: string, input: { reason: string; max_retries: number; max_replans?: number }): unknown;
	getTicketRecovery(id: string): unknown;
	recordFinalizeEvidence(input: { run_id?: string | null; slug: string; kind: string; source: string; observed_value: string; commit_hash?: string | null; status: string; idempotency_key: string }): unknown;
	listFinalizeEvidence(slug: string): unknown[];
	setRetentionPolicy(input: { project: string; event_days: number; evidence_days: number; outbox_days: number; dead_letter_days: number; policy_version: number }): unknown;
	previewRetention(project: string): unknown;
	applyRetention(project: string): unknown;
	recordBenchmark(input: { project: string; name: string; dataset: string; metrics: Record<string, number>; thresholds: Record<string, number> }): unknown;
	createGovernanceProposal(input: { kind: string; identifier: string; document: string; required_capabilities?: string[] }): unknown;
	listGovernanceProposals(kind?: string): unknown[];
	validateGovernanceProposal(id: number): unknown;
	approveGovernanceProposal(id: number): unknown;
	rejectGovernanceProposal(id: number, reason: string): unknown;
	auditPackageManifest(): unknown;
	addDependency(ticket_id: string, depends_on_id: string): void;
	listDependencies(run_id: string): DependencyRecord[];
	recordEvent(run_id: string, type: string, payload?: unknown, ticket_id?: string | null): EventRecord;
	listEvents(run_id: string, opts?: { since_id?: number; limit?: number }): EventRecord[];
	createCheckpoint(run_id: string, label: string, payload?: unknown): void;
	listCheckpoints(run_id: string): Array<{ id: number; run_id: string; label: string; payload: unknown; created_at: string }>;
	bindPlaybook(run_id: string, playbook: { id: string; schema_version: number; metadata: { origin: string; checksum: string }; snapshot: unknown }): { run_id: string; playbook_id: string; schema_version: number; origin: string; checksum: string; snapshot: unknown; created_at: string };
	getPlaybookBinding(run_id: string): { run_id: string; playbook_id: string; schema_version: number; origin: string; checksum: string; snapshot: unknown; created_at: string } | null;
	getPlaybookRuntimeState(run_id: string): { run_id: string; state_id: string; generation: number; updated_at: string } | null;
	recordPlaybookEvidence(run_id: string, input: { requirement: string; source: string; idempotency_key: string; cwd?: string }): unknown;
	listPlaybookEvidence(run_id: string): unknown[];
	upsertCapabilityCard(input: { run_id: string; role: string; instance: string; capability: string; source: string; scope: string; fingerprint: string; playbook_checksum: string; status: string; verified_at?: string | null; expires_at?: string | null; last_error?: string | null }): unknown;
	listCapabilityCards(run_id: string): unknown[];
	invalidateCapabilityCard(run_id: string, role: string, instance: string, capability: string, reason: string): unknown;
	transitionPlaybook(run_id: string, input: { transition_id: string; actor: string; expected_generation?: number }): { run_id: string; from: string; to: string; transition_id: string; generation: number; updated_at: string; effects: unknown[] };
	listPlaybookEffects(run_id: string, status?: string): unknown[];
	claimPlaybookEffect(id: number, input: { owner: string; token: string; lease_until: string }): unknown;
	failPlaybookEffect(id: number, input: { owner: string; token: string; error: string; max_attempts: number; next_attempt_at?: string }): unknown;
	ackPlaybookEffect(id: number, input: { idempotency_key: string; generation: number; actor_role?: string }): unknown;
	createDecisionHold(input: { id?: string; idempotency_key: string; run_id: string; ticket_id?: string | null; generation?: number; question: string; context?: unknown; owner: string; expires_at?: string | null }): DecisionHoldRecord;
	getDecisionHold(id: string): DecisionHoldRecord | null;
	listDecisionHolds(run_id: string, status?: DecisionHoldStatus): DecisionHoldRecord[];
	answerDecisionHold(id: string, input: { generation: number; idempotency_key: string; answer: string; resolution_metadata?: unknown; expected_checksum?: string; principal?: string }): DecisionHoldRecord;
	cancelDecisionHold(id: string, input: { generation: number; idempotency_key: string; reason?: string; expected_checksum?: string; principal?: string }): DecisionHoldRecord;
	escalateDecisionHold(id: string, input: { generation: number; idempotency_key: string; escalated_to: string; expected_checksum?: string }): DecisionHoldRecord;
	expireDecisionHolds(now: string): DecisionHoldRecord[];
	drainDecisionHoldOutbox(): Array<{ id: number; run_id: string; hold_id: string; payload: unknown }>;
	close(): void;
}

const MOA_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	project TEXT NOT NULL,
	objective TEXT NOT NULL,
	domain TEXT NOT NULL DEFAULT 'generic',
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	file_path TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	spec_id TEXT REFERENCES specs(id),
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	domain TEXT NOT NULL DEFAULT 'generic',
	status TEXT NOT NULL DEFAULT 'pending',
	required_capabilities TEXT NOT NULL DEFAULT '[]',
	required_playbook TEXT,
	acceptance_criteria TEXT NOT NULL DEFAULT '[]',
	assigned_instance TEXT,
	result_summary TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_dependencies (
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	depends_on_id TEXT NOT NULL REFERENCES tickets(id),
	PRIMARY KEY (ticket_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS ticket_recovery_state (
	 ticket_id TEXT PRIMARY KEY REFERENCES tickets(id),
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 retry_count INTEGER NOT NULL DEFAULT 0,
	 replan_round INTEGER NOT NULL DEFAULT 0,
	 max_retries INTEGER NOT NULL DEFAULT 3,
	 max_replans INTEGER NOT NULL DEFAULT 3,
	 recovery_generation INTEGER NOT NULL DEFAULT 0,
	 status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','exhausted')),
	 last_failure TEXT,
	 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_recovery_run ON ticket_recovery_state(run_id, status);

CREATE TABLE IF NOT EXISTS finalize_evidence (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT,
	 slug TEXT NOT NULL,
	 kind TEXT NOT NULL CHECK (kind IN ('test','workspace','commit','merge','push')),
	 source TEXT NOT NULL,
	 observed_value TEXT NOT NULL,
	 commit_hash TEXT,
	 status TEXT NOT NULL CHECK (status IN ('verified','stale','failed')),
	 idempotency_key TEXT NOT NULL,
	 created_at TEXT NOT NULL,
	 UNIQUE(slug, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_finalize_evidence_slug_kind ON finalize_evidence(slug, kind, status);
CREATE TABLE IF NOT EXISTS retention_policies (
	 project TEXT PRIMARY KEY,
	 event_days INTEGER NOT NULL,
	 evidence_days INTEGER NOT NULL,
	 outbox_days INTEGER NOT NULL,
	 dead_letter_days INTEGER NOT NULL,
	 policy_version INTEGER NOT NULL,
	 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_runs (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 project TEXT NOT NULL,
	 name TEXT NOT NULL,
	 dataset TEXT NOT NULL,
	 metrics TEXT NOT NULL,
	 thresholds TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('passed','failed')),
	 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS governance_proposals (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 kind TEXT NOT NULL CHECK (kind IN ('playbook','role')),
	 identifier TEXT NOT NULL,
	 document TEXT NOT NULL,
	 checksum TEXT NOT NULL,
	 required_capabilities TEXT NOT NULL DEFAULT '[]',
	 status TEXT NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox','validated','approved','rejected')),
	 created_at TEXT NOT NULL,
	 approved_at TEXT,
	 UNIQUE(kind, identifier, checksum)
);
CREATE TABLE IF NOT EXISTS package_manifest_audits (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 package_name TEXT NOT NULL,
	 package_version TEXT NOT NULL,
	 checksum TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('passed','failed')),
	 findings TEXT NOT NULL DEFAULT '[]',
	 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_holds (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	ticket_id TEXT REFERENCES tickets(id),
	generation INTEGER NOT NULL DEFAULT 0,
	question TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '{}',
	owner TEXT NOT NULL,
	playbook_checksum TEXT,
	escalated_to TEXT,
	escalation_version INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired', 'cancelled', 'blocked')),
	answer TEXT,
	resolution_metadata TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	expires_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_hold_operations (
	hold_id TEXT NOT NULL REFERENCES decision_holds(id),
	operation TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (hold_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	ticket_id TEXT,
	type TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	label TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_run ON tickets(run_id);
CREATE INDEX IF NOT EXISTS idx_decision_holds_run_status ON decision_holds(run_id, status);
CREATE TABLE IF NOT EXISTS decision_hold_outbox (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 hold_id TEXT NOT NULL REFERENCES decision_holds(id),
	 dedupe_key TEXT NOT NULL UNIQUE,
	 payload TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched')),
	created_at TEXT NOT NULL,
	 dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_hold_outbox_pending ON decision_hold_outbox(status, id);
CREATE TABLE IF NOT EXISTS playbook_bindings (
	 run_id TEXT PRIMARY KEY REFERENCES runs(id),
	 playbook_id TEXT NOT NULL,
	 schema_version INTEGER NOT NULL,
	 origin TEXT NOT NULL,
	 checksum TEXT NOT NULL,
	 snapshot TEXT NOT NULL,
	 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbook_runtime_state (
	 run_id TEXT PRIMARY KEY REFERENCES runs(id),
	 state_id TEXT NOT NULL,
	 generation INTEGER NOT NULL DEFAULT 0,
	 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbook_evidence (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 requirement TEXT NOT NULL,
	 source TEXT NOT NULL,
	 idempotency_key TEXT NOT NULL,
	 created_at TEXT NOT NULL,
	 UNIQUE(run_id, requirement, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_playbook_evidence_run_requirement ON playbook_evidence(run_id, requirement);
CREATE TABLE IF NOT EXISTS playbook_capability_cards (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 role TEXT NOT NULL,
	 instance TEXT NOT NULL,
	 capability TEXT NOT NULL,
	 source TEXT NOT NULL,
	 scope TEXT NOT NULL,
	 fingerprint TEXT NOT NULL,
	 playbook_checksum TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('declared','probing','verified','failed','expired','blocked')),
	 verified_at TEXT,
	 expires_at TEXT,
	 last_error TEXT,
	 UNIQUE(run_id, role, instance, capability)
);
CREATE INDEX IF NOT EXISTS idx_playbook_capability_cards_run_status ON playbook_capability_cards(run_id, status);
CREATE TABLE IF NOT EXISTS playbook_effect_outbox (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 run_id TEXT NOT NULL REFERENCES runs(id),
	 transition_id TEXT NOT NULL,
	 generation INTEGER NOT NULL,
	 effect_id TEXT NOT NULL,
	 kind TEXT NOT NULL,
	 payload TEXT NOT NULL DEFAULT '{}',
	 dedupe_key TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched')),
	delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','leased','delivered','failed','dead_letter')),
	attempts INTEGER NOT NULL DEFAULT 0,
	lease_owner TEXT,
	lease_token TEXT,
	lease_until TEXT,
	last_error TEXT,
	next_attempt_at TEXT,
	created_at TEXT NOT NULL,
	 dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_playbook_effect_outbox_run_status ON playbook_effect_outbox(run_id, status, id);
CREATE TABLE IF NOT EXISTS playbook_effect_operations (
	 effect_id INTEGER NOT NULL REFERENCES playbook_effect_outbox(id),
	 operation TEXT NOT NULL,
	 idempotency_key TEXT NOT NULL,
	 created_at TEXT NOT NULL,
	 PRIMARY KEY (effect_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_deps_ticket ON ticket_dependencies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON ticket_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
`;

function retentionCutoffs(policy: { event_days: number; evidence_days: number; outbox_days: number; dead_letter_days: number }) {
	const cutoff = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	return {
		events: cutoff(policy.event_days),
		evidence: cutoff(policy.evidence_days),
		outbox: cutoff(policy.outbox_days),
		dead_letter: cutoff(policy.dead_letter_days),
	};
}

class SQLiteOrchestratorStorage implements OrchestratorStorage {
	private db: import("node:sqlite").DatabaseSync;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		// Lazy require via createRequire so a module that never touches the
		// ticket layer (every existing tool) never pays for resolving
		// node:sqlite at all, and a missing/incompatible node:sqlite only
		// breaks the ticket tools, not the whole extension — same "never let
		// an optional piece take down the rest" discipline as herdr/paseo
		// detection elsewhere in this file.
		const { DatabaseSync } = moaRequire("node:sqlite") as typeof import("node:sqlite");
		this.db = new DatabaseSync(dbPath);
	}

	init(): void {
		this.db.exec(MOA_SCHEMA_SQL);
		const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
		if (!row) {
			this.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(MOA_STORAGE_SCHEMA_VERSION));
		} else if (!Number.isInteger(Number(row.value)) || Number(row.value) < 1) {
			throw new Error(`orchestrator.db schema_version is invalid: ${row.value} — refusing to open.`);
		} else if (Number(row.value) > MOA_STORAGE_SCHEMA_VERSION) {
			// This code is OLDER than the schema it's opening — refuse rather
			// than risk silently misreading a newer layout. No migration engine
			// exists yet for the reverse case (older schema, newer code) either
			// — deferred per plan §44, this is just the safety guard that would
			// need to grow migrations behind it.
			throw new Error(
				`orchestrator.db schema_version ${row.value} is newer than this extension supports (${MOA_STORAGE_SCHEMA_VERSION}) — refusing to open. Update the extension.`,
			);
		} else if (Number(row.value) < MOA_STORAGE_SCHEMA_VERSION) {
			const current = Number(row.value);
			if (current < 3) {
				for (const sql of [
					"ALTER TABLE playbook_effect_outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','leased','delivered','failed','dead_letter'))",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN lease_owner TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN lease_token TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN lease_until TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN last_error TEXT",
					"ALTER TABLE playbook_effect_outbox ADD COLUMN next_attempt_at TEXT",
				]) this.db.exec(sql);
			}
			if (current < 4) {
				for (const sql of [
					"ALTER TABLE decision_holds ADD COLUMN playbook_checksum TEXT",
					"ALTER TABLE decision_holds ADD COLUMN escalated_to TEXT",
					"ALTER TABLE decision_holds ADD COLUMN escalation_version INTEGER NOT NULL DEFAULT 0",
				]) this.db.exec(sql);
			}
			if (current < 5) {
				// v5 adds ticket_recovery_state; MOA_SCHEMA_SQL created it above.
				// Keep the marker advance after the CREATE batch so old databases
				// never advertise recovery support before the table exists.
				this.db.prepare("SELECT 1 FROM ticket_recovery_state LIMIT 1").get();
			}
			if (current < 6) this.db.prepare("SELECT 1 FROM finalize_evidence LIMIT 1").get();
			if (current < 7) {
				this.db.prepare("SELECT 1 FROM retention_policies LIMIT 1").get();
				this.db.prepare("SELECT 1 FROM benchmark_runs LIMIT 1").get();
			}
			if (current < 8) {
				this.db.prepare("SELECT 1 FROM governance_proposals LIMIT 1").get();
				this.db.prepare("SELECT 1 FROM package_manifest_audits LIMIT 1").get();
			}
			if (current < 9) this.db.exec("ALTER TABLE tickets ADD COLUMN required_playbook TEXT");
			// Advance the marker only after every additive statement succeeds.
			this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(MOA_STORAGE_SCHEMA_VERSION));
		}
	}

	getSchemaVersion(): number {
		const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
		return row ? Number(row.value) : 0;
	}

	createRun(input: { id?: string; project: string; objective: string; domain?: string }): RunRecord {
		const now = nowIso();
		const rec: RunRecord = { id: input.id || ulid(), project: input.project, objective: input.objective, domain: input.domain || "generic", status: "active", created_at: now, updated_at: now };
		this.db
			.prepare("INSERT INTO runs (id, project, objective, domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(rec.id, rec.project, rec.objective, rec.domain, rec.status, rec.created_at, rec.updated_at);
		return rec;
	}

	getRun(id: string): RunRecord | null {
		const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRecord | undefined;
		return row ?? null;
	}

	listRuns(project?: string): RunRecord[] {
		if (project) return this.db.prepare("SELECT * FROM runs WHERE project = ? ORDER BY created_at DESC").all(project) as RunRecord[];
		return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunRecord[];
	}

	updateRunStatus(id: string, status: RunStatus): void {
		this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
	}

	createSpec(input: { id?: string; run_id: string; title: string; content: string; file_path?: string | null }): SpecRecord {
		const rec: SpecRecord = { id: input.id || ulid(), run_id: input.run_id, title: input.title, content: input.content, file_path: input.file_path ?? null, created_at: nowIso() };
		this.db.prepare("INSERT INTO specs (id, run_id, title, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(rec.id, rec.run_id, rec.title, rec.content, rec.file_path, rec.created_at);
		return rec;
	}

	getSpec(id: string): SpecRecord | null {
		const row = this.db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as SpecRecord | undefined;
		return row ?? null;
	}

	createTicket(input: {
		id?: string;
		run_id: string;
		spec_id?: string | null;
		title: string;
		description?: string;
		domain?: string;
		required_capabilities?: string[];
		acceptance_criteria?: string[];
	}): TicketRecord {
		const now = nowIso();
		const rec: TicketRecord = {
			id: input.id || ulid(),
			run_id: input.run_id,
			spec_id: input.spec_id ?? null,
			title: input.title,
			description: input.description ?? "",
			domain: input.domain ?? "generic",
			status: "pending",
			required_capabilities: input.required_capabilities ?? [],
			required_playbook: input.required_playbook ?? null,
			acceptance_criteria: input.acceptance_criteria ?? [],
			assigned_instance: null,
			result_summary: null,
			created_at: now,
			updated_at: now,
		};
		this.db
			.prepare(
				"INSERT INTO tickets (id, run_id, spec_id, title, description, domain, status, required_capabilities, required_playbook, acceptance_criteria, assigned_instance, result_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(rec.id, rec.run_id, rec.spec_id, rec.title, rec.description, rec.domain, rec.status, JSON.stringify(rec.required_capabilities), rec.required_playbook, JSON.stringify(rec.acceptance_criteria), rec.assigned_instance, rec.result_summary, rec.created_at, rec.updated_at);
		return rec;
	}

	private rowToTicket(row: any): TicketRecord {
		return {
			...row,
			required_capabilities: JSON.parse(row.required_capabilities || "[]"),
			acceptance_criteria: JSON.parse(row.acceptance_criteria || "[]"),
		};
	}

	getTicket(id: string): TicketRecord | null {
		const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as any;
		return row ? this.rowToTicket(row) : null;
	}

	listTickets(run_id: string): TicketRecord[] {
		const rows = this.db.prepare("SELECT * FROM tickets WHERE run_id = ? ORDER BY created_at ASC").all(run_id) as any[];
		return rows.map((r) => this.rowToTicket(r));
	}

	updateTicketStatus(id: string, status: TicketStatus, extra?: { assigned_instance?: string | null; result_summary?: string | null }): TicketRecord {
		const now = nowIso();
		if (extra && (extra.assigned_instance !== undefined || extra.result_summary !== undefined)) {
			const current = this.getTicket(id);
			if (!current) throw new Error(`updateTicketStatus: no ticket "${id}"`);
			const assigned_instance = extra.assigned_instance !== undefined ? extra.assigned_instance : current.assigned_instance;
			const result_summary = extra.result_summary !== undefined ? extra.result_summary : current.result_summary;
			this.db.prepare("UPDATE tickets SET status = ?, assigned_instance = ?, result_summary = ?, updated_at = ? WHERE id = ?").run(status, assigned_instance, result_summary, now, id);
		} else {
			this.db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
		}
		const updated = this.getTicket(id);
		if (!updated) throw new Error(`updateTicketStatus: no ticket "${id}"`);
		return updated;
	}

	getTicketRecovery(id: string) {
		return this.db.prepare("SELECT * FROM ticket_recovery_state WHERE ticket_id = ?").get(id) as any ?? null;
	}

	requeueTicketForRecovery(id: string, input: { reason: string; max_retries: number; max_replans?: number }) {
		if (!input.reason.trim()) throw new Error("ticket_requeue: reason is required.");
		if (!Number.isInteger(input.max_retries) || input.max_retries < 1) throw new Error("ticket_requeue: max_retries must be a positive integer.");
		const ticket = this.getTicket(id);
		if (!ticket) throw new Error(`ticket_requeue: no ticket "${id}".`);
		if (ticket.status !== "failed") throw new Error(`ticket_requeue: "${id}" is ${ticket.status}; only failed tickets can be requeued.`);
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.getTicketRecovery(id) ?? { retry_count: 0, replan_round: 0, recovery_generation: 0, max_replans: input.max_replans ?? 3, status: "available" };
			const retries = Number(current.retry_count) + 1;
			const maxReplans = input.max_replans ?? Number(current.max_replans ?? 3);
			if (retries > input.max_retries || Number(current.replan_round ?? 0) >= maxReplans || current.status === "exhausted") {
				this.db.prepare("INSERT INTO ticket_recovery_state (ticket_id, run_id, retry_count, replan_round, max_retries, max_replans, recovery_generation, status, last_failure, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'exhausted', ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET retry_count=excluded.retry_count, max_retries=excluded.max_retries, max_replans=excluded.max_replans, status='exhausted', last_failure=excluded.last_failure, updated_at=excluded.updated_at").run(id, ticket.run_id, retries, Number(current.replan_round ?? 0), input.max_retries, maxReplans, Number(current.recovery_generation ?? 0), input.reason, now);
				this.db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'active'").run(now, ticket.run_id);
				this.db.prepare("INSERT INTO checkpoints (run_id, label, payload, created_at) VALUES (?, 'recovery_budget_exhausted', ?, ?)").run(ticket.run_id, JSON.stringify({ ticket_id: id, retry_count: retries, max_retries: input.max_retries, reason: input.reason }), now);
				this.recordEvent(ticket.run_id, "recovery_budget_exhausted", { ticket_id: id, retry_count: retries, max_retries: input.max_retries, reason: input.reason }, id);
				this.db.exec("COMMIT");
				throw new Error(`ticket_requeue: recovery budget exhausted for "${id}".`);
			}
			const generation = Number(current.recovery_generation ?? 0) + 1;
			this.db.prepare("INSERT INTO ticket_recovery_state (ticket_id, run_id, retry_count, replan_round, max_retries, max_replans, recovery_generation, status, last_failure, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET retry_count=excluded.retry_count, max_retries=excluded.max_retries, max_replans=excluded.max_replans, recovery_generation=excluded.recovery_generation, status='available', last_failure=excluded.last_failure, updated_at=excluded.updated_at").run(id, ticket.run_id, retries, Number(current.replan_round ?? 0), input.max_retries, maxReplans, generation, input.reason, now);
			this.db.prepare("UPDATE tickets SET status = 'pending', assigned_instance = NULL, result_summary = ?, updated_at = ? WHERE id = ? AND status = 'failed'").run(`requeued: ${input.reason}`, now, id);
			const updated = this.getTicket(id);
			this.recordEvent(ticket.run_id, "ticket_requeued", { ticket_id: id, recovery_generation: generation, retry_count: retries, reason: input.reason }, id);
			this.db.exec("COMMIT");
			return { ticket: updated, recovery: this.getTicketRecovery(id) };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	recordFinalizeEvidence(input: { run_id?: string | null; slug: string; kind: string; source: string; observed_value: string; commit_hash?: string | null; status: string; idempotency_key: string }) {
		if (!input.slug.trim() || !input.source.trim() || !input.observed_value.trim() || !input.idempotency_key.trim()) throw new Error("finalize_evidence: slug, source, observed_value and idempotency_key are required.");
		if (input.commit_hash) this.db.prepare("UPDATE finalize_evidence SET status = 'stale' WHERE slug = ? AND status = 'verified' AND commit_hash IS NOT NULL AND commit_hash <> ?").run(input.slug, input.commit_hash);
		this.db.prepare("INSERT OR IGNORE INTO finalize_evidence (run_id, slug, kind, source, observed_value, commit_hash, status, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.run_id ?? null, input.slug, input.kind, input.source, input.observed_value, input.commit_hash ?? null, input.status, input.idempotency_key, nowIso());
		return this.db.prepare("SELECT * FROM finalize_evidence WHERE slug = ? AND kind = ? AND idempotency_key = ?").get(input.slug, input.kind, input.idempotency_key);
	}

	listFinalizeEvidence(slug: string) {
		return this.db.prepare("SELECT * FROM finalize_evidence WHERE slug = ? ORDER BY id ASC").all(slug);
	}

	setRetentionPolicy(input: { project: string; event_days: number; evidence_days: number; outbox_days: number; dead_letter_days: number; policy_version: number }) {
		if (!input.project.trim() || !Number.isInteger(input.policy_version) || input.policy_version < 1 || [input.event_days, input.evidence_days, input.outbox_days, input.dead_letter_days].some((value) => !Number.isInteger(value) || value < 1)) throw new Error("retention_policy: project, positive day values and policy_version are required.");
		this.db.prepare("INSERT INTO retention_policies (project, event_days, evidence_days, outbox_days, dead_letter_days, policy_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET event_days=excluded.event_days, evidence_days=excluded.evidence_days, outbox_days=excluded.outbox_days, dead_letter_days=excluded.dead_letter_days, policy_version=excluded.policy_version, updated_at=excluded.updated_at").run(input.project, input.event_days, input.evidence_days, input.outbox_days, input.dead_letter_days, input.policy_version, nowIso());
		return this.db.prepare("SELECT * FROM retention_policies WHERE project = ?").get(input.project);
	}

	previewRetention(project: string) {
		const policy = this.db.prepare("SELECT * FROM retention_policies WHERE project = ?").get(project) as any;
		if (!policy) throw new Error(`retention_policy: no policy for project "${project}".`);
		const cutoffs = retentionCutoffs(policy);
		const events = this.db.prepare("SELECT COUNT(*) AS count FROM events e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND r.status <> 'active' AND e.created_at < ?").get(project, cutoffs.events) as any;
		const evidence = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_evidence e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.created_at < ?").get(project, cutoffs.evidence) as any;
		const outbox = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_effect_outbox e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.delivery_state IN ('delivered','failed') AND e.created_at < ?").get(project, cutoffs.outbox) as any;
		const pending = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_effect_outbox e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.delivery_state IN ('pending','leased')").get(project) as any;
		const deadLetter = this.db.prepare("SELECT COUNT(*) AS count FROM playbook_effect_outbox e JOIN runs r ON r.id = e.run_id WHERE r.project = ? AND e.delivery_state = 'dead_letter' AND e.created_at < ?").get(project, cutoffs.dead_letter) as any;
		return { policy, cutoffs, counts: { events: Number(events.count), evidence: Number(evidence.count), outbox: Number(outbox.count), pending_outbox: Number(pending.count), dead_letter: Number(deadLetter.count) }, destructive_apply_required: true };
	}

	applyRetention(project: string) {
		const preview = this.previewRetention(project) as any;
		const { cutoffs } = preview;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const events = this.db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE project = ? AND status <> 'active') AND created_at < ?").run(project, cutoffs.events);
			const evidence = this.db.prepare("DELETE FROM playbook_evidence WHERE run_id IN (SELECT id FROM runs WHERE project = ?) AND created_at < ?").run(project, cutoffs.evidence);
			const outbox = this.db.prepare("DELETE FROM playbook_effect_outbox WHERE run_id IN (SELECT id FROM runs WHERE project = ?) AND delivery_state IN ('delivered','failed') AND created_at < ?").run(project, cutoffs.outbox);
			const deadLetter = this.db.prepare("DELETE FROM playbook_effect_outbox WHERE run_id IN (SELECT id FROM runs WHERE project = ?) AND delivery_state = 'dead_letter' AND created_at < ?").run(project, cutoffs.dead_letter);
			const result = { project, cutoffs, deleted: { events: Number(events.changes), evidence: Number(evidence.changes), outbox: Number(outbox.changes), dead_letter: Number(deadLetter.changes) }, applied_at: nowIso() };
			this.db.exec("COMMIT");
			return result;
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	recordBenchmark(input: { project: string; name: string; dataset: string; metrics: Record<string, number>; thresholds: Record<string, number> }) {
		const keys = Object.keys(input.thresholds);
		const status = keys.every((key) => typeof input.metrics[key] === "number" && input.metrics[key] <= input.thresholds[key]) ? "passed" : "failed";
		this.db.prepare("INSERT INTO benchmark_runs (project, name, dataset, metrics, thresholds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.project, input.name, input.dataset, JSON.stringify(input.metrics), JSON.stringify(input.thresholds), status, nowIso());
		const row = this.db.prepare("SELECT * FROM benchmark_runs WHERE id = last_insert_rowid()").get() as any;
		return { ...row, metrics: JSON.parse(row.metrics), thresholds: JSON.parse(row.thresholds) };
	}

	createGovernanceProposal(input: { kind: string; identifier: string; document: string; required_capabilities?: string[] }) {
		if (!['playbook', 'role'].includes(input.kind) || !input.identifier.trim() || !input.document.trim()) throw new Error("governance_proposal: kind, identifier and document are required.");
		const checksum = crypto.createHash("sha256").update(input.document).digest("hex");
		this.db.prepare("INSERT OR IGNORE INTO governance_proposals (kind, identifier, document, checksum, required_capabilities, status, created_at) VALUES (?, ?, ?, ?, ?, 'sandbox', ?)").run(input.kind, input.identifier, input.document, checksum, JSON.stringify(input.required_capabilities ?? []), nowIso());
		return this.db.prepare("SELECT * FROM governance_proposals WHERE kind = ? AND identifier = ? AND checksum = ?").get(input.kind, input.identifier, checksum);
	}

	listGovernanceProposals(kind?: string) {
		const rows = (kind ? this.db.prepare("SELECT * FROM governance_proposals WHERE kind = ? ORDER BY id ASC").all(kind) : this.db.prepare("SELECT * FROM governance_proposals ORDER BY id ASC").all()) as any[];
		return rows.map((row) => ({ ...row, required_capabilities: JSON.parse(row.required_capabilities || "[]") }));
	}

	validateGovernanceProposal(id: number) {
		const result = this.db.prepare("UPDATE governance_proposals SET status = 'validated' WHERE id = ? AND status = 'sandbox'").run(id) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`governance_proposal: proposal "${id}" is not sandboxed.`);
		return this.db.prepare("SELECT * FROM governance_proposals WHERE id = ?").get(id);
	}

	approveGovernanceProposal(id: number) {
		const result = this.db.prepare("UPDATE governance_proposals SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'validated'").run(nowIso(), id) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`governance_proposal: proposal "${id}" must be validated before approval.`);
		return this.db.prepare("SELECT * FROM governance_proposals WHERE id = ?").get(id);
	}

	rejectGovernanceProposal(id: number, reason: string) {
		if (!reason.trim()) throw new Error("governance_proposal: rejection reason is required.");
		const result = this.db.prepare("UPDATE governance_proposals SET status = 'rejected' WHERE id = ? AND status IN ('sandbox','validated')").run(id) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`governance_proposal: proposal "${id}" cannot be rejected.`);
		return this.db.prepare("SELECT * FROM governance_proposals WHERE id = ?").get(id) as any;
	}

	auditPackageManifest() {
		const packagePath = path.resolve(process.cwd(), "package.json");
		const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
		const findings: string[] = [];
		if (pkg.name !== "yano-orchestrator") findings.push("package name is not yano-orchestrator");
		if (pkg.bin?.yano !== "./bin/yano.mjs") findings.push("public bin yano is missing");
		if (!Array.isArray(pkg.files) || !pkg.files.includes("playbooks")) findings.push("playbooks are not included in package files");
		const checksum = crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex");
		const status = findings.length ? "failed" : "passed";
		this.db.prepare("INSERT INTO package_manifest_audits (package_name, package_version, checksum, status, findings, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(pkg.name ?? "", pkg.version ?? "", checksum, status, JSON.stringify(findings), nowIso());
		return { package_name: pkg.name, package_version: pkg.version, checksum, status, findings };
	}

	addDependency(ticket_id: string, depends_on_id: string): void {
		if (ticket_id === depends_on_id) throw new Error(`addDependency: ticket "${ticket_id}" cannot depend on itself.`);
		this.db.prepare("INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_id) VALUES (?, ?)").run(ticket_id, depends_on_id);
	}

	listDependencies(run_id: string): DependencyRecord[] {
		return this.db
			.prepare("SELECT d.ticket_id, d.depends_on_id FROM ticket_dependencies d JOIN tickets t ON t.id = d.ticket_id WHERE t.run_id = ?")
			.all(run_id) as DependencyRecord[];
	}

	recordEvent(run_id: string, type: string, payload?: unknown, ticket_id?: string | null): EventRecord {
		const created_at = nowIso();
		const payloadJson = JSON.stringify(payload ?? {});
		const result = this.db.prepare("INSERT INTO events (run_id, ticket_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(run_id, ticket_id ?? null, type, payloadJson, created_at);
		return { id: Number(result.lastInsertRowid), run_id, ticket_id: ticket_id ?? null, type, payload: payload ?? {}, created_at };
	}

	listEvents(run_id: string, opts?: { since_id?: number; limit?: number }): EventRecord[] {
		const sinceId = opts?.since_id ?? 0;
		const limit = opts?.limit ?? 200;
		const rows = this.db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(run_id, sinceId, limit) as any[];
		return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || "{}") }));
	}

	createCheckpoint(run_id: string, label: string, payload?: unknown): void {
		this.db.prepare("INSERT INTO checkpoints (run_id, label, payload, created_at) VALUES (?, ?, ?, ?)").run(run_id, label, JSON.stringify(payload ?? {}), nowIso());
	}

	listCheckpoints(run_id: string) {
		const rows = this.db.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY id ASC").all(run_id) as any[];
		return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || "{}") }));
	}

	bindPlaybook(run_id: string, playbook: { id: string; schema_version: number; metadata: { origin: string; checksum: string }; snapshot: unknown }) {
		if (!this.getRun(run_id)) throw new Error(`playbook_bind: no run "${run_id}".`);
		const existing = this.getPlaybookBinding(run_id);
		if (existing) {
			if (existing.checksum !== playbook.metadata.checksum) throw new Error(`playbook_bind: run "${run_id}" is already bound to checksum ${existing.checksum}; refusing ${playbook.metadata.checksum}.`);
			return existing;
		}
		const record = { run_id, playbook_id: playbook.id, schema_version: playbook.schema_version, origin: playbook.metadata.origin, checksum: playbook.metadata.checksum, snapshot: playbook.snapshot, created_at: nowIso() };
		this.db.prepare("INSERT INTO playbook_bindings (run_id, playbook_id, schema_version, origin, checksum, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(record.run_id, record.playbook_id, record.schema_version, record.origin, record.checksum, JSON.stringify(record.snapshot), record.created_at);
		const initialState = (playbook.snapshot as any)?.states?.[0]?.id;
		if (initialState) this.db.prepare("INSERT INTO playbook_runtime_state (run_id, state_id, generation, updated_at) VALUES (?, ?, 0, ?)").run(run_id, initialState, record.created_at);
		return record;
	}

	getPlaybookBinding(run_id: string) {
		const row = this.db.prepare("SELECT * FROM playbook_bindings WHERE run_id = ?").get(run_id) as any;
		return row ? { ...row, schema_version: Number(row.schema_version), snapshot: JSON.parse(row.snapshot || "{}") } : null;
	}

	getPlaybookRuntimeState(run_id: string) {
		const row = this.db.prepare("SELECT * FROM playbook_runtime_state WHERE run_id = ?").get(run_id) as any;
		return row ? { ...row, generation: Number(row.generation) } : null;
	}

	recordPlaybookEvidence(run_id: string, input: { requirement: string; source: string; idempotency_key: string; cwd?: string }) {
		const run = this.getRun(run_id);
		if (!run) throw new Error(`playbook_evidence_record: no run "${run_id}".`);
		if (!this.getPlaybookBinding(run_id)) throw new Error(`playbook_evidence_record: run "${run_id}" has no bound Playbook.`);
		if (!input.requirement.trim() || !input.source.trim() || !input.idempotency_key.trim()) throw new Error("playbook_evidence_record: requirement, source and idempotency_key are required.");
		const sourceParts = input.source.split(":");
		if (input.source === "run:objective_present") {
			if (!run.objective.trim()) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 3 && sourceParts[0] === "ticket" && sourceParts[2] === "done") {
			const ticket = this.getTicket(sourceParts[1]);
			if (!ticket || ticket.run_id !== run_id || ticket.status !== "done") throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 3 && sourceParts[0] === "hold" && sourceParts[2] === "answered") {
			const hold = this.getDecisionHold(sourceParts[1]);
			if (!hold || hold.run_id !== run_id || hold.status !== "answered") throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "cli" && sourceParts[3] === "available") {
			if (!/^[A-Za-z0-9._-]+$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid CLI capability source "${input.source}".`);
			try { execFileSync(sourceParts[2], ["--version"], { stdio: "ignore", timeout: 5000 }); }
			catch { throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`); }
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "mcp" && sourceParts[3] === "handshake") {
			if (!/^[A-Za-z0-9._-]+$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid MCP capability source "${input.source}".`);
			const probeCwd = input.cwd ?? process.cwd();
			const configPath = [path.join(probeCwd, ".mcp.json"), path.join(probeCwd, ".pi", "mcp.json"), path.join(probeCwd, "mcp.json")].find((file) => fs.existsSync(file));
			let server: any;
			try {
				const config = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
				server = config?.mcpServers?.[sourceParts[2]];
			} catch { server = null; }
			if (!server || typeof server.command !== "string" || !Array.isArray(server.args) || server.args.some((arg: unknown) => typeof arg !== "string")) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
			const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "yano", version: MOA_EXTENSION_VERSION } } }) + "\n";
			try {
				const output = execFileSync(server.command, server.args, { cwd: probeCwd, input: request, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
				const initialized = output.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((message: any) => message?.id === 1 && message?.result?.protocolVersion && message?.result?.serverInfo);
				if (!initialized) throw new Error("invalid MCP initialize response");
			} catch { throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`); }
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "credential" && sourceParts[3] === "present") {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid credential capability source "${input.source}".`);
			const envPath = path.join(input.cwd ?? process.cwd(), ".env");
			let value: string | undefined;
			try {
				const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((candidate) => candidate.startsWith(`${sourceParts[2]}=`));
				value = line?.slice(sourceParts[2].length + 1).trim();
			} catch { value = undefined; }
			if (!value || /^<[^>]+>$/.test(value) || /^(YOUR_|REPLACE_|CHANGEME)/i.test(value)) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
		} else if (sourceParts.length === 4 && sourceParts[0] === "capability" && sourceParts[1] === "skill" && sourceParts[3] === "loadable") {
			if (!/^[A-Za-z0-9._-]+$/.test(sourceParts[2])) throw new Error(`playbook_evidence_record: invalid skill capability source "${input.source}".`);
			const roots = [
				path.join(input.cwd ?? process.cwd(), ".agents", "skills"),
				path.join(input.cwd ?? process.cwd(), ".codex", "skills"),
				...(process.env.HOME ? [path.join(process.env.HOME, ".agents", "skills"), path.join(process.env.HOME, ".codex", "skills")] : []),
			];
			const skillFile = roots.map((root) => path.join(root, sourceParts[2], "SKILL.md")).find((file) => fs.existsSync(file));
			if (!skillFile) throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`);
			try { if (fs.readFileSync(skillFile, "utf8").trim().length < 20) throw new Error("empty skill"); }
			catch { throw new Error(`playbook_evidence_record: source "${input.source}" is not satisfied.`); }
		} else {
			throw new Error(`playbook_evidence_record: unsupported source "${input.source}". Use run:objective_present, ticket:<id>:done, hold:<id>:answered, capability:cli:<name>:available, capability:mcp:<name>:handshake, capability:credential:<name>:present or capability:skill:<name>:loadable.`);
		}
		const created_at = nowIso();
		const insert = this.db.prepare("INSERT OR IGNORE INTO playbook_evidence (run_id, requirement, source, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)").run(run_id, input.requirement, input.source, input.idempotency_key, created_at) as any;
		const row = this.db.prepare("SELECT * FROM playbook_evidence WHERE run_id = ? AND requirement = ? AND idempotency_key = ?").get(run_id, input.requirement, input.idempotency_key) as any;
		return { ...row, created: Number(insert.changes ?? 0) > 0 };
	}

	listPlaybookEvidence(run_id: string) {
		return this.db.prepare("SELECT * FROM playbook_evidence WHERE run_id = ? ORDER BY id ASC").all(run_id);
	}

	upsertCapabilityCard(input: { run_id: string; role: string; instance: string; capability: string; source: string; scope: string; fingerprint: string; playbook_checksum: string; status: string; verified_at?: string | null; expires_at?: string | null; last_error?: string | null }) {
		if (!this.getRun(input.run_id)) throw new Error(`capability_card: no run "${input.run_id}".`);
		this.db.prepare("INSERT INTO playbook_capability_cards (run_id, role, instance, capability, source, scope, fingerprint, playbook_checksum, status, verified_at, expires_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, role, instance, capability) DO UPDATE SET source=excluded.source, scope=excluded.scope, fingerprint=excluded.fingerprint, playbook_checksum=excluded.playbook_checksum, status=excluded.status, verified_at=excluded.verified_at, expires_at=excluded.expires_at, last_error=excluded.last_error")
			.run(input.run_id, input.role, input.instance, input.capability, input.source, input.scope, input.fingerprint, input.playbook_checksum, input.status, input.verified_at ?? null, input.expires_at ?? null, input.last_error ?? null);
		return this.db.prepare("SELECT * FROM playbook_capability_cards WHERE run_id = ? AND role = ? AND instance = ? AND capability = ?").get(input.run_id, input.role, input.instance, input.capability);
	}

	listCapabilityCards(run_id: string) {
		return this.db.prepare("SELECT * FROM playbook_capability_cards WHERE run_id = ? ORDER BY id ASC").all(run_id);
	}

	invalidateCapabilityCard(run_id: string, role: string, instance: string, capability: string, reason: string) {
		const result = this.db.prepare("UPDATE playbook_capability_cards SET status = 'blocked', last_error = ? WHERE run_id = ? AND role = ? AND instance = ? AND capability = ?").run(reason, run_id, role, instance, capability) as any;
		if (Number(result.changes ?? 0) !== 1) throw new Error(`capability_card: no card for ${role}/${instance}/${capability}.`);
		return this.db.prepare("SELECT * FROM playbook_capability_cards WHERE run_id = ? AND role = ? AND instance = ? AND capability = ?").get(run_id, role, instance, capability);
	}

	transitionPlaybook(run_id: string, input: { transition_id: string; actor: string; expected_generation?: number }) {
		const binding = this.getPlaybookBinding(run_id);
		if (!binding) throw new Error(`playbook_transition: run "${run_id}" has no bound Playbook.`);
		const current = this.getPlaybookRuntimeState(run_id);
		if (!current) throw new Error(`playbook_transition: run "${run_id}" has no runtime state.`);
		const playbook = binding.snapshot as any;
		const transition = (playbook.transitions ?? []).find((candidate: any) => candidate.id === input.transition_id);
		if (!transition) throw new Error(`playbook_transition: unknown transition "${input.transition_id}".`);
		const from = Array.isArray(transition.from) ? transition.from : [transition.from];
		if (!from.includes(current.state_id)) throw new Error(`playbook_transition: transition "${input.transition_id}" cannot start from "${current.state_id}".`);
		if (transition.actor !== input.actor) throw new Error(`playbook_transition: actor "${input.actor}" is not authorised; expected "${transition.actor}".`);
		const evidence = new Set((this.listPlaybookEvidence(run_id) as any[]).map((row) => row.requirement));
		for (const requirement of transition.requires ?? []) if (!evidence.has(requirement)) throw new Error(`playbook_transition: guard "${requirement}" has no persisted evidence.`);
		if (input.expected_generation !== undefined && input.expected_generation !== current.generation) throw new Error(`playbook_transition: generation mismatch (expected ${current.generation}, received ${input.expected_generation}).`);
		const updated_at = nowIso();
		const generation = current.generation + 1;
		const effects = transition.effects ?? [];
		const approval_holds: string[] = [];
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const stateUpdate = this.db.prepare("UPDATE playbook_runtime_state SET state_id = ?, generation = ?, updated_at = ? WHERE run_id = ? AND generation = ?").run(transition.to, generation, updated_at, run_id, current.generation) as any;
			if (Number(stateUpdate.changes ?? 0) !== 1) throw new Error(`playbook_transition: concurrent state change detected for run "${run_id}"; refusing effects and audit.`);
			for (const effect of effects) {
				const payload = effect.payload ?? {};
				if (effect.kind === "human_approval") {
					const holdId = `playbook-${run_id}-${transition.id}-${generation}-${effect.id}`;
					this.db.prepare("INSERT OR IGNORE INTO decision_holds (id, run_id, ticket_id, generation, question, context, owner, playbook_checksum, status, answer, resolution_metadata, created_at, expires_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'open', NULL, '{}', ?, ?, ?)").run(holdId, run_id, generation, payload.question, JSON.stringify(payload), payload.owner ?? "user", binding.checksum, updated_at, payload.expires_at ?? null, updated_at);
					approval_holds.push(holdId);
					this.recordEvent(run_id, "decision_hold_created", { hold_id: holdId, generation, owner: payload.owner ?? "user", source: "playbook_effect", transition_id: transition.id });
				}
				this.db.prepare("INSERT OR IGNORE INTO playbook_effect_outbox (run_id, transition_id, generation, effect_id, kind, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(run_id, transition.id, generation, effect.id, effect.kind, JSON.stringify(payload), `playbook:${run_id}:${transition.id}:${generation}:${effect.id}`, updated_at);
			}
			this.recordEvent(run_id, "playbook_transition", { transition_id: transition.id, from: current.state_id, to: transition.to, actor: input.actor, generation });
			this.db.exec("COMMIT");
			return { run_id, from: current.state_id, to: transition.to, transition_id: transition.id, generation, updated_at, effects, approval_holds };
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	listPlaybookEffects(run_id: string, status?: string) {
		const rows = (status
			? this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE run_id = ? AND status = ? ORDER BY id ASC").all(run_id, status)
			: this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE run_id = ? ORDER BY id ASC").all(run_id)) as any[];
		return rows.map((row) => ({ ...row, generation: Number(row.generation), payload: JSON.parse(row.payload || "{}") }));
	}

	claimPlaybookEffect(id: number, input: { owner: string; token: string; lease_until: string }) {
		if (!input.owner.trim() || !input.token.trim() || !input.lease_until.trim()) throw new Error("playbook_effect_claim: owner, token and lease_until are required.");
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const effect = this.db.prepare("SELECT run_id FROM playbook_effect_outbox WHERE id = ?").get(id) as { run_id: string } | undefined;
			if (!effect) throw new Error(`playbook_effect_claim: no effect "${id}".`);
			const run = this.getRun(effect.run_id);
			const runtime = this.getPlaybookRuntimeState(effect.run_id);
			if (!run || run.status !== "active" || runtime?.state_id === "blocked") throw new Error(`playbook_effect_claim: dispatch is blocked for run "${effect.run_id}".`);
			const result = this.db.prepare("UPDATE playbook_effect_outbox SET delivery_state = 'leased', lease_owner = ?, lease_token = ?, lease_until = ? WHERE id = ? AND delivery_state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (lease_until IS NULL OR lease_until <= ?)").run(input.owner, input.token, input.lease_until, id, now, now) as any;
			if (Number(result.changes ?? 0) !== 1) throw new Error(`playbook_effect_claim: effect "${id}" is unavailable or already leased.`);
			const row = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			this.recordEvent(row.run_id, "playbook_effect_leased", { effect_id: id, owner: input.owner, lease_until: input.lease_until });
			this.db.exec("COMMIT");
			return { ...row, generation: Number(row.generation), payload: JSON.parse(row.payload || "{}") };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	failPlaybookEffect(id: number, input: { owner: string; token: string; error: string; max_attempts: number; next_attempt_at?: string }) {
		if (!input.owner.trim() || !input.token.trim() || !input.error.trim()) throw new Error("playbook_effect_fail: owner, token and error are required.");
		if (!Number.isInteger(input.max_attempts) || input.max_attempts < 1) throw new Error("playbook_effect_fail: max_attempts must be a positive integer.");
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`playbook_effect_fail: no effect "${id}".`);
			if (row.delivery_state !== "leased" || row.lease_owner !== input.owner || row.lease_token !== input.token || !row.lease_until || row.lease_until <= now) throw new Error(`playbook_effect_fail: lease fencing rejected for effect "${id}".`);
			const attempts = Number(row.attempts ?? 0) + 1;
			const dead = attempts >= input.max_attempts;
			this.db.prepare("UPDATE playbook_effect_outbox SET delivery_state = ?, attempts = ?, last_error = ?, next_attempt_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE id = ? AND delivery_state = 'leased' AND lease_owner = ? AND lease_token = ?").run(dead ? "dead_letter" : "failed", attempts, input.error, dead ? null : (input.next_attempt_at ?? now), id, input.owner, input.token);
			let outcome = "retry";
			if (dead) {
				const binding = this.getPlaybookBinding(row.run_id);
				const runtime = this.getPlaybookRuntimeState(row.run_id);
				const blockedState = (binding?.snapshot as any)?.states?.find((state: any) => state.id === "blocked");
				if (runtime && blockedState && runtime.state_id !== "blocked") {
					const nextGeneration = runtime.generation + 1;
					this.db.prepare("UPDATE playbook_runtime_state SET state_id = 'blocked', generation = ?, updated_at = ? WHERE run_id = ? AND generation = ?").run(nextGeneration, now, row.run_id, runtime.generation);
					outcome = "blocked";
				} else {
					this.db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'active'").run(now, row.run_id);
					outcome = "needs_replan";
				}
				this.createCheckpoint(row.run_id, "playbook_failure", { outcome, failure_class: "effect_dead_letter", effect_id: id, attempts, error: input.error, observed_at: now });
			}
			this.recordEvent(row.run_id, "playbook_effect_failed", { effect_id: id, attempts, dead_letter: dead, outcome, error: input.error });
			const updated = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			this.db.exec("COMMIT");
			return { ...updated, generation: Number(updated.generation), payload: JSON.parse(updated.payload || "{}"), outcome };
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	ackPlaybookEffect(id: number, input: { idempotency_key: string; generation: number; actor_role?: string }) {
		if (!input.idempotency_key.trim()) throw new Error("playbook_effect_ack: idempotency_key is required.");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`playbook_effect_ack: no effect "${id}".`);
			if ((row.kind === "mqtt_event" || row.kind === "notification") && input.actor_role !== "effect-adapter") throw new Error(`playbook_effect_ack: effect kind "${row.kind}" requires runtime role "effect-adapter".`);
			if (Number(row.generation) !== input.generation) throw new Error(`playbook_effect_ack: generation mismatch (expected ${row.generation}, received ${input.generation}).`);
			if (row.delivery_state === "dead_letter") throw new Error(`playbook_effect_ack: effect "${id}" is dead-lettered and requires replan.`);
			const prior = this.db.prepare("SELECT 1 FROM playbook_effect_operations WHERE effect_id = ? AND operation = 'ack' AND idempotency_key = ?").get(id, input.idempotency_key);
			if (prior) { this.db.exec("COMMIT"); return { ...row, payload: JSON.parse(row.payload || "{}"), generation: Number(row.generation) }; }
			if (row.status !== "pending") throw new Error(`playbook_effect_ack: effect "${id}" is already ${row.status}.`);
			if (row.kind === "human_approval") {
				const holdId = `playbook-${row.run_id}-${row.transition_id}-${row.generation}-${row.effect_id}`;
				const hold = this.db.prepare("SELECT status FROM decision_holds WHERE id = ?").get(holdId) as { status: string } | undefined;
				if (!hold) throw new Error(`playbook_effect_ack: approval effect "${id}" has no decision hold.`);
				if (hold.status !== "answered") throw new Error(`playbook_effect_ack: approval effect "${id}" requires hold "${holdId}" to be answered (current status: ${hold.status}).`);
			}
			const now = nowIso();
			this.db.prepare("INSERT INTO playbook_effect_operations (effect_id, operation, idempotency_key, created_at) VALUES (?, 'ack', ?, ?)").run(id, input.idempotency_key, now);
			this.db.prepare("UPDATE playbook_effect_outbox SET status = 'dispatched', delivery_state = 'delivered', dispatched_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE id = ? AND status = 'pending'").run(now, id);
			this.recordEvent(row.run_id, "playbook_effect_acknowledged", { effect_id: id, generation: input.generation, idempotency_key: input.idempotency_key, actor_role: input.actor_role ?? "unknown" });
			const updated = this.db.prepare("SELECT * FROM playbook_effect_outbox WHERE id = ?").get(id) as any;
			this.db.exec("COMMIT");
			return { ...updated, payload: JSON.parse(updated.payload || "{}"), generation: Number(updated.generation) };
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	private rowToDecisionHold(row: any): DecisionHoldRecord {
		return {
			...row,
			generation: Number(row.generation),
			context: JSON.parse(row.context || "{}"),
			resolution_metadata: JSON.parse(row.resolution_metadata || "{}"),
			status: row.status as DecisionHoldStatus,
		};
	}

	createDecisionHold(input: { id?: string; idempotency_key: string; run_id: string; ticket_id?: string | null; generation?: number; question: string; context?: unknown; owner: string; expires_at?: string | null }): DecisionHoldRecord {
		if (!input.idempotency_key.trim()) throw new Error("decision_hold_create: idempotency_key is required.");
		if (!this.getRun(input.run_id)) throw new Error(`decision_hold_create: no run "${input.run_id}".`);
		if (input.ticket_id) {
			const ticket = this.getTicket(input.ticket_id);
			if (!ticket) throw new Error(`decision_hold_create: no ticket "${input.ticket_id}".`);
			if (ticket.run_id !== input.run_id) throw new Error("decision_hold_create: ticket belongs to another run.");
		}
		const id = input.id || `hold-${crypto.createHash("sha256").update(`${input.run_id}:${input.idempotency_key}`).digest("hex").slice(0, 32)}`;
		const existing = this.getDecisionHold(id);
		if (existing) return existing;
		const now = nowIso();
		const rec: DecisionHoldRecord = {
			id, run_id: input.run_id, ticket_id: input.ticket_id ?? null, generation: input.generation ?? 0,
			question: input.question, context: input.context ?? {}, owner: input.owner, status: "open",
			answer: null, resolution_metadata: {}, created_at: now, expires_at: input.expires_at ?? null, updated_at: now,
		};
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("INSERT INTO decision_holds (id, run_id, ticket_id, generation, question, context, owner, status, answer, resolution_metadata, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(rec.id, rec.run_id, rec.ticket_id, rec.generation, rec.question, JSON.stringify(rec.context), rec.owner, rec.status, null, JSON.stringify(rec.resolution_metadata), rec.created_at, rec.expires_at, rec.updated_at);
			this.db.prepare("INSERT INTO decision_hold_operations (hold_id, operation, idempotency_key, created_at) VALUES (?, 'create', ?, ?)").run(rec.id, input.idempotency_key, now);
			this.db.exec("COMMIT");
			return rec;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			const retry = this.getDecisionHold(id);
			if (retry) return retry;
			throw error;
		}
	}

	getDecisionHold(id: string): DecisionHoldRecord | null {
		const row = this.db.prepare("SELECT * FROM decision_holds WHERE id = ?").get(id) as any;
		return row ? this.rowToDecisionHold(row) : null;
	}

	listDecisionHolds(run_id: string, status?: DecisionHoldStatus): DecisionHoldRecord[] {
		const rows = (status
			? this.db.prepare("SELECT * FROM decision_holds WHERE run_id = ? AND status = ? ORDER BY created_at ASC").all(run_id, status)
			: this.db.prepare("SELECT * FROM decision_holds WHERE run_id = ? ORDER BY created_at ASC").all(run_id)) as any[];
		return rows.map((row) => this.rowToDecisionHold(row));
	}

	private resolveDecisionHold(id: string, input: { generation: number; idempotency_key: string; status: "answered" | "cancelled"; answer?: string | null; resolution_metadata?: unknown; expected_checksum?: string; principal?: string }): DecisionHoldRecord {
		if (!input.idempotency_key.trim()) throw new Error("decision hold resolution: idempotency_key is required.");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM decision_holds WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`decision hold: no hold "${id}".`);
			const prior = this.db.prepare("SELECT 1 FROM decision_hold_operations WHERE hold_id = ? AND operation = ? AND idempotency_key = ?").get(id, input.status, input.idempotency_key);
			if (prior) { this.db.exec("COMMIT"); return this.rowToDecisionHold(row); }
			if (Number(row.generation) !== input.generation) throw new Error(`decision hold "${id}": generation mismatch (expected ${row.generation}, received ${input.generation}).`);
			if (input.expected_checksum && row.playbook_checksum !== input.expected_checksum) throw new Error(`decision hold "${id}": Playbook checksum mismatch.`);
			if (row.playbook_checksum && input.principal && row.owner !== input.principal && row.escalated_to !== input.principal) throw new Error(`decision hold "${id}": principal is not authorised.`);
			if (row.status !== "open") throw new Error(`decision hold "${id}" is already ${row.status}.`);
			const now = nowIso();
			const metadata = input.resolution_metadata ?? (input.status === "cancelled" ? { reason: input.answer } : {});
			this.db.prepare("INSERT INTO decision_hold_operations (hold_id, operation, idempotency_key, created_at) VALUES (?, ?, ?, ?)").run(id, input.status, input.idempotency_key, now);
			this.db.prepare("UPDATE decision_holds SET status = ?, answer = ?, resolution_metadata = ?, updated_at = ? WHERE id = ?").run(input.status, input.answer ?? null, JSON.stringify(metadata), now, id);
			if (input.status === "answered") {
				const needsReplan = typeof metadata === "object" && metadata !== null && (metadata as any).needs_replan === false ? false : true;
				this.db.prepare("INSERT OR IGNORE INTO decision_hold_outbox (run_id, hold_id, dedupe_key, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(row.run_id, id, `decision-hold-resume:${id}:${input.generation}:${input.idempotency_key}`, JSON.stringify({ hold_id: id, generation: input.generation, needs_replan: needsReplan }), now);
			}
			const updated = this.getDecisionHold(id);
			if (!updated) throw new Error(`decision hold: hold "${id}" disappeared during resolution.`);
			this.db.exec("COMMIT");
			return updated;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	answerDecisionHold(id: string, input: { generation: number; idempotency_key: string; answer: string; resolution_metadata?: unknown; expected_checksum?: string; principal?: string }): DecisionHoldRecord {
		return this.resolveDecisionHold(id, { ...input, status: "answered", answer: input.answer });
	}

	cancelDecisionHold(id: string, input: { generation: number; idempotency_key: string; reason?: string; expected_checksum?: string; principal?: string }): DecisionHoldRecord {
		return this.resolveDecisionHold(id, { ...input, status: "cancelled", answer: null, resolution_metadata: { reason: input.reason ?? "cancelled" } });
	}

	escalateDecisionHold(id: string, input: { generation: number; idempotency_key: string; escalated_to: string; expected_checksum?: string }): DecisionHoldRecord {
		if (!input.escalated_to.trim() || !input.idempotency_key.trim()) throw new Error("decision hold escalation: escalated_to and idempotency_key are required.");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM decision_holds WHERE id = ?").get(id) as any;
			if (!row) throw new Error(`decision hold: no hold "${id}".`);
			const prior = this.db.prepare("SELECT 1 FROM decision_hold_operations WHERE hold_id = ? AND operation = 'escalate' AND idempotency_key = ?").get(id, input.idempotency_key);
			if (prior) { this.db.exec("COMMIT"); return this.rowToDecisionHold(row); }
			if (Number(row.generation) !== input.generation) throw new Error(`decision hold "${id}": generation mismatch (expected ${row.generation}, received ${input.generation}).`);
			if (input.expected_checksum && row.playbook_checksum !== input.expected_checksum) throw new Error(`decision hold "${id}": Playbook checksum mismatch.`);
			if (row.status !== "open") throw new Error(`decision hold "${id}" is already ${row.status}.`);
			const now = nowIso();
			this.db.prepare("INSERT INTO decision_hold_operations (hold_id, operation, idempotency_key, created_at) VALUES (?, 'escalate', ?, ?)").run(id, input.idempotency_key, now);
			this.db.prepare("UPDATE decision_holds SET escalated_to = ?, escalation_version = escalation_version + 1, updated_at = ? WHERE id = ? AND status = 'open'").run(input.escalated_to, now, id);
			const updated = this.getDecisionHold(id);
			if (!updated) throw new Error(`decision hold: hold "${id}" disappeared during escalation.`);
			this.db.exec("COMMIT");
			return updated;
		} catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
	}

	expireDecisionHolds(now: string): DecisionHoldRecord[] {
		const rows = this.db.prepare("SELECT * FROM decision_holds WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as any[];
		if (!rows.length) return [];
		this.db.prepare("UPDATE decision_holds SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?").run(now, now);
		return rows.map((row) => this.rowToDecisionHold({ ...row, status: "expired", updated_at: now }));
	}

	drainDecisionHoldOutbox(): Array<{ id: number; run_id: string; hold_id: string; payload: unknown }> {
		const rows = this.db.prepare("SELECT * FROM decision_hold_outbox WHERE status = 'pending' ORDER BY id ASC").all() as any[];
		if (!rows.length) return [];
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const row of rows) this.db.prepare("UPDATE decision_hold_outbox SET status = 'dispatched', dispatched_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
			this.db.exec("COMMIT");
			return rows.map((row) => ({ id: Number(row.id), run_id: row.run_id, hold_id: row.hold_id, payload: JSON.parse(row.payload || "{}") }));
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
			throw error;
		}
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// best-effort
		}
	}
}

// ━━ Deterministic scheduler: READY/BLOCKED + execution waves ━━━━━━━━━━━━━━
//
// Pure functions over plain data (TicketRecord[]/DependencyRecord[]) — no
// SQL, no LLM reasoning, matching architecture.md's principle that
// everything past the Task Architect/spec-and-ticket authoring step is
// deterministic code (§1, §9-11). "Ready"/"blocked" are always COMPUTED,
// never stored as a ticket status, so there is exactly one place ticket
// state can drift from reality.

function moaComputeReadyBlocked(
	tickets: TicketRecord[],
	deps: DependencyRecord[],
): { ready: string[]; blocked: string[]; running: string[]; done: string[]; failed: string[]; cancelled: string[] } {
	const byId = new Map(tickets.map((t) => [t.id, t]));
	const depsByTicket = new Map<string, string[]>();
	for (const d of deps) {
		if (!depsByTicket.has(d.ticket_id)) depsByTicket.set(d.ticket_id, []);
		depsByTicket.get(d.ticket_id)!.push(d.depends_on_id);
	}
	const ready: string[] = [];
	const blocked: string[] = [];
	const running: string[] = [];
	const done: string[] = [];
	const failed: string[] = [];
	const cancelled: string[] = [];
	for (const t of tickets) {
		if (t.status === "done") { done.push(t.id); continue; }
		if (t.status === "failed") { failed.push(t.id); continue; }
		if (t.status === "cancelled") { cancelled.push(t.id); continue; }
		if (t.status === "running") { running.push(t.id); continue; }
		const myDeps = depsByTicket.get(t.id) || [];
		const allDepsDone = myDeps.every((depId) => byId.get(depId)?.status === "done");
		if (allDepsDone) ready.push(t.id);
		else blocked.push(t.id);
	}
	return { ready, blocked, running, done, failed, cancelled };
}

// Groups still-to-schedule tickets (pending or running) into waves: wave N
// contains every ticket whose remaining (not-yet-done) dependencies are all
// in wave < N. Throws on a dependency cycle — same "reject cycles" contract
// architecture.md §20/§0 requires of the DAG validator, applied here to
// whatever subgraph is still outstanding.
function moaComputeExecutionWaves(tickets: TicketRecord[], deps: DependencyRecord[]): string[][] {
	const outstanding = tickets.filter((t) => t.status === "pending" || t.status === "running");
	const outstandingIds = new Set(outstanding.map((t) => t.id));
	const doneIds = new Set(tickets.filter((t) => t.status === "done").map((t) => t.id));
	const depsByTicket = new Map<string, Set<string>>();
	for (const t of outstanding) depsByTicket.set(t.id, new Set());
	for (const d of deps) {
		if (!outstandingIds.has(d.ticket_id) || doneIds.has(d.depends_on_id)) continue;
		depsByTicket.get(d.ticket_id)?.add(d.depends_on_id);
	}
	const waves: string[][] = [];
	let remaining = new Set(outstandingIds);
	while (remaining.size > 0) {
		const wave: string[] = [];
		for (const id of remaining) {
			const myDeps = depsByTicket.get(id)!;
			let blocked = false;
			for (const d of myDeps) {
				if (remaining.has(d)) { blocked = true; break; }
			}
			if (!blocked) wave.push(id);
		}
		if (wave.length === 0) {
			throw new Error(`moaComputeExecutionWaves: dependency cycle detected among tickets: ${[...remaining].sort().join(", ")}`);
		}
		wave.sort();
		waves.push(wave);
		for (const id of wave) remaining.delete(id);
	}
	return waves;
}

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

function moaFindStalledTickets(storage: OrchestratorStorage, project: string, nowMs: number, stallMs: number): StalledTicketInfo[] {
	const stalled: StalledTicketInfo[] = [];
	const runs = storage.listRuns(project).filter((r) => r.status === "active");
	for (const run of runs) {
		for (const t of storage.listTickets(run.id)) {
			if (t.status !== "running") continue;
			const elapsed = nowMs - Date.parse(t.updated_at);
			if (elapsed >= stallMs) {
				stalled.push({ run_id: run.id, ticket_id: t.id, title: t.title, assigned_instance: t.assigned_instance, running_since: t.updated_at, elapsed_ms: elapsed });
			}
		}
	}
	return stalled;
}

// ━━ Watchdog: detect runs stuck "completed" with no finalize/notify follow-up
// (Revisione 40) ━━ See WATCHDOG_FINALIZE_GRACE_MS above for why this exists
// and why it's a separate check from moaFindStalledTickets: ticket_complete's
// own allDone branch already flips a run to "completed" the instant every one
// of its tickets reaches "done" — at that point there is, by definition,
// nothing left "running" for moaFindStalledTickets to notice, even though the
// operator-facing half of the job (merge the worktree, send the completion
// notification) may never have happened. Pure/deterministic given `nowMs`,
// same testability discipline as moaFindStalledTickets — see
// scripts/smoke-test-watchdog.mjs.
interface UnfinalizedRunInfo {
	run_id: string;
	objective: string;
	completed_at: string;
	elapsed_ms: number;
}

function moaFindUnfinalizedRuns(storage: OrchestratorStorage, project: string, nowMs: number, graceMs: number): UnfinalizedRunInfo[] {
	const found: UnfinalizedRunInfo[] = [];
	for (const run of storage.listRuns(project)) {
		if (run.status !== "completed") continue;
		const elapsed = nowMs - Date.parse(run.updated_at);
		if (elapsed >= graceMs) {
			found.push({ run_id: run.id, objective: run.objective, completed_at: run.updated_at, elapsed_ms: elapsed });
		}
	}
	return found;
}

// ━━ Watchdog: detect tickets whose assigned instance is confirmably GONE
// (Revisione 42) ━━ See the WATCHDOG_AUTO_TERMINATE_* comment above for the
// real incident this covers. Pure/deterministic given a presence snapshot
// (never reads the live module-level `presence` Map directly, never calls
// Date.now()) so it stays unit-testable the same way as
// moaFindStalledTickets/moaFindUnfinalizedRuns — see
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

function moaFindOrphanedTickets(
	storage: OrchestratorStorage,
	project: string,
	presenceSnapshot: Map<string, { status: PresenceStatus }>,
): OrphanedTicketInfo[] {
	const orphaned: OrphanedTicketInfo[] = [];
	const runs = storage.listRuns(project).filter((r) => r.status === "active");
	for (const run of runs) {
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

function moaReconcilePersistedState(storage: OrchestratorStorage, project: string, presenceSnapshot: Map<string, { status: PresenceStatus }>): number {
	let count = 0;
	for (const run of storage.listRuns(project).filter((candidate) => candidate.status === "active")) {
		const dangling = moaFindOrphanedTickets(storage, project, presenceSnapshot).filter((ticket) => ticket.run_id === run.id);
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
		description: "Agent instance id (must match a key in agents/agents.yaml, e.g. coder-01). Required.",
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
			"also passed — see that flag). Defaults to .pi/extensions/multiAgentOrchestrator/prompts, the same place " +
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
			"<project>/.pi/extensions/multiAgentOrchestrator/prompts). Missing a specific <role>.md there — or the " +
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
	let client: MqttClient | null = null;
	let T: ReturnType<typeof topics> | null = null;
	const presence = new Map<string, PresenceCard>();
	const pendingReplies = new Map<string, PendingReply>();
	const inboundQueue = new Map<string, InboundContext>();
	const seenAssignments = new Map<string, number>(); // assignment_id -> seenAt, QoS1 redelivery dedupe
	const activityLog: ActivityEvent[] = [];
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let staleSweepTimer: NodeJS.Timeout | null = null;
	let watchdogTimer: NodeJS.Timeout | null = null;
	// ticket_id::running_since -> highest "how many WATCHDOG_STALL_MS multiples
	// have we already alerted for THIS running episode" — keyed on running_since
	// (not just ticket_id) so a fresh ticket_claim after a reassignment starts a
	// new episode and re-arms alerting instead of staying silently suppressed.
	const watchdogAlertLevel = new Map<string, number>();
	// run_id set already alerted for "completed but never finalized" (Revisione
	// 40) — fired at most once per run, same discipline as watchdogAlertLevel
	// above (an operator reading a heuristic "verifica manualmente" WhatsApp
	// every sweep for the same already-known situation is noise, not signal).
	const watchdogRunAlerted = new Set<string>();
	// Revisione 42 — same "alert once per running episode" discipline as
	// watchdogAlertLevel above, for the two new checks: orphaned tickets
	// (instance confirmably gone — moaFindOrphanedTickets) and, opt-in,
	// hard-stuck-but-still-connected tickets (WATCHDOG_AUTO_TERMINATE_*).
	// Keyed the same way (ticket_id::running_since) so a fresh ticket_claim
	// after reassignment starts a new episode and re-arms both.
	const watchdogOrphanAlerted = new Set<string>();
	const watchdogAutoTerminated = new Set<string>();
	// Tickets this instance currently holds "running" (ticket_claim..ticket_complete),
	// tracked here because agent_send's own inboundQueue (below) is a DIFFERENT
	// completion signal — an instance can be deep into real ticket work with a
	// long-since-fulfilled (or never-held) inbound entry, which is exactly the
	// mismatch an operator caught in production: docs-sync-02 showed "idle" in
	// the MQTT presence widget while its own pane was actively editing files for
	// minutes (Revisione 40, docs/development-notes.md). Presence "busy" now
	// reflects EITHER signal, not just inboundQueue.
	const activeTicketIds = new Set<string>();
	function computeSelfStatus(): PresenceStatus {
		return inboundQueue.size > 0 || activeTicketIds.size > 0 ? "busy" : "idle";
	}
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	let mqttConnected = false;
	let everConnected = false; // distinguishes "connecting…" (first attempt) from "reconnecting…" (dropped after being up) in the widget

	function pushActivity(ev: ActivityEvent) {
		activityLog.push(ev);
		if (activityLog.length > ACTIVITY_LOG_CAP) activityLog.shift();
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
			const line = `${JSON.stringify({ ts: nowIso(), seq: ++logSeq, instance: identity.instance, role: identity.role, project: identity.project, trace_mode: config.mode, type, ...redactRuntimeProjection(data) })}\n`;
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
			const line = `${JSON.stringify({ ts: nowIso(), seq: ++logSeq, instance: identity.instance, role: identity.role, project: identity.project, trace_mode: config.mode, type, ...redactRuntimeProjection(data) })}\n`;
			fs.appendFileSync(paths.instanceLog!, line, { mode: 0o600 });
		} catch {
			// best-effort
		}
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
			current_load: inboundQueue.size,
			capacity: identity.capacity,
			self: true,
		};
		const others = [...presence.values()].map((c) => ({
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

	function scheduleEviction(assignment_id: string): void {
		// Keep a resolved/timed-out entry around briefly so a slow agent_get
		// still sees the final result, then free it — otherwise pendingReplies
		// grows unbounded over a long-running session for sends nobody polls.
		const t = setTimeout(() => { pendingReplies.delete(assignment_id); }, 5 * 60_000);
		try { (t as any).unref?.(); } catch { /* ignore */ }
	}

	async function publishPresence(status: PresenceStatus) {
		if (!identity || !client || !T) return;
		const card: PresenceCard = {
			instance: identity.instance,
			role: identity.role,
			project: identity.project,
			team: identity.team,
			model: identity.model,
			skills: [],
			tools: [],
			mcp: [],
			status,
			capacity: identity.capacity,
			current_load: inboundQueue.size,
			color: identity.color,
			started_at: nowIso(),
			last_heartbeat: nowIso(),
		};
		try {
			await client.publishAsync(T.agentStatus(identity.instance), JSON.stringify(card), { qos: 1, retain: true });
		} catch {
			// best-effort — presence is advisory, never fatal to the agent turn
		}
	}

	function handleCommand(env: CommandEnvelope) {
		if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
			pushActivity({ channel: "self", from: env.sender_instance, summary: `dropped: hop limit exceeded`, timestamp: nowIso() });
			return;
		}
		if (!rememberAssignment(env.assignment_id)) return; // duplicate QoS1 delivery

		const inbound: InboundContext = {
			assignment_id: env.assignment_id,
			hops: env.hops,
			reply_to: env.reply_to,
			sender_instance: env.sender_instance,
			response_schema: env.response_schema ?? null,
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
			if (identity && card.instance === identity.instance) return;
			presence.set(card.instance, card);
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
				// No claim/first-wins arbitration at this stage — see docs/development-notes.md.
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
			ctx.ui?.notify?.("orchestrator: --instance is required (e.g. --instance coder-01)", "error");
			return;
		}

		// Revisione 30: a real incident traced back to an instance launched with
		// its cwd already INSIDE a task worktree (".../.worktrees/<slug>/")
		// instead of the project root. Every path this extension computes
		// (worktreePaths, moaWorkspaceDir → the SQLite orchestrator.db,
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
					"sulla root del progetto (herdr/tmux: flag `-c <root-progetto>`).",
				"error",
			);
			return;
		}

		const cfg = loadConfig(cwd, flags.configDir || "agents");
		const resolved = resolveCapabilities(flags.instance, cfg, flags.role);
		const role = flags.role || resolved.role;
		const project = flags.project || resolveDefaultProject(cwd);
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
		T = topics(project);

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
		paseoDetectAndLog();

		const brokerUrl = flags.brokerUrl || DEFAULT_BROKER_URL;
		logEvent("session_start", { project, team: resolved.teams, broker: brokerUrl });

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
					payload: JSON.stringify({ instance: identity.instance, role, project, status: "offline", last_heartbeat: nowIso() }),
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
					const env = JSON.parse(payload.toString("utf-8")) as CommandEnvelope | TerminateEnvelope;
					if (env.type === "command") handleCommand(env);
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
					await client.subscribeAsync(T.agentStatusWildcard(), { qos: 0 });
					await client.subscribeAsync(T.roleTasks(role), { qos: 1 });
					for (const team of identity.team) {
						await client.subscribeAsync(T.teamEvents(team), { qos: 0 });
					}
					mqttConnected = true;
					everConnected = true;
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
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!identity) return;
		const flags = readCliFlags(pi);
		const cfg = loadConfig(identity.cwd, flags.configDir || "agents");
		const roleCfg = cfg.roles[identity.role];
		// Revisione 47: per default i prompt vengono SEMPRE letti dalla cartella
		// prompts/ del pacchetto installato (resolveGlobalPromptsDir(), risolta
		// dalla posizione reale di QUESTO file, mai da un percorso ipotizzato) —
		// mai da una copia locale del progetto, che prima (Revisione 37-46)
		// restava silenziosamente indietro ad ogni `yano update`. Solo
		// --custom-prompts fa eccezione: guarda PRIMA nella cartella locale del
		// progetto (--prompts-dir, default .pi/extensions/multiAgentOrchestrator/prompts,
		// creata da `yano copy-prompts`), poi ricade sul pacchetto installato per
		// qualunque file quella cartella non abbia — file per file, non tutto o
		// niente: personalizzare un solo ruolo non fa "congelare" gli altri.
		const globalPromptsDir = resolveGlobalPromptsDir();
		const localPromptsDirRaw = flags.promptsDir || path.join(".pi", "extensions", "multiAgentOrchestrator", "prompts");
		const localPromptsDir = path.isAbsolute(localPromptsDirRaw) ? localPromptsDirRaw : path.join(identity.cwd, localPromptsDirRaw);
		const primaryDir = flags.customPrompts ? localPromptsDir : globalPromptsDir;
		const fallbackDir = flags.customPrompts ? globalPromptsDir : null;
		const template = loadRolePrompt(primaryDir, fallbackDir, identity.role, roleCfg);
		logEvent("role_prompt_resolved", {
			custom_prompts: !!flags.customPrompts,
			primary_dir: primaryDir,
			fallback_dir: fallbackDir,
		});
		const systemPrompt = template
			.replaceAll("{{INSTANCE}}", identity.instance)
			.replaceAll("{{ROLE}}", identity.role)
			.replaceAll("{{ROLE_LABEL}}", roleCfg?.label || identity.role)
			.replaceAll("{{BRIEF}}", roleCfg?.brief || "")
			.replaceAll("{{CAPABILITIES}}", roleCapabilitiesPrompt(roleCfg))
			.replaceAll("{{PROJECT}}", identity.project)
			.replaceAll("{{TEAM}}", identity.team.join(", "));
		herdrReportAgent(identity.displayName, "working", identity.instance);
		// had_pending_inbound:false qui è il segnale diagnostico chiave per "un
		// agente è partito da solo": significa che questo turno sta iniziando
		// SENZA nessun comando in coda mai ricevuto via MQTT — vedi
		// scripts/review-log.mjs, che lo segnala esplicitamente.
		logEvent("turn_start", { had_pending_inbound: [...inboundQueue.values()].some((i) => !i.fulfilled) });
		return { systemPrompt };
	});

	// Pi exposes these lifecycle hooks in the live harness. They are kept
	// best-effort so older Pi builds can still load the extension; when present
	// they provide the tool inventory needed by `yano trace --mode full`.
	pi.on("tool_execution_start", async (event: any) => {
		logEvent("tool_execution_start", {
			tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null,
			tool: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
		});
		tracePayload("tool_execution_start_payload", { tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null, args: event?.args ?? null }, "standard");
	});
	pi.on("tool_execution_end", async (event: any) => {
		logEvent("tool_execution_end", {
			tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null,
			tool: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
			ok: event?.isError === true ? false : event?.error ? false : true,
		});
		tracePayload("tool_execution_end_payload", { tool_call_id: event?.toolCallId ?? event?.tool_call_id ?? null, error: event?.error ?? null, result: event?.result ?? event?.output ?? null }, "standard");
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

		const rows = mqttConnected
			? [...presence.values()].map((c) => {
				const dotColor = c.status === "idle" ? "success" : c.status === "busy" ? "warning" : "error";
				const modelPart = c.model ? theme.fg("dim", ` · ${c.model}`) : "";
				const line = theme.fg(dotColor, "●") + " " + theme.fg("accent", `${c.instance} `) + theme.fg("dim", `(${c.role})`) + modelPart + " " + theme.fg("muted", c.status);
				return truncateToWidth(line, w);
			})
			: [];
		if (mqttConnected && rows.length === 0) {
			rows.push(truncateToWidth(theme.fg("dim", "  (nessun altro agente online per ora)"), w));
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

	// ━━ MultiAgentOrchestrator storage handle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Opened lazily (first tool call that needs it, or an explicit
	// orchestrator_init) rather than at session_start, so every role that
	// never touches the ticket layer never pays for it. One open handle per
	// process, closed on shutdown alongside the MQTT client.
	let moaStorage: OrchestratorStorage | null = null;
	function ensureMoaStorage(): OrchestratorStorage {
		if (!identity) throw new Error("orchestrator not initialised");
		if (moaStorage) return moaStorage;
		moaEnsureWorkspace(identity.cwd, identity.project);
		const dbPath = path.join(moaSubdirs(moaWorkspaceDir(identity.cwd)).orchestratorStorage, "orchestrator.db");
		const storage = new SQLiteOrchestratorStorage(dbPath);
		storage.init();
		moaStorage = storage;
		return storage;
	}
	// Best-effort MQTT signal on top of the SQLite write that already
	// happened — SQLite is the source of truth (already durable by the time
	// this is called), MQTT is just "something happened" visibility, so a
	// lost/failed publish here is never allowed to fail the tool call.
	async function moaPublishEvent(runId: string, type: string, payload: unknown): Promise<void> {
		try {
			if (client && T) await client.publishAsync(T.runEvents(runId), JSON.stringify({ type, run_id: runId, payload, timestamp: nowIso() }), { qos: 0 });
		} catch {
			// best-effort
		}
	}

	// Planner-only (a coder/specialist instance can't act on a stalled ticket
	// anyway — reassignment/escalation is a planning decision). No-op for every
	// other role and a no-op until the workspace/DB actually exists (moaStorage
	// null before the first orchestrator_init/run_create) — the timer below
	// runs unconditionally from session_start, this function is what makes it
	// harmless before there's anything to watch. Never throws: every side
	// effect here (SQLite event, MQTT publish, WhatsApp, waking the planner's
	// own turn) is independently best-effort, same discipline as the rest of
	// this file — a watchdog that can itself crash the planner defeats its
	// purpose.
	async function watchdogSweep(nowMs: number): Promise<StalledTicketInfo[]> {
		if (!identity || identity.role !== "planner" || !moaStorage) return [];
		try {
			const expired = moaStorage.expireDecisionHolds(new Date(nowMs).toISOString());
			for (const hold of expired) {
				moaStorage.recordEvent(hold.run_id, "decision_hold_expired", { hold_id: hold.id, generation: hold.generation, expires_at: hold.expires_at }, hold.ticket_id);
				void moaPublishEvent(hold.run_id, "decision_hold_expired", { hold_id: hold.id, generation: hold.generation });
				logEvent("decision_hold_expired", { run_id: hold.run_id, hold_id: hold.id, ticket_id: hold.ticket_id });
			}
		} catch {
			// Hold expiry is best-effort within the watchdog; a storage failure must
			// not suppress the independent stalled-ticket sweep below.
		}
		try {
			for (const item of moaStorage.drainDecisionHoldOutbox()) {
				const payload = item.payload as { hold_id?: string; generation?: number; needs_replan?: boolean };
				const message = `[decision-hold-resume] hold ${payload.hold_id ?? item.hold_id} answered (generation ${payload.generation ?? "?"}). ` +
					(payload.needs_replan ? "Replan is required before dispatch." : "Resume the current plan from persisted state.");
				void moaPublishEvent(item.run_id, "decision_hold_resume_requested", { ...payload, outbox_id: item.id });
				try {
					pi.sendMessage({ customType: "decision-hold-resume", content: message, display: true, details: { run_id: item.run_id, ...payload, outbox_id: item.id } }, { deliverAs: "followUp", triggerTurn: true });
				} catch {
					logEvent("decision_hold_resume_delivery_failed", { run_id: item.run_id, hold_id: item.hold_id, outbox_id: item.id });
				}
			}
		} catch {
			// Keep the ticket watchdog alive if outbox delivery encounters a DB or
			// transport failure; the durable answer/audit state remains intact.
		}
		let stalled: StalledTicketInfo[];
		try {
			stalled = moaFindStalledTickets(moaStorage, identity.project, nowMs, WATCHDOG_STALL_MS);
		} catch {
			return [];
		}
		for (const s of stalled) {
			const episodeKey = `${s.ticket_id}::${s.running_since}`;
			const thresholdLevel = Math.floor(s.elapsed_ms / WATCHDOG_STALL_MS); // 1 at first stall, 2 after another full stall period unresolved, ...
			const lastLevel = watchdogAlertLevel.get(episodeKey) ?? 0;
			if (thresholdLevel <= lastLevel) continue; // already alerted at this severity for this running episode
			watchdogAlertLevel.set(episodeKey, thresholdLevel);

			const minutes = Math.round(s.elapsed_ms / 60_000);
			try {
				moaStorage.recordEvent(s.run_id, "ticket_stalled", { ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms }, s.ticket_id);
			} catch {
				// best-effort — never let a logging failure hide a real stall from the other channels below
			}
			void moaPublishEvent(s.run_id, "ticket_stalled", { ticket_id: s.ticket_id, title: s.title, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms });
			logEvent("watchdog_stall_detected", { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms, threshold_level: thresholdLevel });

			const waMessage =
				`⚠️ watchdog: il ticket "${s.title}" (${s.ticket_id}), assegnato a ${s.assigned_instance ?? "?"}, è RUNNING da ${minutes} min ` +
				`senza un ticket_complete — probabile blocco dell'istanza (turno bloccato o troncato). Il planner è stato informato, nessuna azione automatica presa.`;
			void sendWhatsAppNotification(waMessage).then((r) => logEvent("whatsapp_notify", { ok: r.ok, detail: r.detail, reason: "watchdog_stall", ticket_id: s.ticket_id }));

			try {
				pi.sendMessage(
					{
						customType: "orchestrator-watchdog",
						content:
							`[watchdog] Il ticket "${s.title}" (${s.ticket_id}), assegnato a ${s.assigned_instance ?? "istanza sconosciuta"}, risulta RUNNING da ${minutes} minuti ` +
							`senza alcun evento di completamento — probabile blocco dell'istanza (turno bloccato o con risposta troncata dal provider). ` +
							`Decidi tu come procedere: un ping via agent_send verso quell'istanza per capire se è ancora viva, marcare il ticket come fallito con ` +
							`ticket_complete (status: "failed") e ripianificarlo su una nuova istanza dello stesso ruolo, oppure escalare all'utente se non riesci a ` +
							`sbloccarlo. L'utente è già stato avvisato via WhatsApp (se configurato). Annota cosa decidi nel report, così resta nell'audit trail.`,
						display: true,
						details: { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms, threshold_level: thresholdLevel },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				// best-effort — the SQLite event + MQTT publish + WhatsApp above already happened regardless
			}
		}

		// Revisione 42 — orphaned tickets: assigned instance confirmably not
		// connected (see moaFindOrphanedTickets() above). Fires independently of
		// the elapsed-time stall check above — no waiting needed, the presence
		// snapshot already tells us the instance is gone. Deterministic,
		// code-only action: mark the ticket "failed" itself (freeing the slot)
		// and force a mandatory relaunch instruction into the planner's own
		// turn — not a suggestion, since the real incident this closes was
		// exactly the planner treating "the coder never showed up" as license
		// to do the work itself instead of relaunching one.
		try {
			const orphaned = moaFindOrphanedTickets(moaStorage, identity.project, presence);
			for (const o of orphaned) {
				const episodeKey = `${o.ticket_id}::${o.running_since}`;
				if (watchdogOrphanAlerted.has(episodeKey)) continue;
				watchdogOrphanAlerted.add(episodeKey);

				const summary = `istanza "${o.assigned_instance}" risultata offline/disconnessa (nessuna presence viva) — rilevato dal watchdog, ticket riportato a failed automaticamente.`;
				try {
					moaStorage.updateTicketStatus(o.ticket_id, "failed", { result_summary: summary });
					moaStorage.recordEvent(o.run_id, "ticket_failed", { ticket_id: o.ticket_id, result_summary: summary, auto: true, reason: "orphaned_instance" }, o.ticket_id);
				} catch {
					// best-effort — the notification below still fires even if the DB write fails
				}
				void moaPublishEvent(o.run_id, "ticket_failed", { ticket_id: o.ticket_id, auto: true, reason: "orphaned_instance" });
				logEvent("watchdog_orphaned_ticket_auto_failed", { run_id: o.run_id, ticket_id: o.ticket_id, assigned_instance: o.assigned_instance });

				const waMessage =
					`🔴 watchdog: l'istanza "${o.assigned_instance}", assegnataria del ticket "${o.title}" (${o.ticket_id}), risulta OFFLINE — ` +
					`il ticket è stato automaticamente riportato a "failed". Il planner è stato svegliato con l'istruzione di rilanciare l'istanza.`;
				void sendWhatsAppNotification(waMessage).then((r) => logEvent("whatsapp_notify", { ok: r.ok, detail: r.detail, reason: "watchdog_orphaned_instance", ticket_id: o.ticket_id }));

				try {
					pi.sendMessage(
						{
							customType: "orchestrator-watchdog",
							content:
								`[watchdog] L'istanza "${o.assigned_instance}", a cui era assegnato il ticket "${o.title}" (${o.ticket_id}), risulta OFFLINE (nessuna ` +
								`presence MQTT viva) — il ticket è già stato riportato automaticamente a "failed" per liberare lo slot. AZIONE OBBLIGATORIA: rilancia ` +
								`ora "${o.assigned_instance}" (stesso nome o uno nuovo dello stesso ruolo) con lo stesso meccanismo herdr/tmux usato per la selezione ` +
								`iniziale del team, poi ripianifica questo lavoro (ticket_create/ticket_claim) su quell'istanza una volta che agent_list la mostra ` +
								`viva. NON eseguire tu il lavoro di questo ticket: sei il planner, il tuo compito è pianificare e delegare, mai scrivere codice al ` +
								`posto di un coder assente. L'utente è già stato avvisato via WhatsApp (se configurato).`,
							display: true,
							details: { run_id: o.run_id, ticket_id: o.ticket_id, assigned_instance: o.assigned_instance },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					// best-effort
				}
			}
		} catch {
			// best-effort — never let this new check take down the rest of the sweep
		}

		// Revisione 42 — opt-in hard-stuck auto-terminate
		// (PI_ORCH_WATCHDOG_AUTO_TERMINATE=true — see WATCHDOG_AUTO_TERMINATE_*
		// above for the trade-off this is deliberately NOT on by default for).
		// Only ever considers tickets that are BOTH past the harder threshold
		// AND still presence-live (not offline) — an already-gone instance is
		// handled by the orphan block above instead, nothing left to terminate.
		if (WATCHDOG_AUTO_TERMINATE_ENABLED && client && T) {
			try {
				const hardStuck = moaFindStalledTickets(moaStorage, identity.project, nowMs, WATCHDOG_AUTO_TERMINATE_MS);
				for (const s of hardStuck) {
					if (!s.assigned_instance) continue;
					const episodeKey = `${s.ticket_id}::${s.running_since}`;
					if (watchdogAutoTerminated.has(episodeKey)) continue;
					const card = presence.get(s.assigned_instance);
					if (!card || card.status === "offline") continue; // already-gone — the orphan block above already handled it
					watchdogAutoTerminated.add(episodeKey);

					const minutes = Math.round(s.elapsed_ms / 60_000);
					const env: TerminateEnvelope = {
						type: "terminate",
						requested_by_instance: identity.instance,
						requested_by_role: identity.role,
						reason: `watchdog: ticket "${s.ticket_id}" running da ${minutes} min senza ticket_complete (soglia auto-terminate superata)`,
						timestamp: nowIso(),
					};
					try {
						await client.publishAsync(T.agentCommands(s.assigned_instance), JSON.stringify(env), { qos: 1 });
					} catch {
						// best-effort — the notification/log below still happen regardless
					}
					try {
						moaStorage.recordEvent(s.run_id, "ticket_auto_terminated", { ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms });
					} catch {
						// best-effort
					}
					logEvent("watchdog_auto_terminate", { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms });

					const waMessage =
						`🔴 watchdog: istanza "${s.assigned_instance}" bloccata da ${minutes} min sul ticket "${s.title}" (${s.ticket_id}) — terminazione ` +
						`automatica inviata (PI_ORCH_WATCHDOG_AUTO_TERMINATE=true). Il planner deve rilanciarla.`;
					void sendWhatsAppNotification(waMessage).then((r) => logEvent("whatsapp_notify", { ok: r.ok, detail: r.detail, reason: "watchdog_auto_terminate", ticket_id: s.ticket_id }));

					try {
						pi.sendMessage(
							{
								customType: "orchestrator-watchdog",
								content:
									`[watchdog] Ho appena inviato una terminazione automatica a "${s.assigned_instance}" (bloccata da ${minutes} minuti sul ticket ` +
									`"${s.title}", ${s.ticket_id}, senza ticket_complete — soglia PI_ORCH_WATCHDOG_AUTO_TERMINATE_MS superata). AZIONE OBBLIGATORIA: ` +
									`verifica con agent_list che sia sparita, poi rilanciala (stesso meccanismo herdr/tmux della selezione del team) e marca ` +
									`questo ticket come failed con ticket_complete prima di ripianificarlo — NON eseguire tu il lavoro del ticket.`,
								display: true,
								details: { run_id: s.run_id, ticket_id: s.ticket_id, assigned_instance: s.assigned_instance, elapsed_ms: s.elapsed_ms },
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch {
						// best-effort
					}
				}
			} catch {
				// best-effort — never let this take down the rest of the sweep
			}
		}

		// Revisione 40 — see moaFindUnfinalizedRuns() above. Independent of the
		// ticket-stall loop above: a run can be fully "completed" at the DAG
		// layer (nothing running, nothing to flag there) while still missing its
		// operator-facing follow-up. `pi.sendMessage(..., {triggerTurn: true})`
		// below is the actual "awake" half of this fix — if the planner's own
		// turn-loop merely went idle (rather than the process having genuinely
		// exited), this forces a fresh turn instead of waiting for one that may
		// never come on its own. The WhatsApp send is a plain fetch, independent
		// of this planner's own LLM turn entirely, so it still reaches the
		// operator even if that revival attempt does nothing (process actually
		// dead, or wedged deeper than a turn boundary).
		try {
			const unfinalized = moaFindUnfinalizedRuns(moaStorage, identity.project, nowMs, WATCHDOG_FINALIZE_GRACE_MS);
			for (const r of unfinalized) {
				if (watchdogRunAlerted.has(r.run_id)) continue;
				watchdogRunAlerted.add(r.run_id);

				const minutes = Math.round(r.elapsed_ms / 60_000);
				try {
					moaStorage.recordEvent(r.run_id, "run_unfinalized_stall", { elapsed_ms: r.elapsed_ms });
				} catch {
					// best-effort — never let a logging failure hide this from the other channels below
				}
				logEvent("watchdog_unfinalized_run_detected", { run_id: r.run_id, objective: r.objective, elapsed_ms: r.elapsed_ms });

				const waMessage =
					`⚠️ watchdog: il run "${r.objective}" (${r.run_id}) risulta con TUTTI i ticket completati da ${minutes} min, ma nessun ` +
					`worktree_finalize/notifica di chiusura risulta ancora arrivato — possibile blocco del planner (es. turno interrotto dal ` +
					`provider LLM) subito dopo l'ultimo ticket_complete. Se il merge/la notifica finale sono già stati fatti manualmente, ignora ` +
					`questo avviso — è un'euristica sul tempo trascorso, non una certezza.`;
				void sendWhatsAppNotification(waMessage).then((r2) => logEvent("whatsapp_notify", { ok: r2.ok, detail: r2.detail, reason: "watchdog_unfinalized_run", run_id: r.run_id }));

				try {
					pi.sendMessage(
						{
							customType: "orchestrator-watchdog",
							content:
								`[watchdog] Il run "${r.objective}" (${r.run_id}) ha tutti i ticket completati da ${minutes} minuti, ma non risulta ancora ` +
								`nessun worktree_finalize né notifica di chiusura per questo lavoro. Se il task ha un worktree associato ancora aperto, ` +
								`chiama worktree_finalize ora; se è già stato finalizzato per un'altra via, non serve fare nulla — annota nel report cosa ` +
								`hai verificato. L'utente è già stato avvisato via WhatsApp (se configurato).`,
							display: true,
							details: { run_id: r.run_id, objective: r.objective, elapsed_ms: r.elapsed_ms },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					// best-effort — the SQLite event + WhatsApp above already happened regardless
				}
			}
		} catch {
			// best-effort — never let this second check take down the ticket-stall loop above
		}

		return stalled;
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
		description: "List known agent instances (role, team, status) discovered via MQTT presence. Presence is retained, so peers appear immediately even if they connected before you.",
		parameters: Type.Object({}),
		async execute() {
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
			const agents = [...presence.values()].map((c) => ({
				instance: c.instance, role: c.role, team: c.team ?? [], status: c.status, capacity: c.capacity ?? 0, current_load: c.current_load ?? 0,
			}));
			const lines = agents.length === 0
				? "No peer agents known yet (they may not have published presence, or you may need to wait for the retained message)."
				: agents.map((a) => `${a.status === "idle" ? "●" : a.status === "busy" ? "◐" : "✗"} ${a.instance} (${a.role}) team=[${a.team.join(",")}] load=${a.current_load}/${a.capacity}`).join("\n");
			return { content: [{ type: "text" as const, text: `${agents.length} peer(s):\n${lines}` }], details: { agents } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const agents = (result.details as any)?.agents ?? [];
			return new Text(theme.fg("accent", `⚡ ${agents.length} peer(s)`), 0, 0);
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
			const liveMatch = params.target_instance
				? presence.get(params.target_instance)?.status !== "offline" && presence.has(params.target_instance)
				: [...presence.values()].some((c) => c.role === params.target_role && c.status !== "offline");
			const noLiveTargetWarning = liveMatch
				? null
				: `⚠️ Nessuna istanza online per ${params.target_instance ? `"${params.target_instance}"` : `il ruolo "${params.target_role}"`} in questo progetto (verifica con agent_list). Il messaggio è stato pubblicato comunque, ma se non hai già lanciato quell'istanza (herdr agent start ...) nessuno lo riceverà mai — non trattare questo agent_send come una delega riuscita finché non confermi che l'istanza esiste davvero.`;
			if (noLiveTargetWarning) {
				logEvent("agent_send_no_live_target", { target: params.target_instance ?? `role:${params.target_role}` });
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

			const destTopic = params.target_instance ? T.agentCommands(params.target_instance) : T.roleTasks(params.target_role!);
			await client.publishAsync(destTopic, JSON.stringify(env), { qos: 1 });

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
				// actionable signal, also notify WhatsApp — mirrors the
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
					void sendWhatsAppNotification(
						`⏱️ Nessuna risposta da ${entry.target} entro ${Math.round(TIMEOUT_MS / 60000)} min (assignment ${assignment_id}) — ${identity?.instance ?? "?"} è stato risvegliato per decidere come procedere.`,
					).then((r) => logEvent("whatsapp_notify", { ok: r.ok, detail: r.detail, reason: "agent_send_timeout", assignment_id, target: entry.target }));
				}
			}, TIMEOUT_MS);
			try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
			pendingReplies.set(assignment_id, entry);

			pi.appendEntry("orchestrator-log", { event: "outbound_command", assignment_id, target: entry.target, hops });
			logEvent("agent_send_out", { assignment_id, target: entry.target, hops, new_round: !!params.new_round, prompt_preview: params.prompt.slice(0, 200) });

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
				details: { assignment_id, target: entry.target, hops, no_live_target: !!noLiveTargetWarning },
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
			return { content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }], details: { response: resp } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_await ")) + theme.fg("warning", (args as any).assignment_id ?? "?"), 0, 0);
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
	// for this extension to spawn a brand-new herdr pane/tmux session from
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
			"(same herdr/tmux mechanism as when you first launched the team) before delegating to it again; if you don't, " +
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
						"Verifica con agent_list tra qualche secondo che sia sparita, poi rilanciala tu (stesso meccanismo herdr/tmux della " +
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
	// arguably the same task — see docs/development-notes.md, Revisione 24, and
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
			"docs/development-notes.md). If anything here looks like the same feature as the new request, ask the user explicitly " +
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

	// ━━ WhatsApp completion notification via Evolution API (Revisione 19) ━━
	// On explicit user request: when a task's worktree is successfully
	// finalized — the exact moment "il lavoro è completato" — send a WhatsApp
	// message via a self-hosted Evolution API instance
	// (github.com/EvolutionAPI/evolution-api) to a fixed destination number,
	// both configured through a .env file in the project root (see
	// .env.example — real values never committed, .env is gitignored).
	// Entirely optional and best-effort: if the env vars aren't set, this
	// silently does nothing rather than failing worktree_finalize, since not
	// every checkout of this project has (or wants) WhatsApp configured.
	//
	// NAMING NOTE: Evolution API's own docs call a single WhatsApp
	// connection/session an "instance" — a COMPLETELY different concept from
	// THIS project's "instance" (an individual pi agent like coder-01).
	// EVOLUTION_INSTANCE_NAME below refers only to the former (which
	// WhatsApp connection to send FROM), never to a pi agent instance.
	//
	// Expected .env keys (see .env.example — exact names not yet confirmed
	// against the user's real .env, see docs/development-notes.md Revisione 19):
	//   EVOLUTION_API_URL         base URL of the Evolution API server
	//   EVOLUTION_API_KEY         sent as the `apikey` header
	//   EVOLUTION_INSTANCE_NAME   which WhatsApp connection to send FROM
	//   DESTINATION_PHONE_NUMBER  who to send TO (digits + country code, no "+")
	function loadEnvFile(cwd: string): Record<string, string> {
		const result: Record<string, string> = {};
		try {
			const raw = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eq = trimmed.indexOf("=");
				if (eq === -1) continue;
				const key = trimmed.slice(0, eq).trim();
				let value = trimmed.slice(eq + 1).trim();
				if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1);
				}
				result[key] = value;
			}
		} catch {
			// no .env in this project — fine, falls through to process.env only
		}
		return result;
	}

	function getEnvVar(cwd: string, key: string): string | undefined {
		// process.env takes precedence over .env — the usual dotenv convention,
		// lets a real shell/CI env override the file without editing it.
		return process.env[key] || loadEnvFile(cwd)[key] || undefined;
	}

	async function sendWhatsAppNotification(message: string): Promise<{ ok: boolean; detail: string }> {
		if (!identity) return { ok: false, detail: "orchestrator not initialised" };
		const apiUrl = getEnvVar(identity.cwd, "EVOLUTION_API_URL");
		const apiKey = getEnvVar(identity.cwd, "EVOLUTION_API_KEY");
		const instanceName = getEnvVar(identity.cwd, "EVOLUTION_INSTANCE_NAME");
		const destination = getEnvVar(identity.cwd, "DESTINATION_PHONE_NUMBER");
		const missing = [
			!apiUrl && "EVOLUTION_API_URL",
			!apiKey && "EVOLUTION_API_KEY",
			!instanceName && "EVOLUTION_INSTANCE_NAME",
			!destination && "DESTINATION_PHONE_NUMBER",
		].filter(Boolean) as string[];
		if (missing.length > 0) {
			return { ok: false, detail: `non configurato — variabili mancanti nel .env: ${missing.join(", ")}` };
		}
		const url = `${apiUrl!.replace(/\/+$/, "")}/message/sendText/${encodeURIComponent(instanceName!)}`;
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", apikey: apiKey! },
				body: JSON.stringify({ number: destination, text: message }),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return { ok: false, detail: `Evolution API ha risposto ${res.status}: ${body.slice(0, 200)}` };
			}
			return { ok: true, detail: "inviato" };
		} catch (err) {
			return { ok: false, detail: err instanceof Error ? err.message : String(err) };
		}
	}

	pi.registerTool({
		name: "notify_whatsapp",
		label: "Notify WhatsApp",
		description:
			"Send a WhatsApp message via Evolution API to the fixed destination number configured in .env (DESTINATION_PHONE_NUMBER), " +
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
			const storage = ensureMoaStorage();
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
			const evidence = ensureMoaStorage().listFinalizeEvidence(params.slug).map((item) => redactRuntimeProjection(item));
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
			"actually wanted and they said yes, don't assume it from silence; (b) either e2e_tests_run:true (the project's " +
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
			"WhatsApp completion notification automatically — you don't need to call notify_whatsapp yourself for the normal " +
			"case. Pass notify_message to customize the text; otherwise a sensible default naming the task is sent. If the .env " +
			"isn't configured, this is silently skipped — it never fails the actual merge.",
		parameters: Type.Object({
			slug: Type.String({ description: "Same slug passed to worktree_create for this task." }),
			commit_message: Type.Optional(Type.String({ description: "Commit message for any uncommitted changes and for the merge commit. Defaults to a generic message referencing the slug." })),
			notify_message: Type.Optional(Type.String({ description: "Custom WhatsApp completion message. Defaults to a generic one naming the task slug." })),
			user_confirmed: Type.Boolean({ description: "You explicitly asked the user to confirm this result is what they wanted, and they confirmed — required, no exceptions." }),
			e2e_tests_run: Type.Optional(Type.Boolean({ description: "The project's end-to-end/full test suite was actually run as part of this task." })),
			e2e_tests_skipped_reason: Type.Optional(Type.String({ description: "Required if e2e_tests_run is not true: why no e2e run applies to this task." })),
			version_bumped: Type.Optional(Type.Boolean({ description: "The project's own version marker (package.json or equivalent) was bumped as part of this task." })),
			version_bump_skipped_reason: Type.Optional(Type.String({ description: "Required if version_bumped is not true: why no version bump applies to this task." })),
			docs_synced: Type.Optional(Type.Boolean({ description: "A docs-sync pass actually compared the project's own README/QUICK-START/architecture diagram/other docs against the real end state of this task and fixed anything stale." })),
			docs_sync_skipped_reason: Type.Optional(Type.String({ description: "Required if docs_synced is not true: why no docs-sync pass applies to this task." })),
			push: Type.Optional(Type.Boolean({ description: "Push the main branch to its remote after a successful merge. Defaults to true — set false only if you deliberately don't want this task pushed yet." })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const slug = params.slug;
			if (!SLUG_RE.test(slug)) throw new Error(`worktree_finalize: "${slug}" is not a valid kebab-case slug.`);
			if (!params.user_confirmed) {
				throw new Error(
					"worktree_finalize: refused — user_confirmed must be true. Ask the user explicitly whether this task's result " +
						"is what they wanted BEFORE finalizing (Revisione 42) — don't assume completion just because every ticket is " +
						"done. Once they've confirmed, call this again with user_confirmed: true.",
				);
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
				const notifyResult = await sendWhatsAppNotification(notifyText);
				logEvent("whatsapp_notify", { slug, ok: notifyResult.ok, detail: notifyResult.detail, reason: "dirty_main_blocked_finalize" });
				return {
					content: [{
						type: "text" as const,
						text:
							`worktree_finalize: BLOCCATO — la directory principale del progetto (${identity.cwd}) ha modifiche non committate:\n\n${mainStatus.stdout}\n` +
							"Il merge non viene tentato: mischiare queste modifiche con quelle del worktree potrebbe produrre un conflitto fuorviante, " +
							"o peggio un merge \"pulito\" che in realtà mescola due cose diverse senza che nessuno se ne accorga. Committa o metti da " +
							"parte (git stash) queste modifiche nella directory principale, poi richiama worktree_finalize — il worktree resta intatto " +
							"nel frattempo." +
							(notifyResult.ok ? " (Notifica WhatsApp inviata.)" : ` (Notifica WhatsApp non inviata: ${notifyResult.detail}.)`),
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
				const notifyResult = await sendWhatsAppNotification(notifyText);
				logEvent("whatsapp_notify", { slug, ok: notifyResult.ok, detail: notifyResult.detail, reason: "merge_conflict" });
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
							(notifyResult.ok ? " (Notifica WhatsApp inviata.)" : ` (Notifica WhatsApp non inviata: ${notifyResult.detail}.)`),
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

			// WhatsApp completion notification (Revisione 19) — best-effort, only
			// on the success path, never allowed to affect the merge result above
			// (which has already happened by this point regardless of what
			// follows). Silently skipped if .env isn't configured for this
			// project — see sendWhatsAppNotification().
			const notifyText = params.notify_message || `✅ Task "${slug}" completato e verificato — unito nel progetto.`;
			const notifyResult = await sendWhatsAppNotification(notifyText);
			logEvent("whatsapp_notify", { slug, ok: notifyResult.ok, detail: notifyResult.detail });
			try {
				const mergedReportFile = reportPath(identity.cwd, slug); // now in the main checkout, not the (removed) worktree
				if (fs.existsSync(mergedReportFile)) {
					const destMasked = (getEnvVar(identity.cwd, "DESTINATION_PHONE_NUMBER") || "").replace(/.(?=.{3})/g, "•"); // e.g. •••••••123
					const line = `\n> _[evento] notifica WhatsApp fine task${destMasked ? ` a ${destMasked}` : ""} — ${notifyResult.ok ? "inviata" : `non inviata (${notifyResult.detail})`} alle ${nowIso()}_\n`;
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
						(notifyResult.ok ? " WhatsApp notification sent." : ` (WhatsApp notification not sent: ${notifyResult.detail})`),
				}],
				details: { merged: true, conflict: false, worktree_path: wtPath, branch, whatsapp_notified: notifyResult.ok, pushed: pushResult.ok },
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
	// docs/development-notes.md, Revisione 24). This tool is the cleanup step for
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
			"be merged normally. Exists because of a real incident (Revisione 24, see docs/development-notes.md) where a manual merge- " +
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
			const notifyResult = await sendWhatsAppNotification(`ℹ️ Task "${slug}": worktree chiuso manualmente (${reason}) — non tramite il normale merge automatico.`);
			logEvent("whatsapp_notify", { slug, ok: notifyResult.ok, detail: notifyResult.detail, reason: "worktree_abandon" });

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
	// `<worktreePath>/.pi/extensions/multiAgentOrchestrator/reports/<slug>.md`
	// (gitignored) — stessa logica di logsDir()/moaSubdirs più sopra: i
	// report sono reportistica di sviluppo di QUESTO progetto, non
	// deliverable applicativo, e non devono finire in un repo pubblico.
	// worktreePath può essere sia un worktree attivo (`.worktrees/<slug>`)
	// sia identity.cwd dopo il merge — in entrambi i casi risolve dentro il
	// `.pi/...` di quella specifica directory, quindi il codice più sotto
	// che copia da wtPath a identity.cwd dopo il merge continua a funzionare
	// invariato.
	function reportsDir(base: string): string {
		return moaSubdirs(moaWorkspaceDir(base)).reports;
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
	// share a phase. Keep the core code handoff deterministic while leaving
	// specialist/non-code roles to their declared Playbook path.
	function assertRoleHandoffAllowed(senderRole: string, targetRole: string, slug: string): void {
		const sender = senderRole.trim().toLowerCase();
		const target = targetRole.trim().toLowerCase();
		const backendRoles = new Set(["coder", "reviewer"]);
		const frontendRoles = new Set(["frontend-developer", "frontend-reviewer"]);
		const coreRoles = new Set(["planner", ...backendRoles, ...frontendRoles]);
		if (!coreRoles.has(target)) return;
		const allowed = target === "planner"
			? sender === "reviewer" || !coreRoles.has(sender)
			: target === "reviewer"
				? sender === "coder"
				: target === "frontend-reviewer"
					? sender === "frontend-developer"
					: sender === "planner" || sender === "reviewer" || sender === "frontend-reviewer";
		if (!allowed) {
			throw new Error(
				`agent_send: refused — handoff ${senderRole} → ${targetRole} is not allowed for "${slug}". ` +
				"The enforced paths are planner → coder → reviewer → planner and planner → frontend-developer → frontend-reviewer → planner; " +
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
			"unlocked yet is refused outright, for any sender, not just you. Phase 1 MUST include \"coder\" (its direct " +
			"correction cycle with reviewer stays internal to phase 1, not separate phases) — this is what stops a plan from " +
			"ever scheduling a specialist BEFORE coder, which happened in a real test (see docs/development-notes.md, Revisione 20). " +
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
			// — see docs/development-notes.md, Revisione 20) — and coder must then be the
			// very next phase, so it's never more than one phase away.
			const phase1Roles = params.phases[0].roles.map((r) => r.trim().toLowerCase());
			const isTddOnlyPhase1 = phase1Roles.length === 1 && phase1Roles[0] === "tdd-agent";
			if (!phase1Roles.includes("coder") && !isTddOnlyPhase1) {
				throw new Error(
					'plan_set: phase 1 must include "coder" — coder is always phase 1, no phase may precede it (see prompts/planner.md). ' +
						'The ONE exception: phase 1 may be "tdd-agent" ALONE (genuine TDD, tests before implementation), with "coder" ' +
						'required in phase 2 right after. If a specialist doesn\'t depend on the new code, put it in phase 1 ALONGSIDE ' +
						"coder, not in a phase before it.",
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
				const storage = ensureMoaStorage();
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

	// ━━ MultiAgentOrchestrator ticket/dependency tools (Revisione 26) ━━━━━━
	// See the module-scope section above for the storage/scheduler design.
	// This is a first vertical slice, additive on top of the existing
	// plan_set/plan_advance phase gate (not a replacement) — a task may use
	// either mechanism, or both, depending on what the planner picks.

	pi.registerTool({
		name: "playbook_bind",
		label: "Bind Playbook",
		description: "Load, validate and immutably bind a versioned Playbook to a run. Planner-only; the runtime persists origin, checksum and snapshot in SQLite.",
		parameters: Type.Object({ run_id: Type.String(), source: Type.String(), expected_checksum: Type.Optional(Type.String()) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner") throw new Error(`playbook_bind: only the planner role may bind a Playbook (this instance is "${identity.role}").`);
			const storage = ensureMoaStorage();
			const playbook = loadPlaybook(path.resolve(identity.cwd, params.source), { expectedChecksum: params.expected_checksum });
			const binding = storage.bindPlaybook(params.run_id, { id: playbook.id, schema_version: playbook.schema_version, metadata: playbook.metadata, snapshot: playbook });
			storage.recordEvent(params.run_id, "playbook_bound", { playbook_id: binding.playbook_id, checksum: binding.checksum, origin: binding.origin });
			return { content: [{ type: "text" as const, text: `playbook_bind: "${binding.playbook_id}" bound to run ${binding.run_id} (${binding.checksum.slice(0, 12)}…).` }], details: { binding: redactRuntimeProjection(binding) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_bind ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.binding?.playbook_id ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "playbook_evidence_record",
		label: "Record Playbook Evidence",
		description: "Persist idempotent evidence for a declared Playbook guard. Supported verified sources are run:objective_present, ticket:<id>:done, hold:<id>:answered, capability:cli:<name>:available, capability:mcp:<name>:handshake, capability:credential:<name>:present and capability:skill:<name>:loadable; transitions never consume a caller-supplied assertion list.",
		parameters: Type.Object({ run_id: Type.String(), requirement: Type.String(), source: Type.String(), idempotency_key: Type.String() }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner") throw new Error(`playbook_evidence_record: only the planner role may record Playbook evidence (this instance is "${identity.role}").`);
			const storage = ensureMoaStorage();
			const evidence = storage.recordPlaybookEvidence(params.run_id, { ...params, cwd: identity.cwd });
			if ((evidence as any).created) storage.recordEvent(params.run_id, "playbook_evidence_recorded", { requirement: params.requirement, source: params.source, idempotency_key: params.idempotency_key });
			return { content: [{ type: "text" as const, text: `playbook_evidence_record: evidence recorded for run ${params.run_id}.` }], details: { evidence: redactRuntimeProjection(evidence) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_evidence_record ")) + theme.fg("accent", (args as any).requirement ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.evidence?.requirement ?? "recorded"), 0, 0); },
	});

	pi.registerTool({
		name: "playbook_transition",
		label: "Playbook Transition",
		description: "Apply one declared Playbook transition with identity-bound actor, persisted-evidence guard and generation enforcement. The state update and audit event are atomic.",
		parameters: Type.Object({ run_id: Type.String(), transition_id: Type.String(), actor: Type.String(), expected_generation: Type.Optional(Type.Integer({ minimum: 0 })) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const role = identity.role.trim().toLowerCase();
			const actor = params.actor.trim().toLowerCase();
			const teamRole = role !== "planner" && role !== "user";
			const actorAllowed = actor === "planner" || actor === "runtime"
				? role === "planner"
				: actor === "human"
					? role === "user"
					: actor === "team"
						? teamRole
						: actor === "planner_or_reviewer"
							? role === "planner" || role === "reviewer"
							: actor === "planner_and_team"
								? role === "planner" || teamRole
								: actor === "coder_or_specialist"
									? role === "coder" || role === "frontend-developer" || (teamRole && role !== "reviewer")
									: actor === role;
			if (!actorAllowed) throw new Error(`playbook_transition: actor "${params.actor}" is not authorised for runtime role "${identity.role}".`);
			const result = ensureMoaStorage().transitionPlaybook(params.run_id, params);
			return { content: [{ type: "text" as const, text: `playbook_transition: ${result.from} → ${result.to} (${result.transition_id}, generation ${result.generation}).` }], details: { transition: redactRuntimeProjection(result) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_transition ")) + theme.fg("accent", (args as any).transition_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.transition?.to ?? "?"), 0, 0); },
	});

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
			const storage = ensureMoaStorage();
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

	pi.registerTool({
		name: "playbook_evidence_list",
		label: "List Playbook Evidence",
		description: "Read persisted Playbook guard evidence for a run.",
		parameters: Type.Object({ run_id: Type.String() }),
		async execute(_callId, params) {
			const evidence = ensureMoaStorage().listPlaybookEvidence(params.run_id).map((item) => redactRuntimeProjection(item));
			return { content: [{ type: "text" as const, text: `${evidence.length} Playbook evidence record(s) for run ${params.run_id}.` }], details: { evidence } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_evidence_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.evidence ?? []).length)), 0, 0); },
	});

	pi.registerTool({
		name: "capability_card_verify",
		label: "Verify Capability Card",
		description: "Run a bounded, redacted capability probe and persist its verified card for this run, role and instance.",
		parameters: Type.Object({ run_id: Type.String(), capability: Type.String(), source: Type.String(), requirement: Type.String(), idempotency_key: Type.String(), scope: Type.Optional(Type.String()), expires_at: Type.Optional(Type.String()) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("capability_card_verify: only planner may verify run capability cards.");
			const storage = ensureMoaStorage();
			const binding = storage.getPlaybookBinding(params.run_id);
			if (!binding) throw new Error(`capability_card_verify: run "${params.run_id}" has no bound Playbook.`);
			const scope = params.scope ?? `project:${identity.project}:run:${params.run_id}`;
			const fingerprint = crypto.createHash("sha256").update(`${params.source}|${scope}|${identity.cwd}|${process.version}|${binding.checksum}`).digest("hex");
			try {
				const evidence = storage.recordPlaybookEvidence(params.run_id, { requirement: params.requirement, source: params.source, idempotency_key: params.idempotency_key, cwd: identity.cwd }) as any;
				const card = storage.upsertCapabilityCard({ run_id: params.run_id, role: identity.role, instance: identity.instance, capability: params.capability, source: params.source, scope, fingerprint, playbook_checksum: binding.checksum, status: "verified", verified_at: nowIso(), expires_at: params.expires_at ?? null });
				if (evidence.created) storage.recordEvent(params.run_id, "capability_card_verified", { capability: params.capability, role: identity.role, instance: identity.instance, scope, fingerprint });
				return { content: [{ type: "text" as const, text: `capability_card_verify: ${params.capability} verified for ${identity.role}/${identity.instance}.` }], details: { card: redactRuntimeProjection(card) } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const card = storage.upsertCapabilityCard({ run_id: params.run_id, role: identity.role, instance: identity.instance, capability: params.capability, source: params.source, scope, fingerprint, playbook_checksum: binding.checksum, status: "failed", last_error: message });
				storage.recordEvent(params.run_id, "capability_card_failed", { capability: params.capability, role: identity.role, instance: identity.instance, scope, reason: message });
				throw error;
			}
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("capability_card_verify ")) + theme.fg("accent", (args as any).capability ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.card?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "capability_card_list",
		label: "List Capability Cards",
		description: "Read redacted capability cards persisted for a run.",
		parameters: Type.Object({ run_id: Type.String() }),
		async execute(_callId, params) {
			const cards = ensureMoaStorage().listCapabilityCards(params.run_id).map((card) => redactRuntimeProjection(card));
			return { content: [{ type: "text" as const, text: `${cards.length} capability card(s) for run ${params.run_id}.` }], details: { cards } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("capability_card_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.cards ?? []).length)), 0, 0); },
	});

	pi.registerTool({
		name: "capability_card_invalidate",
		label: "Invalidate Capability Card",
		description: "Mark a persisted capability card blocked with a redacted operator-visible reason.",
		parameters: Type.Object({ run_id: Type.String(), role: Type.String(), instance: Type.String(), capability: Type.String(), reason: Type.String() }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("capability_card_invalidate: only planner may invalidate cards.");
			const card = ensureMoaStorage().invalidateCapabilityCard(params.run_id, params.role, params.instance, params.capability, params.reason);
			ensureMoaStorage().recordEvent(params.run_id, "capability_card_invalidated", { role: params.role, instance: params.instance, capability: params.capability, reason: params.reason });
			return { content: [{ type: "text" as const, text: `capability_card_invalidate: ${params.capability} is blocked.` }], details: { card: redactRuntimeProjection(card) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("capability_card_invalidate ")) + theme.fg("accent", (args as any).capability ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.card?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "playbook_effect_list",
		label: "List Playbook Effects",
		description: "Read the explicit Playbook effect outbox for a run. This tool never executes an external effect.",
		parameters: Type.Object({ run_id: Type.String(), status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("dispatched")])) }),
		async execute(_callId, params) {
			const effects = ensureMoaStorage().listPlaybookEffects(params.run_id, params.status).map((effect) => redactRuntimeProjection(effect));
			return { content: [{ type: "text" as const, text: `${effects.length} Playbook effect(s) for run ${params.run_id}.` }], details: { effects } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.effects ?? []).length)), 0, 0); },
	});

	pi.registerTool({
		name: "playbook_effect_ack",
		label: "Acknowledge Playbook Effect",
		description: "Acknowledge one pending Playbook effect after an authorized adapter delivered it. Planner may acknowledge audit/approval effects; external notification/MQTT effects require the effect-adapter role. Idempotent and generation-fenced; never executes arbitrary commands.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), generation: Type.Integer({ minimum: 0 }), idempotency_key: Type.String() }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner" && identity.role !== "effect-adapter") throw new Error(`playbook_effect_ack: role "${identity.role}" is not authorised.`);
			const effect = ensureMoaStorage().ackPlaybookEffect(params.id, { ...params, actor_role: identity.role });
			return { content: [{ type: "text" as const, text: `playbook_effect_ack: effect ${effect.id} is ${effect.status}.` }], details: { effect: redactRuntimeProjection(effect) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_ack ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.effect?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "playbook_effect_claim",
		label: "Claim Playbook Effect",
		description: "Acquire a durable, fenced lease for an external Playbook effect. Only effect-adapter may claim delivery work.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), owner: Type.String(), token: Type.String(), lease_until: Type.String() }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "effect-adapter") throw new Error("playbook_effect_claim: only effect-adapter may claim effects.");
			const effect = ensureMoaStorage().claimPlaybookEffect(params.id, params);
			return { content: [{ type: "text" as const, text: `playbook_effect_claim: effect ${effect.id} leased.` }], details: { effect: redactRuntimeProjection(effect) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_claim ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.effect?.delivery_state ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "playbook_effect_fail",
		label: "Fail Playbook Effect",
		description: "Record a fenced external effect failure and move it to bounded retry or dead-letter.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), owner: Type.String(), token: Type.String(), error: Type.String(), max_attempts: Type.Integer({ minimum: 1 }), next_attempt_at: Type.Optional(Type.String()) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "effect-adapter") throw new Error("playbook_effect_fail: only effect-adapter may fail effects.");
			const effect = ensureMoaStorage().failPlaybookEffect(params.id, params);
			return { content: [{ type: "text" as const, text: `playbook_effect_fail: effect ${effect.id} is ${effect.delivery_state}.` }], details: { effect: redactRuntimeProjection(effect) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("playbook_effect_fail ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.effect?.delivery_state ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "orchestrator_init",
		label: "Orchestrator Init",
		description:
			"Idempotently create/open the MultiAgentOrchestrator project workspace (.pi/extensions/multiAgentOrchestrator/ — " +
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
			const cfg = moaEnsureWorkspace(identity.cwd, identity.project, params.project_name);
			const storage = ensureMoaStorage();
			const reconciledRuns = identity.role === "planner" ? moaReconcilePersistedState(storage, identity.project, presence) : 0;
			const schemaVersion = storage.getSchemaVersion();
			logEvent("moa_init", { schema_version: schemaVersion, extension_version: cfg.extension_version, project: cfg.project, reconciled_runs: reconciledRuns });
			return {
				content: [{ type: "text" as const, text: `orchestrator_init: workspace ready at .pi/extensions/multiAgentOrchestrator/ (schema v${schemaVersion}, extension ${cfg.extension_version}, project "${cfg.project}").${reconciledRuns ? ` Reconciled ${reconciledRuns} active run(s).` : ""}` }],
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
			const storage = ensureMoaStorage();
			const run = storage.createRun({ project: identity.project, objective: params.objective, domain: params.domain || "generic" });
			storage.recordEvent(run.id, "run_created", { objective: run.objective, domain: run.domain });
			logEvent("moa_run_created", { run_id: run.id, domain: run.domain });
			await moaPublishEvent(run.id, "run_created", { objective: run.objective, domain: run.domain });
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
			const storage = ensureMoaStorage();
			const run = storage.getRun(params.run_id);
			if (!run) throw new Error(`spec_create: no run "${params.run_id}" — call run_create first.`);
			const specsDir = moaSubdirs(moaWorkspaceDir(identity.cwd)).specs;
			const slugTitle = params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "spec";
			const specId = ulid();
			const filePath = path.join(specsDir, `${specId}-${slugTitle}.md`);
			fs.writeFileSync(filePath, `# ${params.title}\n\n${params.content}\n`);
			const spec = storage.createSpec({ id: specId, run_id: params.run_id, title: params.title, content: params.content, file_path: path.relative(identity.cwd, filePath) });
			storage.recordEvent(run.id, "spec_created", { spec_id: spec.id, title: spec.title });
			logEvent("moa_spec_created", { run_id: run.id, spec_id: spec.id });
			await moaPublishEvent(run.id, "spec_created", { spec_id: spec.id, title: spec.title });
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

	pi.registerTool({
		name: "ticket_create",
		label: "Ticket Create",
		description:
			"Create a canonical internal ticket for a run — planner-only. This is the To-Tickets-inspired decomposition " +
			"unit: platform-independent, never synced to GitHub/Linear/Jira (no Ticket Publisher exists or is planned). " +
			"depends_on lists OTHER ticket ids in the same run that must reach status \"done\" before this one becomes " +
			"READY — readiness is always computed by tickets_ready, never declared directly.",
		parameters: Type.Object({
			run_id: Type.String(),
			spec_id: Type.Optional(Type.String()),
			title: Type.String(),
			description: Type.Optional(Type.String()),
			domain: Type.Optional(Type.String()),
			required_capabilities: Type.Optional(Type.Array(Type.String(), { description: 'e.g. ["backend", "typescript"] — matched against the claiming agent\'s role + skills by ticket_claim.' })),
			required_playbook: Type.Optional(Type.String({ description: "Optional Playbook id required by this ticket; when present it must match the run's immutable binding." })),
			acceptance_criteria: Type.Optional(Type.Array(Type.String())),
			depends_on: Type.Optional(Type.Array(Type.String(), { description: "Ticket ids (in the same run) this ticket cannot start before." })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner") throw new Error(`ticket_create: only the planner role may create tickets (this instance is "${identity.role}").`);
			const storage = ensureMoaStorage();
			const run = storage.getRun(params.run_id);
			if (!run) throw new Error(`ticket_create: no run "${params.run_id}" — call run_create first.`);
			if (params.spec_id && !storage.getSpec(params.spec_id)) throw new Error(`ticket_create: no spec "${params.spec_id}" in this run.`);
			const binding = storage.getPlaybookBinding(params.run_id);
			const requiredPlaybook = params.required_playbook || null;
			if (params.required_playbook && binding && binding.playbook_id !== params.required_playbook) {
				throw new Error(`ticket_create: required_playbook "${params.required_playbook}" does not match the run binding "${binding.playbook_id}".`);
			}
			// Validate every dependency BEFORE creating anything — an invalid
			// depends_on must leave NO trace (no orphan ticket row) when this
			// tool call fails, not just fail to wire the dependency. Found by
			// scripts/smoke-test-ticket-engine.mjs: creating the ticket first
			// and validating depends_on after left a ticket behind even though
			// the tool call itself threw.
			const depIds = params.depends_on ?? [];
			for (const depId of depIds) {
				const dep = storage.getTicket(depId);
				if (!dep || dep.run_id !== params.run_id) throw new Error(`ticket_create: depends_on references ticket "${depId}" which doesn't exist in run "${params.run_id}".`);
			}
			const ticket = storage.createTicket({
				run_id: params.run_id,
				spec_id: params.spec_id ?? null,
				title: params.title,
				description: params.description,
				domain: params.domain || run.domain,
				required_capabilities: params.required_capabilities,
				required_playbook: requiredPlaybook,
				acceptance_criteria: params.acceptance_criteria,
			});
			for (const depId of depIds) storage.addDependency(ticket.id, depId);
			storage.recordEvent(run.id, "ticket_created", { ticket_id: ticket.id, title: ticket.title, depends_on: depIds }, ticket.id);
			logEvent("moa_ticket_created", { run_id: run.id, ticket_id: ticket.id, depends_on: depIds });
			await moaPublishEvent(run.id, "ticket_created", { ticket_id: ticket.id, title: ticket.title });
			if (depIds.length === 0) {
				storage.recordEvent(run.id, "ticket_ready", { ticket_id: ticket.id }, ticket.id);
				await moaPublishEvent(run.id, "ticket_ready", { ticket_id: ticket.id, title: ticket.title });
			}
			return {
				content: [{ type: "text" as const, text: `ticket_create: "${ticket.title}" created (${ticket.id})${depIds.length ? `, depends on ${depIds.join(", ")}` : " — READY immediately (no dependencies)"}.` }],
				details: { ticket },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ticket_create ")) + theme.fg("accent", (args as any).title ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const ticket = (result.details as any)?.ticket;
			return new Text(theme.fg("success", "→ ticket ") + theme.fg("accent", ticket?.id ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
		name: "tickets_ready",
		label: "Tickets Ready",
		description:
			"Deterministically compute which tickets in a run are READY (all dependencies done, not yet started), BLOCKED, " +
			"RUNNING, DONE, FAILED, or CANCELLED, plus the execution waves (groups that could run in parallel) for what's " +
			"still outstanding. Pure computation over SQLite state, never a stored/stale status. Any role may call this.",
		parameters: Type.Object({ run_id: Type.String() }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const storage = ensureMoaStorage();
			const run = storage.getRun(params.run_id);
			if (!run) throw new Error(`tickets_ready: no run "${params.run_id}".`);
			const tickets = storage.listTickets(params.run_id);
			const deps = storage.listDependencies(params.run_id);
			const buckets = moaComputeReadyBlocked(tickets, deps);
			const waves = moaComputeExecutionWaves(tickets, deps);
			const byId = new Map(tickets.map((t) => [t.id, t]));
			const describe = (ids: string[]) => ids.map((id) => `${id} (${byId.get(id)?.title ?? "?"})`).join(", ") || "—";
			return {
				content: [
					{
						type: "text" as const,
						text:
							`ready: ${describe(buckets.ready)}\n` +
							`blocked: ${describe(buckets.blocked)}\n` +
							`running: ${describe(buckets.running)}\n` +
							`done: ${buckets.done.length}, failed: ${buckets.failed.length}, cancelled: ${buckets.cancelled.length}\n` +
							`execution waves (outstanding work): ${waves.map((w, i) => `[${i + 1}] ${w.join(", ")}`).join("  ") || "—"}`,
					},
				],
				details: { ...buckets, waves },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("tickets_ready ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", `${d?.ready?.length ?? 0} ready, ${d?.blocked?.length ?? 0} blocked`), 0, 0);
		},
	});

	pi.registerTool({
		name: "ticket_claim",
		label: "Ticket Claim",
		description:
			"Claim a READY ticket to work on it — sets it to running and assigns it to this instance. Refuses if the " +
			"ticket isn't READY (blocked on dependencies, already running, done, etc.), or if it declares " +
			"required_capabilities this instance's role+skills don't cover. Planner-EXCLUDED (Revisione 42): the planner " +
			"never claims ticket work itself — see docs/development-notes.md Revisione 42 for the real incident (a missing " +
			"coder led the planner to just do the coding itself instead of relaunching one) this closes structurally, not " +
			"just by instruction. If no live instance of the required role exists, relaunch one — never claim its ticket.",
		parameters: Type.Object({ ticket_id: Type.String() }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role === "planner") {
				throw new Error(
					"ticket_claim: the planner role may never claim a ticket — planning and delegating is the whole job, doing the " +
						"work yourself (even once, even to unblock a missing/dead instance) is exactly the failure Revisione 42 closed. " +
						"Relaunch the instance whose role this ticket needs (same herdr/tmux mechanism as initial team selection), " +
						"then let THAT instance call ticket_claim.",
				);
			}
			const storage = ensureMoaStorage();
			const ticket = storage.getTicket(params.ticket_id);
			if (!ticket) throw new Error(`ticket_claim: no ticket "${params.ticket_id}".`);
			if (ticket.required_playbook) {
				const binding = storage.getPlaybookBinding(ticket.run_id);
				if (!binding || binding.playbook_id !== ticket.required_playbook) {
					throw new Error(`ticket_claim: ticket "${ticket.id}" requires playbook "${ticket.required_playbook}", but the run has no matching immutable binding.`);
				}
				if (identity.playbook && identity.playbook !== ticket.required_playbook) {
					throw new Error(`ticket_claim: role "${identity.role}" is mapped to playbook "${identity.playbook}" and cannot claim a "${ticket.required_playbook}" ticket.`);
				}
			}
			const tickets = storage.listTickets(ticket.run_id);
			const deps = storage.listDependencies(ticket.run_id);
			const buckets = moaComputeReadyBlocked(tickets, deps);
			if (!buckets.ready.includes(ticket.id)) {
				throw new Error(`ticket_claim: "${ticket.id}" is not READY right now (status: ${ticket.status}${buckets.blocked.includes(ticket.id) ? ", blocked on unfinished dependencies" : ""}).`);
			}
			if (ticket.required_capabilities.length > 0) {
				const have = new Set([identity.role.toLowerCase(), ...identity.skills.map((s) => s.toLowerCase())]);
				const missing = ticket.required_capabilities.filter((c) => !have.has(c.toLowerCase()));
				if (missing.length > 0) {
					throw new Error(`ticket_claim: this instance (role "${identity.role}") is missing required capabilities: ${missing.join(", ")}.`);
				}
			}
			const updated = storage.updateTicketStatus(ticket.id, "running", { assigned_instance: identity.instance });
			storage.recordEvent(ticket.run_id, "ticket_started", { ticket_id: ticket.id, assigned_instance: identity.instance }, ticket.id);
			logEvent("moa_ticket_claimed", { run_id: ticket.run_id, ticket_id: ticket.id });
			await moaPublishEvent(ticket.run_id, "ticket_started", { ticket_id: ticket.id, assigned_instance: identity.instance });
			// Revisione 40 — see activeTicketIds declaration: this instance is now
			// genuinely doing ticket work regardless of whatever inboundQueue looks
			// like, so the MQTT presence widget must reflect that immediately, not
			// wait for the next heartbeat tick.
			activeTicketIds.add(ticket.id);
			void publishPresence(computeSelfStatus());
			return {
				content: [{ type: "text" as const, text: `ticket_claim: "${ticket.title}" (${ticket.id}) claimed by ${identity.instance}.` }],
				details: { ticket: updated },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ticket_claim ")) + theme.fg("accent", (args as any).ticket_id ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const ticket = (result.details as any)?.ticket;
			return new Text(theme.fg("success", "→ claimed by ") + theme.fg("accent", ticket?.assigned_instance ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
		name: "ticket_complete",
		label: "Ticket Complete",
		description:
			"Mark a ticket done or failed and report the result. Only the instance that claimed it (or planner, who may " +
			"override) may call this — BY DESIGN it is normally the planner who calls this, not the worker: a ticket " +
			"represents a role's contribution to a phase, and that contribution is only truly \"done\" once the planner is " +
			"satisfied (see prompts/planner.md — call this alongside plan_advance, for every ticket in the phase you're " +
			"closing, not just whichever instance woke you last). On \"done\", recomputes which dependent tickets just " +
			"became READY and publishes ticket_ready for each; if every ticket in the run is now done, the run itself is " +
			"marked completed. On \"failed\", dependents stay blocked — no automatic cascade (replanning to route around a " +
			"failure is deferred, see docs/development-notes.md Revisione 26).",
		parameters: Type.Object({
			ticket_id: Type.String(),
			status: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
			result_summary: Type.Optional(Type.String()),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const storage = ensureMoaStorage();
			const ticket = storage.getTicket(params.ticket_id);
			if (!ticket) throw new Error(`ticket_complete: no ticket "${params.ticket_id}".`);
			if (ticket.status !== "running") throw new Error(`ticket_complete: "${ticket.id}" is not running (status: ${ticket.status}) — only a running ticket can be completed.`);
			if (ticket.assigned_instance !== identity.instance && identity.role !== "planner") {
				throw new Error(`ticket_complete: "${ticket.id}" is assigned to "${ticket.assigned_instance}", not this instance ("${identity.instance}") — only the assignee or planner may complete it.`);
			}
			const updated = storage.updateTicketStatus(ticket.id, params.status, { result_summary: params.result_summary ?? null });
			storage.recordEvent(ticket.run_id, params.status === "done" ? "ticket_done" : "ticket_failed", { ticket_id: ticket.id, result_summary: params.result_summary ?? null }, ticket.id);
			logEvent("moa_ticket_completed", { run_id: ticket.run_id, ticket_id: ticket.id, status: params.status });
			await moaPublishEvent(ticket.run_id, params.status === "done" ? "ticket_done" : "ticket_failed", { ticket_id: ticket.id });
			// Revisione 40 — counterpart of the activeTicketIds.add() in
			// ticket_claim: this ticket is no longer "why this instance is busy"
			// (done or failed, either way the running work stopped), so drop it
			// and re-publish immediately rather than waiting for the next
			// heartbeat — same reasoning as ticket_claim above.
			//
			// Honest limit: activeTicketIds is per-process (this instance's own
			// closure), so this only clears correctly when the SAME instance that
			// claimed the ticket also completes it. The tool description above
			// explicitly allows the planner to override and complete a ticket on
			// another instance's behalf (e.g. after a watchdog stall) — in that
			// case this delete runs on the PLANNER's own set (a no-op) and the
			// original assignee's presence stays "busy" until that instance's own
			// process exits or otherwise republishes. Fixing that fully would mean
			// tracking per-ticket ownership centrally (MQTT/SQLite) rather than in
			// each instance's local memory — out of scope for this incident, which
			// was a same-instance claim→complete flow throughout.
			activeTicketIds.delete(ticket.id);
			void publishPresence(computeSelfStatus());

			const newlyReady: string[] = [];
			if (params.status === "done") {
				const tickets = storage.listTickets(ticket.run_id);
				const deps = storage.listDependencies(ticket.run_id);
				const buckets = moaComputeReadyBlocked(tickets, deps);
				for (const readyId of buckets.ready) {
					const dependsOnCompleted = deps.some((d) => d.ticket_id === readyId && d.depends_on_id === ticket.id);
					if (dependsOnCompleted) newlyReady.push(readyId);
				}
				for (const readyId of newlyReady) {
					storage.recordEvent(ticket.run_id, "ticket_ready", { ticket_id: readyId }, readyId);
					await moaPublishEvent(ticket.run_id, "ticket_ready", { ticket_id: readyId });
				}
				const allTickets = storage.listTickets(ticket.run_id);
				const allDone = allTickets.length > 0 && allTickets.every((t) => t.status === "done");
				if (allDone) {
					storage.updateRunStatus(ticket.run_id, "completed");
					storage.recordEvent(ticket.run_id, "run_completed", {});
					await moaPublishEvent(ticket.run_id, "run_completed", {});
				}
			}

			return {
				content: [{ type: "text" as const, text: `ticket_complete: "${ticket.title}" (${ticket.id}) marked ${params.status}.${newlyReady.length ? ` Newly READY: ${newlyReady.join(", ")}.` : ""}` }],
				details: { ticket: updated, newly_ready: newlyReady },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ticket_complete ")) + theme.fg("accent", `${(args as any).ticket_id ?? "?"} → ${(args as any).status ?? "?"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const ticket = (result.details as any)?.ticket;
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", ticket?.status ?? "?"), 0, 0);
		},
	});

	pi.registerTool({
		name: "ticket_requeue",
		label: "Requeue Ticket Recovery",
		description: "Requeue a failed ticket on the same id with a persisted recovery generation and bounded retry budget.",
		parameters: Type.Object({ ticket_id: Type.String(), reason: Type.String(), max_retries: Type.Integer({ minimum: 1 }), max_replans: Type.Optional(Type.Integer({ minimum: 1 })) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("ticket_requeue: only planner may replace a failed worker.");
			const result = ensureMoaStorage().requeueTicketForRecovery(params.ticket_id, params) as any;
			return { content: [{ type: "text" as const, text: `ticket_requeue: ${params.ticket_id} is pending (recovery generation ${result.recovery.recovery_generation}).` }], details: { ...result, recovery: redactRuntimeProjection(result.recovery) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("ticket_requeue ")) + theme.fg("accent", (args as any).ticket_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String((result.details as any)?.recovery?.recovery_generation ?? "?")), 0, 0); },
	});

	pi.registerTool({
		name: "ticket_recovery_get",
		label: "Get Ticket Recovery",
		description: "Read the persisted retry/replan budget for a ticket.",
		parameters: Type.Object({ ticket_id: Type.String() }),
		async execute(_callId, params) {
			const recovery = ensureMoaStorage().getTicketRecovery(params.ticket_id);
			return { content: [{ type: "text" as const, text: recovery ? `ticket_recovery: ${params.ticket_id} retry ${recovery.retry_count}/${recovery.max_retries}.` : `ticket_recovery: no recovery record for ${params.ticket_id}.` }], details: { recovery: redactRuntimeProjection(recovery) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("ticket_recovery_get ")) + theme.fg("accent", (args as any).ticket_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.recovery?.status ?? "none"), 0, 0); },
	});

	pi.registerTool({
		name: "decision_hold_create",
		label: "Create Decision Hold",
		description: "Create or retrieve an idempotent human decision hold. Only planner/user authority may create holds; execution remains paused until answer, cancel, or expiry.",
		parameters: Type.Object({
			run_id: Type.String(), ticket_id: Type.Optional(Type.String()), generation: Type.Optional(Type.Integer({ minimum: 0 })),
			question: Type.String(), context: Type.Optional(Type.Unknown()), owner: Type.String(),
			expires_at: Type.Optional(Type.String()), idempotency_key: Type.String(),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_create: role "${identity.role}" is not authorised.`);
			const storage = ensureMoaStorage();
			const hold = storage.createDecisionHold({ ...params, ticket_id: params.ticket_id ?? null, context: params.context ?? {}, idempotency_key: params.idempotency_key });
			storage.recordEvent(hold.run_id, "decision_hold_created", { hold_id: hold.id, generation: hold.generation, owner: hold.owner, expires_at: hold.expires_at }, hold.ticket_id);
			return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: ${hold.status} (generation ${hold.generation})` }], details: { hold: redactRuntimeProjection(hold) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_create ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.hold?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "decision_hold_get",
		label: "Get Decision Hold",
		description: "Read one persisted decision hold by id.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_callId, params) {
			const hold = ensureMoaStorage().getDecisionHold(params.id);
			if (!hold) throw new Error(`decision_hold_get: no hold "${params.id}".`);
			return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: ${hold.status}` }], details: { hold: redactRuntimeProjection(hold) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_get ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.hold?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "decision_hold_list",
		label: "List Decision Holds",
		description: "List persisted decision holds for a run, optionally filtered by status.",
		parameters: Type.Object({ run_id: Type.String(), status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("expired"), Type.Literal("cancelled"), Type.Literal("blocked")])) }),
		async execute(_callId, params) {
			const holds = ensureMoaStorage().listDecisionHolds(params.run_id, params.status as DecisionHoldStatus | undefined).map((hold) => redactRuntimeProjection(hold));
			return { content: [{ type: "text" as const, text: `${holds.length} decision hold(s) for run ${params.run_id}.` }], details: { holds } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_list ")) + theme.fg("accent", (args as any).run_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String(((result.details as any)?.holds ?? []).length)), 0, 0); },
	});

	pi.registerTool({
		name: "decision_hold_answer",
		label: "Answer Decision Hold",
		description: "Answer an open decision hold with generation fencing and retry-safe idempotency.",
		parameters: Type.Object({ id: Type.String(), generation: Type.Integer({ minimum: 0 }), answer: Type.String(), idempotency_key: Type.String(), resolution_metadata: Type.Optional(Type.Unknown()), expected_checksum: Type.Optional(Type.String()), principal: Type.Optional(Type.String()) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_answer: role "${identity.role}" is not authorised.`);
			const storage = ensureMoaStorage();
			const hold = storage.answerDecisionHold(params.id, params);
			storage.recordEvent(hold.run_id, "decision_hold_answered", { hold_id: hold.id, generation: hold.generation, idempotency_key: params.idempotency_key }, hold.ticket_id);
			await moaPublishEvent(hold.run_id, "decision_hold_answered", { hold_id: hold.id, generation: hold.generation });
			return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: answered` }], details: { hold: redactRuntimeProjection(hold) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_answer ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
		renderResult(_result, _options, theme) { return new Text(theme.fg("success", "→ answered"), 0, 0); },
	});

	pi.registerTool({
		name: "decision_hold_cancel",
		label: "Cancel Decision Hold",
		description: "Cancel an open decision hold with generation fencing and retry-safe idempotency.",
		parameters: Type.Object({ id: Type.String(), generation: Type.Integer({ minimum: 0 }), reason: Type.Optional(Type.String()), idempotency_key: Type.String(), expected_checksum: Type.Optional(Type.String()), principal: Type.Optional(Type.String()) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_cancel: role "${identity.role}" is not authorised.`);
			const storage = ensureMoaStorage();
			const hold = storage.cancelDecisionHold(params.id, params);
			storage.recordEvent(hold.run_id, "decision_hold_cancelled", { hold_id: hold.id, generation: hold.generation, idempotency_key: params.idempotency_key, reason_provided: Boolean(params.reason) }, hold.ticket_id);
			await moaPublishEvent(hold.run_id, "decision_hold_cancelled", { hold_id: hold.id, generation: hold.generation });
			return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: cancelled` }], details: { hold: redactRuntimeProjection(hold) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_cancel ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
		renderResult(_result, _options, theme) { return new Text(theme.fg("success", "→ cancelled"), 0, 0); },
	});

	pi.registerTool({
		name: "decision_hold_escalate",
		label: "Escalate Decision Hold",
		description: "Escalate an open decision hold to another principal with generation and idempotency fencing.",
		parameters: Type.Object({ id: Type.String(), generation: Type.Integer({ minimum: 0 }), escalated_to: Type.String(), idempotency_key: Type.String(), expected_checksum: Type.Optional(Type.String()) }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			if (identity.role !== "planner" && identity.role !== "user") throw new Error(`decision_hold_escalate: role "${identity.role}" is not authorised.`);
			const hold = ensureMoaStorage().escalateDecisionHold(params.id, params);
			ensureMoaStorage().recordEvent(hold.run_id, "decision_hold_escalated", { hold_id: hold.id, generation: hold.generation, escalated_to: hold.escalated_to, escalation_version: hold.escalation_version }, hold.ticket_id);
			return { content: [{ type: "text" as const, text: `decision hold ${hold.id}: escalated to ${hold.escalated_to}` }], details: { hold: redactRuntimeProjection(hold) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("decision_hold_escalate ")) + theme.fg("accent", (args as any).id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.hold?.escalated_to ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "retention_policy_set",
		label: "Set Retention Policy",
		description: "Persist a versioned, explicit retention policy for project storage. This tool never deletes data.",
		parameters: Type.Object({ project: Type.String(), event_days: Type.Integer({ minimum: 1 }), evidence_days: Type.Integer({ minimum: 1 }), outbox_days: Type.Integer({ minimum: 1 }), dead_letter_days: Type.Integer({ minimum: 1 }), policy_version: Type.Integer({ minimum: 1 }) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("retention_policy_set: only planner may set policy.");
			const policy = ensureMoaStorage().setRetentionPolicy(params);
			return { content: [{ type: "text" as const, text: `retention_policy_set: version ${policy.policy_version} for ${policy.project}.` }], details: { policy: redactRuntimeProjection(policy) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("retention_policy_set ")) + theme.fg("accent", (args as any).project ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", String((result.details as any)?.policy?.policy_version ?? "?")), 0, 0); },
	});

	pi.registerTool({
		name: "retention_policy_preview",
		label: "Preview Retention",
		description: "Preview retention candidates and counts without deleting audit, evidence or effect data.",
		parameters: Type.Object({ project: Type.String() }),
		async execute(_callId, params) {
			const preview = ensureMoaStorage().previewRetention(params.project);
			return { content: [{ type: "text" as const, text: `retention_policy_preview: ${JSON.stringify(preview.counts)}.` }], details: { preview: redactRuntimeProjection(preview) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("retention_policy_preview ")) + theme.fg("accent", (args as any).project ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ preview"), 0, 0); },
	});

	pi.registerTool({
		name: "retention_policy_apply",
		label: "Apply Retention",
		description: "Delete only expired, non-active audit/evidence/outbox records after an explicit preview and confirmation. Pending outbox work and active-run events are never deleted.",
		parameters: Type.Object({ project: Type.String(), confirm: Type.Boolean({ description: "Must be true after reviewing retention_policy_preview for the same project." }) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("retention_policy_apply: only planner may apply retention.");
			if (!params.confirm) throw new Error("retention_policy_apply: confirm must be true after reviewing retention_policy_preview.");
			const result = ensureMoaStorage().applyRetention(params.project);
			return { content: [{ type: "text" as const, text: `retention_policy_apply: deleted ${JSON.stringify(result.deleted)} for ${params.project}.` }], details: { result: redactRuntimeProjection(result) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("retention_policy_apply ")) + theme.fg("accent", (args as any).project ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", JSON.stringify((result.details as any)?.result?.deleted ?? {})), 0, 0); },
	});

	pi.registerTool({
		name: "benchmark_record",
		label: "Record Benchmark",
		description: "Record a reproducible benchmark result against versioned hard thresholds.",
		parameters: Type.Object({ project: Type.String(), name: Type.String(), dataset: Type.String(), metrics: Type.Record(Type.String(), Type.Number()), thresholds: Type.Record(Type.String(), Type.Number()) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("benchmark_record: only planner may record benchmarks.");
			const benchmark = ensureMoaStorage().recordBenchmark(params);
			return { content: [{ type: "text" as const, text: `benchmark_record: ${benchmark.name} ${benchmark.status}.` }], details: { benchmark: redactRuntimeProjection(benchmark) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("benchmark_record ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ ") + theme.fg("accent", (result.details as any)?.benchmark?.status ?? "?"), 0, 0); },
	});

	pi.registerTool({
		name: "governance_proposal_create",
		label: "Create Governance Proposal",
		description: "Create a sandboxed Playbook or role proposal with checksum and declared capabilities; never activates it.",
		parameters: Type.Object({ kind: Type.Union([Type.Literal("playbook"), Type.Literal("role")]), identifier: Type.String(), document: Type.String(), required_capabilities: Type.Optional(Type.Array(Type.String())) }),
		async execute(_callId, params) {
			if (!identity || (identity.role !== "planner" && identity.role !== "playbook-author" && identity.role !== "role-definition")) throw new Error("governance_proposal_create: role is not authorised.");
			const proposal = ensureMoaStorage().createGovernanceProposal(params) as any;
			return { content: [{ type: "text" as const, text: `governance_proposal_create: ${proposal.kind}/${proposal.identifier} sandboxed.` }], details: { proposal: redactRuntimeProjection(proposal) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_create ")) + theme.fg("accent", (args as any).identifier ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ sandbox"), 0, 0); },
	});

	pi.registerTool({
		name: "governance_proposal_validate",
		label: "Validate Governance Proposal",
		description: "Validate a sandboxed proposal before human approval.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "planner") throw new Error("governance_proposal_validate: only planner may validate proposals.");
			const proposal = ensureMoaStorage().validateGovernanceProposal(params.id) as any;
			return { content: [{ type: "text" as const, text: `governance_proposal_validate: ${proposal.id} validated.` }], details: { proposal: redactRuntimeProjection(proposal) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_validate ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ validated"), 0, 0); },
	});

	pi.registerTool({
		name: "governance_proposal_approve",
		label: "Approve Governance Proposal",
		description: "Approve a validated proposal as an immutable governance decision; approval does not mutate active runs.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
		async execute(_callId, params) {
			if (!identity || identity.role !== "user") throw new Error("governance_proposal_approve: explicit user approval is required.");
			const proposal = ensureMoaStorage().approveGovernanceProposal(params.id) as any;
			return { content: [{ type: "text" as const, text: `governance_proposal_approve: ${proposal.id} approved.` }], details: { proposal: redactRuntimeProjection(proposal) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_approve ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ approved"), 0, 0); },
	});

	pi.registerTool({
		name: "governance_proposal_reject",
		label: "Reject Governance Proposal",
		description: "Reject a sandboxed or validated governance proposal with an explicit reason; no active run is changed.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), reason: Type.String() }),
		async execute(_callId, params) {
			if (!identity || (identity.role !== "planner" && identity.role !== "user")) throw new Error("governance_proposal_reject: role is not authorised.");
			const proposal = ensureMoaStorage().rejectGovernanceProposal(params.id, params.reason) as any;
			return { content: [{ type: "text" as const, text: `governance_proposal_reject: ${proposal.id} rejected.` }], details: { proposal: redactRuntimeProjection(proposal) } };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("governance_proposal_reject ")) + theme.fg("accent", String((args as any).id ?? "?")), 0, 0); },
		renderResult(result, _options, theme) { return new Text(theme.fg("success", "→ rejected"), 0, 0); },
	});

	pi.registerTool({
		name: "package_manifest_audit",
		label: "Audit Package Manifest",
		description: "Audit package name, public yano binary and distributed Playbook assets, recording checksum and findings.",
		parameters: Type.Object({}),
		async execute(_callId, _params) {
			if (!identity || identity.role !== "planner") throw new Error("package_manifest_audit: only planner may audit the package.");
			const audit = ensureMoaStorage().auditPackageManifest();
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
			"as done or auto-requeued (automatic crash retry is deferred, see docs/development-notes.md Revisione 26).",
		parameters: Type.Object({ run_id: Type.String() }),
		async execute(_callId, params) {
			if (!identity) throw new Error("orchestrator not initialised");
			const storage = ensureMoaStorage();
			const run = storage.getRun(params.run_id);
			if (!run) throw new Error(`run_status: no run "${params.run_id}".`);
			const tickets = storage.listTickets(params.run_id);
			const deps = storage.listDependencies(params.run_id);
			const buckets = moaComputeReadyBlocked(tickets, deps);
			const waves = moaComputeExecutionWaves(tickets, deps);
			const events = storage.listEvents(params.run_id, { limit: 50 });
			const checkpoints = storage.listCheckpoints(params.run_id);
			const playbook_binding = redactRuntimeProjection(storage.getPlaybookBinding(params.run_id));
			const playbook_state = storage.getPlaybookRuntimeState(params.run_id);
			const playbook_evidence = storage.listPlaybookEvidence(params.run_id).map((item) => redactRuntimeProjection(item));
			const capability_cards = storage.listCapabilityCards(params.run_id).map((card) => redactRuntimeProjection(card));
			const playbook_effects = storage.listPlaybookEffects(params.run_id).map((effect) => redactRuntimeProjection(effect));
			const decision_holds = storage.listDecisionHolds(params.run_id).map((hold) => redactRuntimeProjection(hold));
			const stalled = moaFindStalledTickets(storage, identity.project, Date.now(), WATCHDOG_STALL_MS).filter((s) => s.run_id === params.run_id);
			const unfinalized = moaFindUnfinalizedRuns(storage, identity.project, Date.now(), WATCHDOG_FINALIZE_GRACE_MS).filter((r) => r.run_id === params.run_id);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`run "${run.id}" (${run.status}, domain: ${run.domain}): ${tickets.length} ticket(s) — ` +
							`${buckets.done.length} done, ${buckets.running.length} running, ${buckets.ready.length} ready, ${buckets.blocked.length} blocked, ${buckets.failed.length} failed.` +
							(stalled.length ? `\n⚠️ ${stalled.length} ticket bloccato/i: ${stalled.map((s) => `${s.ticket_id} (${Math.round(s.elapsed_ms / 60_000)} min, ${s.assigned_instance ?? "?"})`).join(", ")}.` : "") +
							(unfinalized.length ? `\n⚠️ run completato da ${Math.round(unfinalized[0].elapsed_ms / 60_000)} min senza finalize/notifica — verifica se worktree_finalize va ancora chiamato.` : ""),
					},
				],
				details: { run, tickets, dependencies: deps, ...buckets, waves, recent_events: events, checkpoints, playbook_binding, playbook_state, playbook_evidence, capability_cards, playbook_effects, decision_holds, stalled_tickets: stalled, unfinalized_run: unfinalized.length > 0 },
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
			const storage = ensureMoaStorage();
			const all = moaFindStalledTickets(storage, identity.project, Date.now(), WATCHDOG_STALL_MS);
			const stalled = params.run_id ? all.filter((s) => s.run_id === params.run_id) : all;
			const allUnfinalized = moaFindUnfinalizedRuns(storage, identity.project, Date.now(), WATCHDOG_FINALIZE_GRACE_MS);
			const unfinalized = params.run_id ? allUnfinalized.filter((r) => r.run_id === params.run_id) : allUnfinalized;
			const allOrphaned = moaFindOrphanedTickets(storage, identity.project, presence);
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
	// docs/development-notes.md, Revisione 48).
	pi.on("agent_end", async (_event, ctx) => {
		if (identity && identity.role === "planner") herdrReportAgent(identity.displayName, "idle", identity.instance);
		const inbound = [...inboundQueue.values()].reverse().find((i) => !i.fulfilled);
		// had_inbound:false è lo stesso segnale di before_agent_start's
		// had_pending_inbound, controllato di nuovo a fine turno: un turno che
		// finisce senza aver mai avuto un inbound da soddisfare è un turno che
		// l'agente ha fatto di propria iniziativa, non su assegnazione.
		logEvent("agent_end", { had_inbound: !!inbound, assignment_id: inbound?.assignment_id ?? null });
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
		if (!inbound || !client) return;

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
					client.publishAsync(T.agentStatus(identity.instance), JSON.stringify({ instance: identity.instance, role: identity.role, project: identity.project, status: "offline", last_heartbeat: nowIso() }), { qos: 1, retain: true }),
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
		if (moaStorage) {
			try { moaStorage.close(); } catch { /* ignore */ }
			moaStorage = null;
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
