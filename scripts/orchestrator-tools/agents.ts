// Fase 5 / M2 — agent_* tool handlers (7 of 8), extracted from
// extensions/orchestrator.ts. Fase 5/M6 completed the set by adding
// agent_send as the 8th, now that the plan-gate cluster it depends on
// (Fase 5/M1) is itself extracted — readPlan/findPhaseForRole/reportPath
// are imported directly (pure functions); requireWorktree/
// assertRoleHandoffAllowed close over identity via their own getter,
// already built once in orchestrator.ts, passed here as direct function
// references, same reasoning as worktree.ts/plan.ts (Fase 5/M3-M4).
// Deps: identity/client/T/mqttConnected/presenceHydration/currentInbound
// are `let`s reassigned elsewhere in orchestrator.ts (MQTT connect/
// reconnect, orchestrator_init, inbound dispatch), so each is injected as
// a getter — same pattern as every other Fase 4/5 module.
// presence/pendingReplies/activityLog are `const` Maps/Arrays (stable
// references, only their contents mutate) — passed directly, same pattern
// as Fase 4/M5's activeTicketIds. computeSelfStatus/currentLoad/logEvent/
// sendNotifications/agentStatusSnapshot/scheduleEviction are closure
// functions already correctly bound at their own definition site in
// orchestrator.ts — passed as direct references, no wrapping needed (same
// reasoning as ensureYanoStorage throughout Fase 4). `pi` (sendMessage/
// appendEntry) is passed the same way watchdog-sweep.ts (Fase 2/M3) does.
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { findPhaseForRole, readPlan, reportPath } from "./plan-gate.ts";
import type { Plan } from "./plan-gate.ts";

function nowIso(): string {
	return new Date().toISOString();
}

// Not exported from orchestrator.ts (a local `type` alias there) —
// duplicated here as a trivial one-liner, same call as
// scripts/orchestrator-tools/tickets.ts (Fase 4/M5).
type PresenceStatus = "idle" | "busy" | "offline";

