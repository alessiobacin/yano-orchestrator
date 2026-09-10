// Fase 5 / M2 — agent_* tool handlers (7 of 8; agent_send stays in
// extensions/orchestrator.ts until Fase 5/M6, added here as the 8th
// handler once the plan-gate cluster it depends on is itself extracted).
// Zero coupling to the plan-gate cluster. Deps: identity/client/T/
// mqttConnected/presenceHydration are `let`s reassigned elsewhere in
// orchestrator.ts (MQTT connect/reconnect, orchestrator_init), so each is
// injected as a getter — same pattern as every other Fase 4/5 module.
// presence/pendingReplies/activityLog are `const` Maps/Arrays (stable
// references, only their contents mutate) — passed directly, same pattern
// as Fase 4/M5's activeTicketIds. computeSelfStatus/currentLoad/logEvent
// are closure functions already correctly bound at their own definition
// site in orchestrator.ts — passed as direct references, no wrapping
// needed (same reasoning as ensureYanoStorage/sendNotifications throughout
// Fase 4).
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

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
	getClient: () => { publishAsync: (topic: string, payload: string, opts?: { qos?: number }) => Promise<unknown> } | null;
	getT: () => { teamEvents: (team: string) => string; agentCommands: (instance: string) => string } | null;
	getMqttConnected: () => boolean;
	getPresenceHydration: () => Promise<void>;
	presence: Map<string, PresenceCard>;
	pendingReplies: Map<string, PendingReply>;
	activityLog: ActivityEvent[];
	computeSelfStatus: () => PresenceStatus;
	currentLoad: () => number;
	logEvent: (type: string, data?: Record<string, unknown>) => void;
};

export function createAgentTools(deps: AgentToolsDeps) {
	const { getIdentity, getClient, getT, getMqttConnected, getPresenceHydration, presence, pendingReplies, activityLog, computeSelfStatus, currentLoad, logEvent } = deps;
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
	];
}