export interface PresenceCard {
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

export interface ActivityEvent {
	channel: string; // "team:<name>" | "role:<name>" | "self"
	from: string;
	summary: string;
	timestamp: string;
}

export interface PendingReply {
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

export type TerminateEnvelope = {
	type: "terminate";
	requested_by_instance: string;
	requested_by_role: string;
	reason: string;
	timestamp: string;
};

const TIMEOUT_MS = Number(process.env.PI_ORCH_TIMEOUT_MS) || 1_800_000; // 30 min, mirrors coms.ts default
const DEFAULT_CONTROL_VERBS = ["status", "launch", "relaunch", "terminate"] as const;
const CONTROL_BINARIES = new Set(["herdr", "pi", "yano"]);
const MAX_HOPS = Number(process.env.PI_ORCH_MAX_HOPS) || 24;

// Same Crockford-base32 ULID generator used by coms.ts/coms-net.ts (and,
// verbatim, by orchestrator.ts's own local copy) — kept here too so
// assignment_id stays time-sortable without importing across modules for
// a dozen lines with zero closure.
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

// Not exported from orchestrator.ts (a local `type` alias there) —
// duplicated here as a trivial one-liner, same call as tickets.ts's
// PresenceStatus duplicate above.
type CommandEnvelope = {
	type: "command";
	assignment_id: string;
	sender_instance: string;
	sender_role: string;
	target_instance?: string;
	target_role?: string;
	project: string;
	prompt: string;
	reply_to: string;
	hops: number;
	timestamp: string;
	response_schema?: object | null;
};

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

type Identity = { role: string; cwd: string; project: string; instance: string; team: string[]; capacity?: number } | null;

export type AgentToolsDeps = {
	getIdentity: () => Identity;
	getClient: () => { publishAsync: (topic: string, payload: string, opts?: { qos?: number; retain?: boolean }) => Promise<unknown> } | null;
	getT: () => {
		teamEvents: (team: string) => string;
		agentCommands: (instance: string) => string;
		agentResponses: (instance: string) => string;
		roleTasks: (role: string) => string;
		agentFallback: () => string;
	} | null;
	getMqttConnected: () => boolean;
	getPresenceHydration: () => Promise<void>;
	getCurrentInbound: () => { hops: number } | null;
	presence: Map<string, PresenceCard>;
	pendingReplies: Map<string, PendingReply>;
	activityLog: ActivityEvent[];
	computeSelfStatus: () => PresenceStatus;
	currentLoad: () => number;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
	sendNotifications: (message: string) => Promise<{ ok: boolean; detail: string; channels: Record<string, { ok: boolean; detail: string }> }>;
	agentStatusSnapshot: () => string;
	scheduleEviction: (assignment_id: string) => void;
	requireWorktree: (slug: string) => { path: string; branch: string };
	assertRoleHandoffAllowed: (senderRole: string, targetRole: string, slug: string) => void;
	pi: {
		sendMessage: (message: unknown, opts?: unknown) => void;
		appendEntry: (kind: string, entry: unknown) => void;
	};
};

export function createAgentTools(deps: AgentToolsDeps) {
	const {
		getIdentity,
		getClient,
		getT,
		getMqttConnected,
		getPresenceHydration,
		getCurrentInbound,
		presence,
		pendingReplies,
		activityLog,
		computeSelfStatus,
		currentLoad,
		logEvent,
		sendNotifications,
		agentStatusSnapshot,
		scheduleEviction,
		requireWorktree,
		assertRoleHandoffAllowed,
		pi,
	} = deps;
	return [
		{
			name: "agent_control",
			label: "Agent Control",
			description: "Deterministic control-plane surface for status and allow-listed process operations. It never accepts free-form shell commands.",
			parameters: Type.Object({
				verb: Type.String(),
				target: Type.Optional(Type.String()),
				args: Type.Optional(Type.Array(Type.String())),
			}),
			async execute(_callId, params) {
				const identity = getIdentity();
				if (!identity) throw new Error("orchestrator not initialised");
				const policy = loadControlPolicy(identity.cwd);
				if (!policy.verbs.includes(params.verb)) throw new Error(`agent_control: verb "${params.verb}" is not in the allow-list.`);
				if (["launch", "relaunch", "terminate"].includes(params.verb) && identity.role !== "planner") {
					throw new Error(`agent_control: verb "${params.verb}" is planner-only.`);
				}
				if (params.verb === "status") {
					return { content: [{ type: "text" as const, text: `agent_control status: ${presence.size} peer(s), mqtt=${getMqttConnected() ? "connected" : "disconnected"}.` }], details: { verb: params.verb, peers: presence.size, mqtt_connected: getMqttConnected() } };
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
			renderCall(args: unknown, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("agent_control ")) + theme.fg("accent", `${(args as any).verb ?? "?"} ${(args as any).target ?? ""}`), 0, 0); },
			renderResult(result: any, _options: unknown, theme: Theme) { return new Text(theme.fg((result.details as any)?.ok === false ? "warning" : "success", `→ ${(result.details as any)?.verb ?? "?"}`), 0, 0); },
		},

		{
			name: "agent_list",
			label: "Agent List",
			description: "List the current agent and known peer instances (role, team, status) discovered via MQTT presence. The current instance is marked self=true and is not a valid delegation target. Presence is retained, so peers appear immediately even if they connected before you.",
			parameters: Type.Object({}),
			async execute() {
				// MQTT retained messages are delivered asynchronously after subscribe;
				// wait for the bounded initial hydration before exposing the roster.
				await getPresenceHydration();
				const identity = getIdentity();
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
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const agents = (result.details as any)?.agents ?? [];
				return new Text(theme.fg("accent", `⚡ ${agents.length} agent(s)`), 0, 0);
			},
		},

		{
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
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("agent_get ")) + theme.fg("warning", (args as any).assignment_id ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const status = (result.details as any)?.status ?? "?";
				const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
				return new Text(theme.fg(color, status), 0, 0);
			},
		},

		{
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
			renderCall(args: unknown, theme: Theme) {
				const assignmentId = String((args as any).assignment_id ?? "?");
				const target = pendingReplies.get(assignmentId)?.target ?? "?";
				return new Text(theme.fg("toolTitle", theme.bold("agent_await ")) + theme.fg("accent", target) + theme.fg("dim", " - ") + theme.fg("warning", assignmentId), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return d?.error ? new Text(theme.fg("error", `✗ ${d.error}`), 0, 0) : new Text(theme.fg("success", "✓ response received"), 0, 0);
			},
		},

		{
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
				const identity = getIdentity();
				const client = getClient();
				const T = getT();
				if (!identity || !client || !T) throw new Error("orchestrator not initialised");
				if (!identity.team.includes(params.team)) throw new Error(`agent_publish_event: not a member of team "${params.team}"`);
				await client.publishAsync(T.teamEvents(params.team), JSON.stringify({ from: identity.instance, summary: params.summary, timestamp: nowIso() }), { qos: 0 });
				return { content: [{ type: "text" as const, text: `published to team:${params.team}` }], details: { team: params.team } };
			},
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("agent_publish_event ")) + theme.fg("accent", (args as any).team ?? "?"), 0, 0);
			},
			renderResult(_result: unknown, _options: unknown, theme: Theme) {
				return new Text(theme.fg("success", "published"), 0, 0);
			},
		},

		{
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
			renderCall(_args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("agent_activity")), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const n = ((result.details as any)?.events ?? []).length;
				return new Text(theme.fg("accent", `⚡ ${n} event(s)`), 0, 0);
			},
		},

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
		{
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
				const identity = getIdentity();
				const client = getClient();
				const T = getT();
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
			renderCall(args: unknown, theme: Theme) {
				return new Text(theme.fg("toolTitle", theme.bold("agent_terminate ")) + theme.fg("accent", (args as any).target_instance ?? "?"), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				return new Text((d?.was_live ? theme.fg("warning", "⚠ ") : "") + theme.fg("success", "→ terminate inviato a ") + theme.fg("accent", d?.target ?? "?"), 0, 0);
			},
		},

		{
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
				const identity = getIdentity();
				const client = getClient();
				const T = getT();
				if (!identity || !client || !T) throw new Error("orchestrator not initialised");
				if (!params.target_instance && !params.target_role) throw new Error("agent_send: provide target_instance or target_role");
				const currentInbound = getCurrentInbound();
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
						const plan: Plan | null = readPlan(wt.path, params.slug);
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
			renderCall(args: unknown, theme: Theme) {
				const tgt = (args as any).target_instance || `role:${(args as any).target_role}` || "?";
				return new Text(theme.fg("toolTitle", theme.bold("agent_send ")) + theme.fg("accent", tgt), 0, 0);
			},
			renderResult(result: any, _options: unknown, theme: Theme) {
				const d = result.details as any;
				const base = theme.fg("success", "→ ") + theme.fg("accent", d?.target ?? "?") + theme.fg("dim", "  assignment_id ") + theme.fg("warning", d?.assignment_id ?? "?");
				return new Text(d?.no_live_target ? theme.fg("warning", "⚠ nessuna istanza online  ") + base : base, 0, 0);
			},
		},
	];
}
