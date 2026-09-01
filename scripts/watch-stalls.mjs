#!/usr/bin/env node
// `yano watch` — zero-token stall watcher (Ticket 04).
//
// A standalone detector that runs OUTSIDE any `pi` session (no LLM context at
// all — this process never calls an LLM). It periodically queries the local
// orchestrator.db for tickets stuck in "running" past a configured stall
// threshold and, when one is found:
//   - publishes a `ticket_stalled` event on the run's MQTT event topic
//     (pi/<project>/runs/<run>/events) so any live planner/widget sees it,
//   - appends a JSONL marker to the workspace logs area, and
//   - optionally sends a WhatsApp tripwire (same env contract as the extension).
//
// Why it exists: the in-process watchdog (Revisione 29) only runs while a
// planner instance is alive. `yano watch` detaches detection+alerting from any
// live session — pure Node + sqlite + mqtt, zero tokens. It does NOT judge
// (lento vs bloccato) and does NOT act on the ticket: surfacing/pinging/
// failing stays the planner's decision (resumability contract). Idempotent:
// it only reads SQLite and appends markers.
//
// Complementary, not a replacement: keep the in-process watchdog for the
// planner's own wake; run `yano watch` in a Herdr pane as a
// detached tripwire so stalls are still surfaced when no planner is open.
//
// Uso:
//   yano watch [--project <slug>] [--project-root <dir>]
//              [--lookback-ms 86400000] [--stall-ms 900000]
//              [--interval-ms 60000] [--once] [--away]
//              [--context-compact-ratio 0.82]
//              [--validation-run <id>] [--playbook-proposal <id>]
//   (in locale: node scripts/watch-stalls.mjs [stesse opzioni])
//
// Away-mode (Ticket 07): con `--away` il watcher assorbe il rumore di routine
// (una passata senza stall è silenziosa) e alza SOLO le decisioni vere (uno o
// più stall), incluse le notifiche WhatsApp. Nessun LLM extra — è il filtro di
// priorità in pura logica.
//
// Oppure `--away` può essere guidato da env: quando PI_ORCH_AWAY=1 la routine
// viene assorbita allo stesso modo, così il watcher può essere lanciato una
// volta e rimanere silenzioso mentre l'operatore è lontano.

import { existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import mqtt from "mqtt";
import { canonicalProjectScope, readTraceRecords, tracePaths } from "./yano-trace-storage.mjs";
import { appendRawTraceRecord } from "./yano-trace-storage.mjs";
import { processYanoWatcherFindings, resolveYanoRepository, sendTelegramWatcherNotification } from "./yano-watcher-findings.mjs";
import { missingConfigError, resolveYanoConfig } from "./yano-config.mjs";
import { projectDbPath } from "./yano-project.mjs";

const yanoRequire = createRequire(import.meta.url);
let missingYanoRepoWarned = false;
const persistentWatcherRuntimes = new Map();

function watcherRuntimeKey(cwd, project) {
	return `${path.resolve(cwd)}\u0000${project}`;
}

function finalWatcherEvent(payload) {
	try {
		const event = JSON.parse(payload.toString());
		const type = event?.type || event?.payload?.type;
		return type === "run_completed" || type === "planner_task_completed";
	} catch {
		return false;
	}
}

function installFinalEventMonitor({ client, cwd, project, argv, packageRoot, runtime }) {
	if (!client || runtime.finalEventMonitorInstalled) return;
	runtime.finalEventMonitorInstalled = true;
	const topics = [`pi/${project}/runs/+/events`, `pi/${project}/agents/+/events`];
	const onMessage = (topic, payload) => {
		if (!finalWatcherEvent(payload)) return;
		let event = {};
		try { event = JSON.parse(payload.toString()); } catch { /* filtered above */ }
		try {
			appendRawTraceRecord({ cwd, project, record: {
				type: "yano_watcher_final_scan_requested",
				record_type: "event",
				source: "yano-watcher",
				instance: "yano-watcher",
				project,
				topic,
				event_type: event.type || event.payload?.type,
				run_id: event.run_id || null,
				reason: "task_or_run_completed",
			} });
		} catch { /* tracing must never block the watcher */ }
		if (runtime.finalScanTimer) return;
		runtime.finalScanTimer = setTimeout(() => {
			runtime.finalScanTimer = null;
			const finalArgv = [...argv.filter((arg) => arg !== "--once"), "--once"];
			runWatch({ cwd, argv: finalArgv, packageRoot }).catch((error) => {
			console.warn(`yano watch: scansione finale non riuscita — ${error instanceof Error ? error.message : String(error)}`);
			});
		}, 0);
	};
	try {
		client.on("message", onMessage);
		client.subscribeAsync(topics, { qos: 0 }).catch(() => { /* best effort; cadence remains active */ });
	} catch { /* best effort */ }
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 4_000_000 });
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		return parsed?.result?.snapshot || parsed?.result || parsed;
	} catch { return null; }
}

function shellQuote(value) {
	return process.platform === "win32" ? `"${String(value).replaceAll('"', '\\"')}"` : `'${String(value).replaceAll("'", `\'"'"\'`)}'`;
}

// This is deliberately a Yano control-plane action, not an application
// mutation: a watcher may recover the missing coordinator, but it never edits
// the observed project. A fresh tab is used when Herdr has a stale planner
// pane; reusing a dead shell is the exact failure this path is meant to heal.
function spawnPlannerForFallback({ cwd, project }) {
	const snapshot = herdrSnapshot();
	let workspace = snapshot?.workspaces?.find((item) => item.label === project || (snapshot.panes || []).some((pane) => pane.workspace_id === item.workspace_id && path.resolve(pane.cwd || "") === path.resolve(cwd)));
	if (!workspace) {
		const created = spawnSync("herdr", ["workspace", "create", "--cwd", cwd, "--label", project, "--no-focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (created.status === 0) workspace = herdrSnapshot()?.workspaces?.find((item) => item.label === project);
	}
	if (workspace?.workspace_id) {
		const label = `planner-01-recovery-${Date.now().toString(36)}`.slice(0, 60);
		const createdTab = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", cwd, "--label", label, "--no-focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (createdTab.status === 0) {
			const refreshed = herdrSnapshot();
			const tab = refreshed?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === label);
			const pane = tab && refreshed?.panes?.find((item) => item.tab_id === tab.tab_id);
			if (pane?.pane_id) {
				const command = `yano start --instance planner-01 --role planner --project ${shellQuote(project)}`;
				const launched = spawnSync("herdr", ["pane", "run", pane.pane_id, command], { cwd, encoding: "utf8", maxBuffer: 1_000_000 });
				if (launched.status === 0) return { ok: true, method: "herdr", pane_id: pane.pane_id, tab_id: tab.tab_id, command };
			}
		}
	}
	// Herdr is optional for the control plane. If it is unavailable, keep the
	// recovery alive as a detached Yano process rather than dropping the
	// original message; it will still publish planner-01 presence on MQTT.
	try {
		const child = spawn("yano", ["start", "--instance", "planner-01", "--role", "planner", "--project", project], { cwd, detached: true, stdio: "ignore" });
		child.unref();
		return { ok: true, method: "detached-yano", command: `yano start --instance planner-01 --role planner --project ${project}` };
	} catch (error) {
		return { ok: false, method: "none", error: error instanceof Error ? error.message : String(error) };
	}
}

export async function handleAgentFallback({ client, cwd, project, packageRoot, payload }) {
	if (!payload || payload.type !== "agent_route_fallback" || payload.project !== project || !payload.original) return;
	const original = payload.original;
	let planners = await discoverLiveAgents(client, project);
	let livePlanners = planners.filter((agent) => agent.role === "planner");
	let recovery = null;
	if (!livePlanners.length) {
		recovery = spawnPlannerForFallback({ cwd, project });
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && !livePlanners.length) {
			await new Promise((resolve) => setTimeout(resolve, 350));
			planners = await discoverLiveAgents(client, project);
			livePlanners = planners.filter((agent) => agent.role === "planner");
		}
	}
	let delivered = 0;
	for (const planner of livePlanners) {
		try {
			const envelope = {
				...original,
				target_instance: planner.instance,
				target_role: "planner",
				prompt: `[yano-routing] Destinatario originale offline: ${payload.original_target || "?"}. Il watcher ha recuperato il coordinatore: prendi in carico questo messaggio, informa il mittente e decidi se rilanciare o sostituire l'agente.\n\n${original.prompt}`,
				reply_to: original.reply_to || `pi/${project}/agents/${original.sender_instance}/responses`,
				hops: Number(original.hops || 0),
				fallback_for: payload.original_target || null,
				routed_by: "yano-watcher",
			};
			await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify(envelope), { qos: 1 });
			delivered++;
		} catch { /* best effort; next planner or next scan can retry */ }
	}
	try {
		await client.publishAsync(`pi/${project}/system/agent-fallback`, "", { qos: 1, retain: true });
	} catch { /* best effort */ }
	try {
		appendRawTraceRecord({ cwd, project, record: {
			type: "yano_watcher_agent_fallback_route",
			record_type: "event",
			source: "yano-watcher",
			instance: "yano-watcher",
			project,
			fallback_id: payload.fallback_id || null,
			original_target: payload.original_target || null,
			planner_instances: livePlanners.map((agent) => agent.instance),
			delivered,
			recovery,
			status: delivered ? "delivered" : "blocked",
		} });
	} catch { /* tracing must never block recovery */ }
	if (delivered) console.log(`yano watch: delega fallback inoltrata a ${livePlanners.map((agent) => agent.instance).join(", ")}.`);
		else console.warn(`yano watch: impossibile consegnare il fallback al planner del progetto "${project}"; il messaggio resta tracciato.`);
}

function installAgentFallbackMonitor({ client, cwd, project, packageRoot, runtime }) {
	if (!client || runtime.agentFallbackMonitorInstalled) return;
	runtime.agentFallbackMonitorInstalled = true;
	const topic = `pi/${project}/system/agent-fallback`;
	const onMessage = (_topic, payload) => {
		try {
			const parsed = JSON.parse(payload.toString());
			if (parsed?.type === "agent_route_fallback") void handleAgentFallback({ client, cwd, project, packageRoot, payload: parsed });
		} catch { /* malformed/clear-retained payload */ }
	};
	try {
		client.on("message", onMessage);
		client.subscribeAsync(topic, { qos: 1 }).catch(() => { /* cadence remains active */ });
	} catch { /* best effort */ }
}

function parseArgs(argv) {
	const o = { project: null, projectRoot: null, lookbackMs: 86_400_000, stallMs: 900000, intervalMs: 60000, once: false, away: false, contextCompactRatio: Number(process.env.YANO_WATCH_CONTEXT_COMPACT_RATIO) || 0.82, validationRun: null, playbookProposal: null, playbookId: null, playbookChecksum: null, validationRound: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--project") o.project = argv[++i];
		else if (a === "--project-root") o.projectRoot = argv[++i];
		else if (a === "--lookback-ms") o.lookbackMs = Number(argv[++i]);
		else if (a === "--stall-ms") o.stallMs = Number(argv[++i]);
		else if (a === "--interval-ms") o.intervalMs = Number(argv[++i]);
		else if (a === "--once") o.once = true;
		else if (a === "--away" || a === "-aw") o.away = true;
		else if (a === "--context-compact-ratio") o.contextCompactRatio = Number(argv[++i]);
		else if (a === "--validation-run") o.validationRun = argv[++i];
		else if (a === "--playbook-proposal") o.playbookProposal = argv[++i];
		else if (a === "--playbook-id") o.playbookId = argv[++i];
		else if (a === "--playbook-checksum") o.playbookChecksum = argv[++i];
		else if (a === "--validation-round") o.validationRound = argv[++i];
	}
	return o;
}

function hasValidationContext(opts) {
	return Boolean(opts.validationRun || opts.playbookProposal || opts.playbookId || opts.playbookChecksum || opts.validationRound);
}

const CONVERSATION_FORBIDDEN_TOOLS = new Set([
	"orchestrator_init",
	"worktree_create",
	"worktree_finalize",
	"worktree_abandon",
	"run_create",
	"spec_create",
	"ticket_create",
	"plan_set",
	"plan_advance",
	"report_append",
]);

// The redirection branch deliberately requires a shell boundary/whitespace
// before `>` or `<`; otherwise harmless quoted HTML selectors such as
// `grep '<title>'` look like filesystem writes.
const CONVERSATION_MUTATING_COMMAND = /(?:\b(?:git\s+(?:init|add|commit|checkout|switch|merge|worktree|branch\s+(?:-d|-D|--delete))|yano\s+init)\b|(?:^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|install)\s+|(?:^|[;&|\s])\d*>>?\s*(?:[~./$A-Za-z_]))/i;
const DEBATE_INTENT = /\b(?:debat(?:e|ing)?|dibattit(?:o|i)|second\s+opinion|seconda\s+opinione|confronta\s+(?:le\s+)?prospettive|pro\s+e\s+contro|pros\s+and\s+cons|multi[- ]model\s+(?:discussion|debate)|discussione\s+multi[- ]modello)\b/i;
const DEBATER_INSTANCE = /^debater(?:-|$)/i;
const CONVERSATION_RESEARCHER_INSTANCE = /^conversation-researcher(?:-|$)/i;
const REPO_BENCHMARKER_INSTANCE = /^repo-benchmarker(?:-|$)/i;
const CONFIRMATION_REQUEST = /(?:conferma|confermi|approv(?:i|azione)|posso\s+(?:continuare|procedere)|procedere\s+con\s+questo\s+roster)/i;
const USER_CONFIRMATION = /\b(?:s[iì]|yes|ok|confermo|confermiamo|approvo|procedi|continua|vai\s+pure)\b/i;
const GET_BEST_FROM_INTENT = /\bget-the-best-from\b|(?:confront|compare|benchmark|learn from|ispirat)[^\n]{0,180}(?:repo|repository|progetto|github)/i;
const REPO_BENCHMARKER_MUTATING_COMMAND = /(?:\bgit\s+(?:add|commit|push|reset|clean|checkout|switch|merge|worktree|branch\s+(?:-d|-D|--delete))\b|(?:^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|install)\s+|(?:^|[;&|\s])\d*>>?\s*[~./$A-Za-z_])/i;

function branchMessages(record) {
	const branch = record.branch || record.data?.branch || [];
	return Array.isArray(branch)
		? branch.map((entry) => entry?.message).filter((message) => message && typeof message === "object")
		: [];
}

function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((item) => item?.type === "text").map((item) => item.text).join(" ");
	return "";
}

function conversationFinding({ kind, record, instance, role, tool, command = null, expected, actual }) {
	const identity = [kind, instance || "?", tool || "?", record.tool_call_id || record.id || "?", command || ""].join("|");
	return {
		signal: "conversation_policy_violation",
		fingerprint: crypto.createHash("sha256").update(identity).digest("hex"),
		severity: "high",
		category: "conversation-policy",
		summary: `Violazione del contratto conversation: ${actual}`,
		expected,
		actual,
		instance: instance || null,
		role: role || null,
		tool: tool || null,
		command: command || null,
		record_id: record.tool_call_id || record.id || null,
		ts: record.ts || null,
	};
}

// Inspect the trace without an LLM. This is intentionally conservative: it
// checks only explicit forbidden Yano tools and shell commands that mutate
// Git/filesystem state. Ordinary reads (git status, curl GET, grep, yano
// trace, agent_list) remain valid conversation evidence.
export function inspectConversationPolicy(records = []) {
	const roleByInstance = new Map();
	const calls = new Map();
	const findings = [];
	let conversationEvidence = false;
	for (const record of records) {
		if (record.type === "session_start" && record.instance && record.role) roleByInstance.set(record.instance, record.role);
		if (record.type === "agent_send_out" && /^conversation-researcher(?:-|$)/.test(String(record.target || ""))) conversationEvidence = true;
		if (record.role === "conversation-researcher" || /^conversation-researcher(?:-|$)/.test(String(record.instance || ""))) conversationEvidence = true;
		if (record.type === "tool_execution_start" || record.type === "tool_execution_start_payload") {
			const id = record.tool_call_id;
			if (id) calls.set(id, { ...(calls.get(id) || {}), tool: record.tool, command: record.args?.command || null, instance: record.instance, role: record.role });
		}
		if (record.type !== "tool_execution_end") continue;
		const call = calls.get(record.tool_call_id) || {};
		const instance = record.instance || call.instance;
		const role = record.role || call.role || roleByInstance.get(instance);
		const tool = record.tool || call.tool;
		const command = call.command;
		const isConversationAgent = role === "planner" || role === "conversation-researcher" || /^conversation-researcher(?:-|$)/.test(String(instance || ""));
		if (!isConversationAgent) continue;
		const forbiddenConversationTool = role === "conversation-researcher"
			? CONVERSATION_FORBIDDEN_TOOLS.has(tool)
			: role === "planner" && CONVERSATION_FORBIDDEN_TOOLS.has(tool) && tool !== "orchestrator_init";
		if (forbiddenConversationTool) {
			findings.push(conversationFinding({
				kind: "forbidden-tool",
				record,
				instance,
				role,
				tool,
				expected: "Il playbook conversation usa solo metadata Yano e consulti read-only; nessun tool di consegna o orchestrator_init dal researcher.",
				actual: `${role} ha chiamato ${tool}`,
			}));
		}
		if (role === "conversation-researcher" && tool === "bash" && command && CONVERSATION_MUTATING_COMMAND.test(command)) {
			findings.push(conversationFinding({
				kind: "mutating-shell",
				record,
				instance,
				role,
				tool,
				command,
				expected: "Il conversation-researcher deve restare read-only e non modificare Git o il filesystem del progetto.",
				actual: `conversation-researcher ha eseguito un comando potenzialmente mutante: ${command.slice(0, 240)}`,
			}));
		}
		if (record.ok === false && command && /\b(?:herdr\s+agent\s+start|yano\s+start)\b/i.test(command)) {
			findings.push(conversationFinding({
				kind: "launch-failure",
				record,
				instance,
				role,
				tool,
				command,
				expected: "Il lancio dello specialista deve riuscire senza errori di runtime.",
				actual: `il lancio di un agente conversation ha fallito: ${command.slice(0, 240)}`,
			}));
		}
	}
	return { conversationEvidence, findings };
}

function debateFinding({ kind, record, expected, actual, instance = null, role = null, tool = null }) {
	const identity = [kind, instance || "?", tool || "?", record.tool_call_id || record.id || "?"].join("|");
	return {
		signal: "debate_policy_violation",
		fingerprint: crypto.createHash("sha256").update(identity).digest("hex"),
		severity: "high",
		category: "debate-policy",
		summary: `Violazione del contratto debate: ${actual}`,
		expected,
		actual,
		instance,
		role,
		tool,
		record_id: record.tool_call_id || record.id || null,
		ts: record.ts || null,
		kind,
	};
}

function recordText(record) {
	return [
		record.args?.command,
		record.args?.prompt,
		record.prompt_preview,
		record.text,
		record.result?.content?.map?.((item) => item.text).join(" "),
		...branchMessages(record).map(messageText),
	].filter(Boolean).join(" ");
}

// Only explicit user/planner intent and debate routing signals can activate
// the debate contract. Tool results are deliberately excluded: a catalog or
// help response commonly lists the word "debate" as one of several options,
// which is not evidence that the current task is a debate.
function debateIntentText(record) {
	if (record.type === "visible_session_branch") {
		return branchMessages(record)
			.filter((message) => message.role === "user" || (message.role === "assistant" && CONFIRMATION_REQUEST.test(messageText(message))))
			.map(messageText)
			.join(" ");
	}
	if (record.type === "assistant_response" || record.type === "user_message") return [record.text, record.prompt, record.prompt_preview].filter(Boolean).join(" ");
	if (record.type === "agent_send_out") return [record.prompt, record.prompt_preview].filter(Boolean).join(" ");
	if (record.type === "session_start" && (record.role === "debater" || DEBATER_INSTANCE.test(String(record.instance || "")))) return "debater";
	if ((record.type === "tool_execution_start" || record.type === "tool_execution_start_payload") && /(?:--task|--prompt)\s+/.test(String(record.args?.command || ""))) return String(record.args.command);
	return "";
}

export function inspectProjectScope(records = [], canonicalProject) {
	const latestStarts = new Map();
	for (const record of records) {
		if (record.source === "yano-watcher" || record.instance === "yano-watcher") continue;
		if (record.type !== "session_start" || !record.instance) continue;
		latestStarts.set(record.instance, record);
	}
	const mismatches = [...latestStarts.values()].filter((record) =>
		record.project_scope_override === true &&
		record.default_project === canonicalProject &&
		record.project && record.project !== canonicalProject,
	);
	const findings = mismatches.map((record) => {
		const identity = `${record.instance}|${record.project}|${canonicalProject}`;
		return {
			signal: "project_scope_mismatch",
			fingerprint: crypto.createHash("sha256").update(identity).digest("hex"),
			severity: "high",
			category: "routing",
			summary: `L'istanza ${record.instance} usa uno scope MQTT diverso da quello canonico del progetto.`,
			expected: `Tutte le istanze della root devono usare lo scope ${canonicalProject}.`,
			actual: `${record.instance} usa ${record.project}, mentre la root risolve ${canonicalProject}.`,
			instance: record.instance,
			role: record.role || null,
			project: record.project,
			canonical_project: canonicalProject,
			record_id: record.id || null,
			ts: record.ts || null,
			kind: "mqtt-project-scope-mismatch",
		};
	});
	return { scopeEvidence: mismatches.length > 0, mismatches, findings };
}

// Deterministic contract check for the multi-agent debate path. It does not
// judge the quality of an argument; it only catches a routing failure that a
// generic "conversation" health check cannot see (wrong specialist, missing
// minimum roster, or no model-advisor proposal before completion).
export function inspectDebatePolicy(records = [], { completed = false, initialized = true } = {}) {
	const debaters = new Set();
	const conversationResearchers = new Set();
	let debateEvidence = false;
	let modelAdvisorCalls = 0;
	let firstDebateEvidence = null;
	let confirmationRequested = false;
	let userConfirmation = false;
	let debaterLaunch = false;
	const modelRuntimeFailures = [];
	const modelRuntimeFailureKeys = new Set();

	for (const record of records) {
		if (record.source === "yano-watcher" || record.instance === "yano-watcher") continue;
		const text = debateIntentText(record);
		if (DEBATE_INTENT.test(text)) {
			debateEvidence = true;
			firstDebateEvidence ||= record;
		}
		if ((record.role === "debater" || DEBATER_INSTANCE.test(String(record.instance || ""))) && /(?:is returning|restituisce|restituendo|returning)\s*:\s*[45]\d\d/i.test(text)) {
			const failure = text.match(/(?:is returning|restituisce|restituendo|returning)\s*:\s*[45]\d\d/i)?.[0] || "model-error";
			const failureKey = `${record.instance || "?"}|${failure}`;
			if (!modelRuntimeFailureKeys.has(failureKey)) {
				modelRuntimeFailureKeys.add(failureKey);
				modelRuntimeFailures.push(record);
			}
		}
		for (const message of branchMessages(record)) {
			const messageBody = messageText(message);
			if (message.role === "assistant" && CONFIRMATION_REQUEST.test(messageBody) && DEBATE_INTENT.test(messageBody)) confirmationRequested = true;
			if (message.role === "user" && USER_CONFIRMATION.test(messageBody) && !/\b(?:non|not|don't|non\s+voglio)\b/i.test(messageBody)) userConfirmation = true;
		}
		if (record.type === "session_start" && (DEBATER_INSTANCE.test(String(record.instance || "")) || record.role === "debater")) {
			debaters.add(record.instance || `debater-${debaters.size + 1}`);
			debaterLaunch = true;
		}
		if (record.type === "agent_send_out") {
			const target = String(record.target || record.target_instance || "");
			if (DEBATER_INSTANCE.test(target)) {
				debaters.add(target);
				debaterLaunch = true;
			}
			if (CONVERSATION_RESEARCHER_INSTANCE.test(target)) {
				conversationResearchers.add(target);
				// A wrongly routed specialist is still a launch attempt: the
				// debate confirmation gate must reject it as well.
				debaterLaunch = true;
			}
		}
		if (record.role === "debater" || DEBATER_INSTANCE.test(String(record.instance || ""))) debaters.add(record.instance || `debater-${debaters.size + 1}`);
		if (record.role === "conversation-researcher" || CONVERSATION_RESEARCHER_INSTANCE.test(String(record.instance || ""))) conversationResearchers.add(record.instance || "conversation-researcher");
		if (/\byano\s+model-advisor\s+recommend\b/i.test(record.args?.command || "")) modelAdvisorCalls++;
	}

	if (!debateEvidence) return { debateEvidence: false, findings: [], debaters: [...debaters], conversationResearchers: [...conversationResearchers], modelAdvisorCalls };
	const findings = [];
	if (!initialized) {
		findings.push(debateFinding({
			kind: "missing-orchestrator-init",
			record: firstDebateEvidence || { id: "debate-before-init" },
			expected: "Il planner deve chiamare orchestrator_init prima di framing, proposta, lancio o delega di un debate.",
			actual: "il trace contiene un debate ma il progetto non ha ancora orchestrator.db",
		}));
	}
	for (const record of modelRuntimeFailures) {
		findings.push(debateFinding({
			kind: "model-runtime-fallback",
			record,
			instance: record.instance || null,
			expected: "Se il modello pinnato fallisce, il planner deve verificare il fallback llmproxy, dichiararlo nel report e decidere se rilanciare o sostituire il modello.",
			actual: `il trace segnala un errore del modello pinnato e un fallback runtime: ${recordText(record).match(/.{0,120}(?:is returning|restituisce|restituendo|returning)\s*:\s*[45]\d\d.{0,160}/i)?.[0] || "errore provider/modello"}`,
		}));
	}
	for (const record of records) {
		if (record.source === "yano-watcher" || record.instance === "yano-watcher") continue;
		const target = String(record.target || record.target_instance || "");
		if (record.type === "agent_send_out" && CONVERSATION_RESEARCHER_INSTANCE.test(target)) {
			findings.push(debateFinding({
				kind: "wrong-specialist",
				record,
				instance: target,
				role: "conversation-researcher",
				expected: "Un intent debate deve usare almeno due istanze debater; conversation-researcher non è un sostituto del roster debate.",
				actual: `il planner ha delegato un dibattito a ${target}`,
			}));
		}
	}
	if (completed && debaters.size < 2) {
		findings.push(debateFinding({
			kind: "insufficient-debaters",
			record: firstDebateEvidence || { id: "debate-completion" },
			expected: "Il playbook debate deve lanciare e attendere almeno due debater prima della sintesi finale.",
			actual: `il flusso è terminato con ${debaters.size} debater`,
		}));
	}
	if (completed && debaters.size >= 2 && modelAdvisorCalls === 0) {
		findings.push(debateFinding({
			kind: "missing-model-proposal",
			record: firstDebateEvidence || { id: "debate-model-proposal" },
			expected: "Prima del lancio il planner deve proporre un modello per ogni debater tramite yano model-advisor, dichiarando eventuale degradazione.",
			actual: "nessuna chiamata yano model-advisor recommend è presente nel trace del dibattito",
		}));
	}
	if (completed && debaterLaunch && (!confirmationRequested || !userConfirmation)) {
		findings.push(debateFinding({
			kind: "missing-user-confirmation",
			record: firstDebateEvidence || { id: "debate-confirmation" },
			expected: "Prima del lancio deve esistere una proposta del roster/model@provider-id e una conferma esplicita dell'utente; le modifiche richieste riaprono il gate.",
			actual: `confirmation_requested=${confirmationRequested}, user_confirmed=${userConfirmation}`,
		}));
	}
	return { debateEvidence: true, findings, debaters: [...debaters], conversationResearchers: [...conversationResearchers], modelAdvisorCalls, confirmationRequested, userConfirmation, modelRuntimeFailures: modelRuntimeFailures.length };
}

function getBestFromIntentText(record) {
	if (record.type === "visible_session_branch") {
		return branchMessages(record)
			.filter((message) => message.role === "user" || (message.role === "assistant" && /get-the-best-from|repo-benchmarker|confront|compare|benchmark/i.test(messageText(message))))
			.map(messageText)
			.join(" ");
	}
	if (record.type === "assistant_response" || record.type === "user_message") return [record.text, record.prompt, record.prompt_preview].filter(Boolean).join(" ");
	if (record.type === "agent_send_out") return [record.prompt, record.prompt_preview].filter(Boolean).join(" ");
	if ((record.type === "tool_execution_start" || record.type === "tool_execution_start_payload") && /(?:--task|--prompt)\s+/.test(String(record.args?.command || ""))) return String(record.args.command);
	return "";
}

function getBestFromFinding({ kind, record, expected, actual, instance = null, role = null, tool = null }) {
	const identity = [kind, instance || "?", tool || "?", record.tool_call_id || record.id || "?"].join("|");
	return {
		signal: "get_best_from_policy_violation",
		fingerprint: crypto.createHash("sha256").update(identity).digest("hex"),
		severity: "high",
		category: "get-best-from-policy",
		summary: `Violazione del contratto get-the-best-from: ${actual}`,
		expected,
		actual,
		instance,
		role,
		tool,
		record_id: record.tool_call_id || record.id || null,
		ts: record.ts || null,
		kind,
	};
}

// Deterministic contract check for comparative repository benchmarking. The
// watcher does not assess the quality of the comparison; it verifies the
// observable safety gates: two independent benchmarkers, model proposals
// before completion, both analyses ending before the planner synthesis, and
// no mutating shell command from a benchmarker.
export function inspectGetBestFromPolicy(records = [], { completed = false } = {}) {
	const benchmarkers = new Set();
	const benchmarkerEnds = new Map();
	const findings = [];
	let evidence = false;
	let modelAdvisorCalls = 0;
	let finalPlannerResponse = null;
	let plannerEnd = null;
	for (const record of records) {
		if (record.source === "yano-watcher" || record.instance === "yano-watcher") continue;
		const instance = String(record.instance || "");
		const target = String(record.target || record.target_instance || "");
		const intentText = getBestFromIntentText(record);
		if (GET_BEST_FROM_INTENT.test(intentText)) evidence = true;
		if (record.role === "repo-benchmarker" || REPO_BENCHMARKER_INSTANCE.test(instance)) {
			evidence = true;
			if (instance) benchmarkers.add(instance);
			if (record.type === "agent_end") benchmarkerEnds.set(instance, record);
			if ((record.type === "tool_execution_start_payload" || record.type === "tool_execution_start") && record.tool === "bash" && REPO_BENCHMARKER_MUTATING_COMMAND.test(String(record.args?.command || ""))) {
				findings.push(getBestFromFinding({
					kind: "mutating-shell",
					record,
					instance,
					role: record.role || "repo-benchmarker",
					tool: record.tool,
					expected: "repo-benchmarker deve analizzare in sola lettura e non modificare Git o il filesystem del progetto.",
					actual: `repo-benchmarker ha eseguito un comando potenzialmente mutante: ${String(record.args?.command || "").slice(0, 240)}`,
				}));
			}
		}
		if (record.type === "agent_send_out" && REPO_BENCHMARKER_INSTANCE.test(target)) {
			evidence = true;
			benchmarkers.add(target);
		}
		if (/\byano\s+model-advisor\s+recommend\b/i.test(String(record.args?.command || ""))) modelAdvisorCalls++;
		if (record.type === "assistant_response" && record.role === "planner" && /side[- ]by[- ]side|sintesi comparativa|confronto comparativo|report finale/i.test(String(record.text || ""))) finalPlannerResponse = record;
		if (record.type === "agent_end" && record.role === "planner") plannerEnd = record;
	}
	if (!evidence) return { getBestFromEvidence: false, findings: [], benchmarkers: [], modelAdvisorCalls };
	if (completed && benchmarkers.size < 2) {
		findings.push(getBestFromFinding({
			kind: "insufficient-benchmarkers",
			record: finalPlannerResponse || plannerEnd || { id: "get-best-from-completion" },
			expected: "Il playbook deve lanciare e attendere due repo-benchmarker indipendenti, uno per ciascun repository.",
			actual: `il flusso è terminato con ${benchmarkers.size} repo-benchmarker`,
		}));
	}
	if (completed && modelAdvisorCalls === 0) {
		findings.push(getBestFromFinding({
			kind: "missing-model-proposal",
			record: finalPlannerResponse || plannerEnd || { id: "get-best-from-model-proposal" },
			expected: "Prima del lancio il planner deve proporre i modelli tramite yano model-advisor e conservarne il pin nel framing.",
			actual: "nessuna chiamata yano model-advisor recommend è presente nel trace",
		}));
	}
	if (completed && benchmarkers.size >= 2) {
		const incomplete = [...benchmarkers].filter((instance) => !benchmarkerEnds.has(instance));
		if (incomplete.length) findings.push(getBestFromFinding({
			kind: "incomplete-analysis",
			record: finalPlannerResponse || plannerEnd || { id: "get-best-from-analysis" },
			expected: "La sintesi deve iniziare solo dopo la conclusione di entrambe le analisi cieche.",
			actual: `manca il marker agent_end per: ${incomplete.join(", ")}`,
		}));
		if (finalPlannerResponse && plannerEnd) {
			const synthesisAt = new Date(finalPlannerResponse.ts || plannerEnd.ts || 0).getTime();
			const late = [...benchmarkerEnds.entries()].filter(([, record]) => new Date(record.ts || 0).getTime() > synthesisAt).map(([instance]) => instance);
			if (late.length) findings.push(getBestFromFinding({
				kind: "comparison-before-analyses-complete",
				record: finalPlannerResponse,
				expected: "Le due analisi devono essere terminate prima della sintesi side-by-side.",
				actual: `la sintesi del planner precede la conclusione di: ${late.join(", ")}`,
			}));
		}
		if (finalPlannerResponse && !/(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+:\d+)/.test(String(finalPlannerResponse.text || ""))) findings.push(getBestFromFinding({
			kind: "missing-citations",
			record: finalPlannerResponse,
			expected: "La sintesi deve contenere citazioni concrete file:riga per le evidenze e i candidati d'importazione.",
			actual: "la risposta finale non contiene citazioni file:riga riconoscibili",
		}));
	}
	return { getBestFromEvidence: true, findings, benchmarkers: [...benchmarkers], modelAdvisorCalls };
}

export function watchUsage() {
	return [
		"Uso: yano watch [opzioni]",
		"",
		"  --project <slug>                 nome del progetto osservato",
		"  --project-root <dir>             root del progetto osservato",
		"  --lookback-ms <ms>               finestra temporale della scansione",
		"  --stall-ms <ms>                  soglia per un ticket stalled",
		"  --interval-ms <ms>               intervallo del polling persistente",
		"  --context-compact-ratio <0..1>   soglia watcher per compaction automatica (default 0.82; env YANO_WATCH_CONTEXT_COMPACT_RATIO)",
		"  --once                           esegue una sola scansione e termina",
		"  --away                           nasconde gli heartbeat senza finding",
		"  --help, -h                       mostra questo messaggio",
	].join("\n");
}

function scheduleNextPass({ cwd, argv, packageRoot }) {
	const intervalIndex = argv.indexOf("--interval-ms");
	const intervalMs = intervalIndex >= 0 ? Number(argv[intervalIndex + 1]) : 60000;
	if (argv.includes("--once") || !(intervalMs > 0)) return false;
	setTimeout(() => {
		runWatch({ cwd, argv, packageRoot }).catch((error) => {
			console.error(`yano watch: errore nel polling — ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		});
	}, intervalMs);
	return true;
}

function appendWatcherScan({ cwd, project, opts, startedAt, status, reason = null, stalls = 0, findings = 0, liveAgents = 0, livePlanners = 0 }) {
	const completedAtMs = Date.now();
	const completedAt = new Date(completedAtMs).toISOString();
	const entry = {
		ts: completedAt,
		type: "yano_watcher_scan",
		record_type: "event",
		source: "yano-watcher",
		instance: "yano-watcher",
		scan_id: crypto.randomUUID(),
		started_at: startedAt,
		completed_at: completedAt,
		duration_ms: Math.max(0, completedAtMs - new Date(startedAt).getTime()),
		mode: hasValidationContext(opts) ? "validation" : "continuous",
		once: opts.once,
		interval_ms: opts.intervalMs,
		lookback_ms: opts.lookbackMs,
		stall_ms: opts.stallMs,
		away: awayEnabled(opts),
		status,
		reason,
		stalls,
		findings,
		live_agents: liveAgents,
		live_planners: livePlanners,
		validation_run_id: opts.validationRun || null,
		proposal_id: opts.playbookProposal || null,
		playbook_id: opts.playbookId || null,
	};
	try { appendRawTraceRecord({ cwd, project, record: entry }); } catch { /* tracing must never block the watcher */ }
	return entry;
}

function resolveProject(cwd) {
	const cfgPath = path.join(cwd, ".pi", "extensions", "yano-orchestrator", "config", "project.json");
	try {
		const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
		if (cfg.project) return cfg.project;
	} catch { /* fallthrough */ }
	try {
		const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8"));
		if (pkg.name && !String(pkg.name).startsWith("@otomatik/yano-")) return pkg.name;
	} catch { /* fallthrough */ }
	return path.basename(cwd);
}

export async function runWatch({ cwd, argv, packageRoot = null }) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(watchUsage());
		return { help: true };
	}
	// `argv` is already the post-slice argument vector (script/import callers
	// pass process.argv.slice(2) or `--once --project ...`); parseArgs iterates
	// it directly, matching runEndProject's convention.
	const opts = parseArgs(argv);
	const startedAt = new Date().toISOString();
	const watchCwd = opts.projectRoot ? path.resolve(opts.projectRoot) : cwd;
	const project = canonicalProjectScope(watchCwd, opts.project || resolveProject(watchCwd));
	const effectivePackageRoot = packageRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const config = resolveYanoConfig({ packageRoot: effectivePackageRoot });
	const yanoRepo = resolveYanoRepository({ packageRoot: effectivePackageRoot });
	if (!yanoRepo && !missingYanoRepoWarned) {
		missingYanoRepoWarned = true;
		console.warn("yano watch: YANO_ORCHESTRATOR_REPO non trovato nel .env di sviluppo né nella configurazione globale — se viene rilevato un difetto Yano, il comando mostrerà come configurarlo.");
	}

	const dbPath = projectDbPath(watchCwd, project);
	const brokerUrl = config.PI_ORCH_BROKER_URL || process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
	const persistent = !opts.once && opts.intervalMs > 0;
	const runtimeKey = watcherRuntimeKey(watchCwd, project);
	let runtime = persistentWatcherRuntimes.get(runtimeKey) || null;

	let client = runtime?.client || null;
	if (!client || (!client.connected && !client.reconnecting && runtime?.brokerUrl !== brokerUrl)) {
		try {
			client = mqtt.connect(brokerUrl);
			await new Promise((res, rej) => {
				const timeout = setTimeout(() => rej(new Error("timeout connessione broker")), 2_000);
				client.once("connect", () => { clearTimeout(timeout); res(); });
				client.once("error", (error) => { clearTimeout(timeout); rej(error); });
			});
		} catch (err) {
			try { client?.end(true); } catch { /* best effort */ }
			client = null;
			runtime = null;
			persistentWatcherRuntimes.delete(runtimeKey);
			console.warn(`yano watch: broker ${brokerUrl} non raggiungibile (${err instanceof Error ? err.message : String(err)}) — solo report locale.`);
		}
	}
	if (client && persistent) {
		runtime ||= { client, brokerUrl, finalEventMonitorInstalled: false, finalScanTimer: null };
		runtime.client = client;
		runtime.brokerUrl = brokerUrl;
		persistentWatcherRuntimes.set(runtimeKey, runtime);
		installFinalEventMonitor({ client, cwd: watchCwd, project, argv, packageRoot: effectivePackageRoot, runtime });
		installAgentFallbackMonitor({ client, cwd: watchCwd, project, packageRoot: effectivePackageRoot, runtime });
	}
	const sharedPersistentClient = Boolean(runtime && runtime.client === client);
	const liveAgents = await discoverLiveAgents(client, project);
	const livePlanners = liveAgents.filter((agent) => agent.role === "planner");

	// A normal persistent watcher is also used by conversation mode, where the
	// Planner may intentionally not have initialized the operational database.
	// That is a pending precondition, not a validation failure: stay alive and
	// retry without creating noise or sending a Telegram alert. Only an
	// explicitly supplied validation context is allowed to enter the blocked
	// route below.
	if (!existsSync(dbPath)) {
		// A debate is observable in the trace before the first operational ticket
		// exists. Do not let the conversation-mode "not initialized" fast path
		// hide a debate that already launched agents: the planner must call
		// orchestrator_init before framing or launching them. This remains
		// read-only; the watcher reports the violation but never creates the DB.
		const preDbTraceRecords = readTraceRecords({ cwd: watchCwd, project, since: new Date(Date.now() - Math.max(0, opts.lookbackMs)), limit: 100000 });
		const preDbDebateCheck = inspectDebatePolicy(preDbTraceRecords, {
			initialized: false,
			completed: preDbTraceRecords.some((record) => record.type === "agent_end" && record.role === "planner"),
		});
		if (preDbDebateCheck.debateEvidence) {
			const findings = preDbDebateCheck.findings;
			try {
				appendRawTraceRecord({ cwd: watchCwd, project, record: {
					type: "yano_watcher_debate_check",
					record_type: "event",
					source: "yano-watcher",
					instance: "yano-watcher",
					project,
					status: "violation",
					checked_at: new Date().toISOString(),
					violations: findings.length,
					orchestrator_db: false,
					debaters: preDbDebateCheck.debaters,
					conversation_researchers: preDbDebateCheck.conversationResearchers,
					model_advisor_calls: preDbDebateCheck.modelAdvisorCalls,
					model_runtime_failures: preDbDebateCheck.modelRuntimeFailures,
					confirmation_requested: preDbDebateCheck.confirmationRequested,
					user_confirmed: preDbDebateCheck.userConfirmation,
					message: "Il trace contiene un debate prima di orchestrator_init: il watcher segnala il difetto senza creare il DB.",
				} });
			} catch { /* tracing must never block the watcher */ }
			const routed = new Set(preDbTraceRecords
				.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "debate_policy_violation")
				.map((record) => record.fingerprint)
				.filter(Boolean));
			for (const finding of findings) {
				if (routed.has(finding.fingerprint)) continue;
				if (livePlanners.length && client) {
					for (const planner of livePlanners) {
						try {
							await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify({
								type: "command",
								assignment_id: `watcher-${crypto.randomUUID()}`,
								sender_instance: "yano-watcher",
								sender_role: "yano-watcher",
								target_instance: planner.instance,
								project,
								prompt: `[yano-watcher] Violazione debate: ${finding.actual}. Manca orchestrator.db perché il planner ha saltato orchestrator_init. Inizializza ora il workspace Yano, verifica il DB e poi ripara/verifica il flusso; non dichiarare il debate valido finché il watcher non può rileggerlo.`,
								timestamp: new Date().toISOString(),
							}), { qos: 1 });
						} catch { /* best effort */ }
					}
				}
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: livePlanners.length && client ? "planner" : "local", delivered: livePlanners.length && client ? livePlanners.length : 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: finding.signal, fingerprint: finding.fingerprint, kind: finding.kind } }); } catch { /* best effort */ }
				routed.add(finding.fingerprint);
			}
			appendWatcherScan({ cwd: watchCwd, project, opts, status: "finding", reason: "debate_not_initialized", findings: findings.length, liveAgents: liveAgents.length, livePlanners: livePlanners.length });
			console.log(`yano watch: violazione debate — trace presente ma manca orchestrator.db (${dbPath}); il planner è stato avvertito.`);
			if (client && !sharedPersistentClient) { try { await new Promise((resolve) => setTimeout(resolve, 120)); client.end(false); } catch { /* best effort */ } }
			scheduleNextPass({ cwd, argv, packageRoot });
			return { status: "finding", reason: "debate_not_initialized", findings, project, db_path: dbPath };
		}
		if (!hasValidationContext(opts)) {
			appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "waiting", reason: "not_initialized", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
			console.log(`yano watch: in attesa — nessun orchestrator.db per questo progetto (${dbPath}); nessuna validazione da segnalare.`);
			if (client && !sharedPersistentClient) { try { await new Promise((resolve) => setTimeout(resolve, 120)); client.end(false); } catch { /* best effort */ } }
			scheduleNextPass({ cwd, argv, packageRoot });
			return { status: "waiting", reason: "not_initialized", route: { route: "not_applicable", delivered: 0 }, project, db_path: dbPath };
		}

		// An explicit validation watcher must report a blocked precondition just
		// as it reports a stall. Do not call process.exit: runWatch is imported
		// by tests and by the Architect control plane.
		const details = {
			project,
			project_root: watchCwd,
			validation_run_id: opts.validationRun || null,
			proposal_id: opts.playbookProposal || null,
			playbook_id: opts.playbookId || null,
			reason: "not_initialized",
			orchestrator_db: dbPath,
			live_agents: liveAgents.map((agent) => ({ instance: agent.instance, role: agent.role, status: agent.status })),
		};
		const previous = readTraceRecords({ cwd: watchCwd, project, limit: 100000 }).some((record) =>
			record.type === "yano_watcher_notification_route" &&
			record.signal === "validation_blocked" &&
			record.validation_run_id === (opts.validationRun || null),
		);
		try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_validation_blocked", record_type: "event", instance: "yano-watcher", signal: "validation_blocked", ...details } }); } catch { /* best effort */ }
		let route = { route: "deduplicated", delivered: 0 };
		if (!previous) {
			if (livePlanners.length && client) {
				let delivered = 0;
				for (const planner of livePlanners) {
					try {
						await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify({
							type: "command",
							assignment_id: `watcher-${crypto.randomUUID()}`,
							sender_instance: "yano-watcher",
							sender_role: "yano-watcher",
							target_instance: planner.instance,
							project,
							correlation_id: opts.validationRun || null,
							prompt: `[yano-watcher] Validazione bloccata: il progetto non è inizializzato per Yano (manca orchestrator.db). Segnale: validation_blocked. Evidenze: ${JSON.stringify(details)}. Non modificare il progetto; informa l'utente o inizializza Yano prima di ripetere la validazione.`,
							timestamp: new Date().toISOString(),
						}), { qos: 1 });
						delivered++;
					} catch { /* best effort */ }
				}
				route = { route: "planner", delivered };
			} else {
				const telegram = await sendTelegramWatcherNotification({
					yanoRepo,
					env: config,
					sender: "yano-watcher",
					project,
					message: `🚨 Yano watcher: validazione bloccata perché il progetto non è inizializzato (manca orchestrator.db).\nProgetto: ${project}\nSegnale: validation_blocked\nNessun planner live è presente: serve attenzione dell’utente.\nDettagli: ${JSON.stringify(details)}`,
				});
				if (!telegram.ok && telegram.detail === "telegram_env_missing") throw missingConfigError("watch", telegram.missing, { packageRoot: effectivePackageRoot });
				route = { route: "telegram", telegram };
			}
			try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: route.route, delivered: route.delivered || 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: "validation_blocked", validation_run_id: opts.validationRun || null, telegram: route.telegram ? { ok: route.telegram.ok, detail: route.telegram.detail } : null } }); } catch { /* best effort */ }
		}
		appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "blocked", reason: "not_initialized", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
		console.log(`yano watch: validation blocked — nessun orchestrator.db per questo progetto (${dbPath})${previous ? " (notifica già inviata)" : ""}.`);
		if (client && !sharedPersistentClient) { try { await new Promise((resolve) => setTimeout(resolve, 120)); client.end(false); } catch { /* best effort */ } }
		scheduleNextPass({ cwd, argv, packageRoot });
		return { status: "blocked", reason: "not_initialized", route, project, db_path: dbPath };
	}

	let DatabaseSync;
	try {
		({ DatabaseSync } = yanoRequire("node:sqlite"));
	} catch (err) {
		console.error(`yano watch: node:sqlite non disponibile (${err instanceof Error ? err.message : String(err)}).`);
		appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "error", reason: "sqlite_unavailable", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
		return { status: "error", reason: "sqlite_unavailable", project, db_path: dbPath };
	}

	const db = new DatabaseSync(dbPath, { readOnly: true });

	const now = Date.now();
	let stalled = [];
	try {
	const rows = db.prepare("SELECT * FROM tickets WHERE status = 'running' ORDER BY updated_at ASC").all();
		// An open human decision hold is an intentional pause, not a worker
		// stall.  Refactor specialists, for example, may exit after proposing
		// their plan while the planner waits for user confirmation.
		stalled = rows.filter((t) => now - new Date(t.updated_at).getTime() > opts.stallMs);
		if (stalled.length) {
			const holdRows = db.prepare("SELECT DISTINCT run_id FROM decision_holds WHERE status = 'open'").all();
			const pausedRuns = new Set(holdRows.map((row) => row.run_id));
			stalled = stalled.filter((t) => !pausedRuns.has(t.run_id));
		}
	} catch (err) {
		appendWatcherScan({ cwd: watchCwd, project, opts, startedAt, status: "error", reason: "sqlite_query_failed", liveAgents: liveAgents.length, livePlanners: livePlanners.length });
		console.error(`yano watch: query SQLite fallita (${err instanceof Error ? err.message : String(err)})`);
		process.exit(1);
	}

	const logDir = tracePaths({ cwd: watchCwd, project }).eventsDir;

	// Semantic liveness proxy (Ticket 05): an assignee whose JSONL log carries a
	// recent tool_execution_start marker (logged by the extension at the START of
	// each tool call) is *actively tooling* — likely a long task, not a hung turn.
	// This is the per-harness semantic signal that lets an observer distinguish
	// "slow" from "blocked" (the Revisione 29 case) without any LLM turn.
	const semanticActive = new Set();
	try {
		if (existsSync(logDir)) {
			const stalenessWindow = Math.min(opts.stallMs, 600_000); // tool call within the last (stall or 10min) window counts as active
			const cutoff = now - stalenessWindow;
			for (const f of readdirSync(logDir)) {
				if (!f.endsWith(".jsonl")) continue;
				const inst = f.replace(/\.jsonl$/, "");
				try {
					const lines = readFileSync(path.join(logDir, f), "utf-8").split("\n").filter(Boolean);
					for (let i = lines.length - 1; i >= 0; i--) {
						const line = lines[i].trim();
						if (!line) continue;
						const o = JSON.parse(line);
						if (o && o.type === "tool_execution_start") {
							const t = new Date(o.ts).getTime();
							if (!Number.isNaN(t) && t > cutoff) semanticActive.add(inst);
							break;
						}
					}
				} catch { /* log format drift — ignore */ }
			}
		}
	} catch { /* best-effort */ }
	const marker = [];
	for (const t of stalled) {
		const elapsedMs = now - new Date(t.updated_at).getTime();
		const active = t.assigned_instance ? semanticActive.has(t.assigned_instance) : false;
		const event = { ts: new Date().toISOString(), type: "stall_watch", project, project_key: tracePaths({ cwd: watchCwd, project }).projectKey, ticket_id: t.id, run_id: t.run_id, assigned_instance: t.assigned_instance, elapsed_ms: elapsedMs, semantic_active: active };
		if (client) {
			const topic = `pi/${project}/runs/${t.run_id}/events`;
			try {
				await client.publishAsync(topic, JSON.stringify({ type: "ticket_stalled", run_id: t.run_id, payload: { ticket_id: t.id, assigned_instance: t.assigned_instance, elapsed_ms: elapsedMs }, timestamp: new Date().toISOString() }), { qos: 0 });
			} catch { /* best-effort */ }
		}
		try {
			mkdirSync(logDir, { recursive: true });
			appendFileSync(path.join(logDir, "watch-stalls.jsonl"), JSON.stringify(event) + "\n");
		} catch { /* best-effort */ }
		console.log(`⚠️  ${t.id} "${t.title || "(no title)"}" — running da ${Math.round(elapsedMs / 60_000)} min (${t.assigned_instance ?? "?"})${active ? " [tool attivi di recente → probabile task lento, non bloccato]" : " [NESSUN tool recente → possibile turno bloccato]"}`);
		marker.push(event);
	}

	if (stalled.length === 0) {
		// Away-mode (Ticket 07): a clean 'no stall' pass is routine/heartbeat —
		// absorb it (silence) instead of paging the operator on every sweep.
		if (!awayEnabled(opts)) console.log(`yano watch: nessun ticket running oltre ${Math.round(opts.stallMs / 60_000)} min (project "${project}").`);
	} else {
		// A real stall is a genuine decision — surface it in BOTH modes (away
		// still escalates real decisions; it only absorbs routine noise).
		console.log(`yano watch: ${marker.length} stall rilevat${marker.length === 1 ? "o" : "i"} — pubblicati su MQTT e loggati. La decisione operativa è del planner, non del watcher.`);
	}

	if (marker.length && config.DESTINATION_PHONE_NUMBER && config.EVOLUTION_API_URL) {
		// Optional WhatsApp tripwire — best-effort, same env contract as the extension.
		try {
			const api = config.EVOLUTION_API_URL.replace(/\/$/, "");
			const url = `${api}/message/sendText/${encodeURIComponent(config.EVOLUTION_INSTANCE_NAME || "default")}`;
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", apikey: config.EVOLUTION_API_KEY || "" },
				body: JSON.stringify({ number: config.DESTINATION_PHONE_NUMBER, text: `⏱️ ${marker.length} ticket stagnanti (yano watch): ${marker.map((m) => m.ticket_id).join(", ")}` }),
			});
		} catch { /* best-effort */ }
	}

	const routeNotice = async ({ summary, signal, details = {} }) => {
		if (livePlanners.length) {
			let delivered = 0;
			for (const planner of livePlanners) {
				try {
					const envelope = {
						type: "command",
						assignment_id: `watcher-${crypto.randomUUID()}`,
						sender_instance: "yano-watcher",
						sender_role: "yano-watcher",
						target_instance: planner.instance,
						project,
						prompt: `[yano-watcher] ${summary}\n\nSegnale: ${signal}\n${JSON.stringify(details)}\nVerifica il trace. Se il segnale riguarda un processo o una delega fallita, ripara il percorso e rilancia il processo necessario; poi verifica nuovamente l'esito. Non considerare il watcher autorizzato a modificare ticket o codice.`,
						reply_to: `pi/${project}/agents/yano-watcher/responses`,
						hops: 0,
						timestamp: new Date().toISOString(),
					};
					await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify(envelope), { qos: 1 });
					delivered++;
				} catch { /* best effort */ }
			}
			try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "planner", planner_instances: livePlanners.map((agent) => agent.instance), delivered, signal, fingerprint: details.fingerprint || null, ticket_path: details.ticket_path || null, run_id: details.run_id || null, ticket_id: details.ticket_id || null } }); } catch { /* best effort */ }
			return { route: "planner", delivered };
		}
		const telegram = await sendTelegramWatcherNotification({ yanoRepo, env: config, sender: "yano-watcher", project, message: `🚨 Yano watcher: ${summary}\nProgetto: ${project}\nSegnale: ${signal}\nNessun planner live è presente: serve attenzione dell’utente.\nDettagli: ${JSON.stringify(details)}` });
		if (!telegram.ok && telegram.detail === "telegram_env_missing") throw missingConfigError("watch", telegram.missing, { packageRoot: effectivePackageRoot });
		try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "telegram", planner_instances: [], telegram: { ok: telegram.ok, detail: telegram.detail }, signal, fingerprint: details.fingerprint || null, ticket_path: details.ticket_path || null, run_id: details.run_id || null, ticket_id: details.ticket_id || null } }); } catch { /* best effort */ }
		return { route: "telegram", telegram };
	};

	// Context maintenance is playbook-agnostic. The extension emits one
	// bounded context_usage record per lifecycle point; the watcher keeps only
	// the newest record for each live instance and asks Pi to compact when the
	// effective context crosses the configured ratio. The request is sent to
	// the agent itself (not to an LLM and not to SQLite), so the operation stays
	// at a safe session boundary and preserves the normal Yano ticket state.
	let contextFindings = [];
	try {
		const contextRecords = readTraceRecords({ cwd: watchCwd, project, since: new Date(Date.now() - Math.max(0, opts.lookbackMs)), limit: 100000 })
			.filter((record) => record.type === "context_usage" && record.instance && Number.isFinite(Number(record.effective_context_tokens)));
		const latestByInstance = new Map();
		for (const record of contextRecords) {
			const previous = latestByInstance.get(record.instance);
			if (!previous || String(record.ts || "") > String(previous.ts || "")) latestByInstance.set(record.instance, record);
		}
		const ratioThreshold = Number.isFinite(opts.contextCompactRatio) && opts.contextCompactRatio > 0 && opts.contextCompactRatio < 1
			? opts.contextCompactRatio
			: 0.82;
		for (const record of latestByInstance.values()) {
			const ratio = Number(record.context_ratio ?? (Number(record.context_window_tokens) > 0 ? Number(record.effective_context_tokens) / Number(record.context_window_tokens) : NaN));
			if (!Number.isFinite(ratio) || ratio < ratioThreshold) continue;
			const finding = {
				signal: "context_compaction_requested",
				fingerprint: crypto.createHash("sha256").update(`${record.instance}|${record.ts}|${record.effective_context_tokens}`).digest("hex"),
				severity: "high",
				category: "context-window",
				summary: `Il contesto di ${record.instance} è al ${Math.round(ratio * 100)}%: richiesta compaction Pi.`,
				instance: record.instance,
				role: record.role || null,
				context_tokens: Number(record.effective_context_tokens),
				context_window_tokens: Number(record.context_window_tokens) || null,
				context_ratio: ratio,
				threshold_ratio: ratioThreshold,
				observed_at: record.ts || null,
			};
			contextFindings.push(finding);
		}
		try {
			appendRawTraceRecord({ cwd: watchCwd, project, record: {
				type: "yano_watcher_context_check",
				record_type: "event",
				source: "yano-watcher",
				instance: "yano-watcher",
				project,
				status: contextFindings.length ? "high" : "healthy",
				checked_at: new Date().toISOString(),
				threshold_ratio: ratioThreshold,
				observed_agents: latestByInstance.size,
				high_context_agents: contextFindings.map((item) => item.instance),
				message: contextFindings.length
					? "Il watcher ha rilevato contesti oltre soglia e avviato la compaction nativa Pi."
					: "Dimensioni contesto sotto soglia.",
			} });
		} catch { /* best effort */ }

		const priorContextRoutes = new Set(readTraceRecords({ cwd: watchCwd, project, limit: 100000 })
			.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "context_compaction_requested")
			.map((record) => record.fingerprint)
			.filter(Boolean));
		for (const finding of contextFindings) {
			if (priorContextRoutes.has(finding.fingerprint)) continue;
			const target = liveAgents.find((agent) => agent.instance === finding.instance);
			let delivered = 0;
			if (target && client) {
				try {
					await client.publishAsync(`pi/${project}/agents/${target.instance}/commands`, JSON.stringify({
						type: "context_compact_request",
						request_id: `context-${crypto.randomUUID()}`,
						requested_by_instance: "yano-watcher",
						requested_by_role: "watcher",
						reason: finding.summary,
						custom_instructions: "Riduci il contesto mantenendo obiettivo, decisioni, stato ticket, file modificati e prossimi passi. Riprendi il lavoro dal punto corrente.",
						timestamp: new Date().toISOString(),
					}), { qos: 1 });
					delivered = 1;
				} catch { /* route below informs planner */ }
			}
			if (delivered) {
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", source: "yano-watcher", instance: "yano-watcher", route: "agent", delivered, target_instance: finding.instance, signal: finding.signal, fingerprint: finding.fingerprint } }); } catch { /* best effort */ }
			} else {
				await routeNotice({ summary: `${finding.summary} L'agente non è raggiungibile: planner, verifica la sessione e usa il recovery supportato.`, signal: finding.signal, details: finding });
			}
			priorContextRoutes.add(finding.fingerprint);
		}
	} catch (error) {
		console.warn(`yano watch: controllo contesto non riuscito — ${error instanceof Error ? error.message : String(error)}`);
	}
	const previouslyRoutedStalls = new Set(readTraceRecords({ cwd: watchCwd, project, limit: 100000 })
		.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "ticket_stalled")
		.map((record) => `${record.run_id || "?"}:${record.ticket_id || "?"}`));
	for (const stalled of marker) {
		const stallKey = `${stalled.run_id || "?"}:${stalled.ticket_id || "?"}`;
		if (previouslyRoutedStalls.has(stallKey)) continue;
		await routeNotice({
			summary: `Il ticket ${stalled.ticket_id} è bloccato da ${Math.round(stalled.elapsed_ms / 60_000)} minuti.`,
			signal: "ticket_stalled",
			details: { ticket_id: stalled.ticket_id, run_id: stalled.run_id, assigned_instance: stalled.assigned_instance },
		});
		previouslyRoutedStalls.add(stallKey);
	}

	// Escalation path for defects in Yano itself. The classifier is deliberately
	// conservative: generic project failures stay in the project trace and do
	// not create maintenance tickets in the Yano repository.
	let validationFindings = [];
	let conversationFindings = [];
	let debateFindings = [];
	let getBestFromFindings = [];
	let scopeFindings = [];
	try {
		const traceRecords = readTraceRecords({ cwd: watchCwd, project, since: new Date(Date.now() - Math.max(0, opts.lookbackMs)), limit: 100000 });
		const scopeCheck = inspectProjectScope(traceRecords, project);
		scopeFindings = scopeCheck.findings;
		if (scopeCheck.scopeEvidence) {
			try {
				appendRawTraceRecord({ cwd: watchCwd, project, record: {
					type: "yano_watcher_scope_check",
					record_type: "event",
					source: "yano-watcher",
					instance: "yano-watcher",
					project,
					status: "violation",
					checked_at: new Date().toISOString(),
					violations: scopeFindings.length,
					mismatches: scopeCheck.mismatches.map((record) => ({ instance: record.instance, role: record.role || null, project: record.project, default_project: record.default_project })),
					message: "Una o più istanze della root usano uno scope MQTT diverso da quello canonico.",
				} });
			} catch { /* tracing must never block the watcher */ }
		}
		const debateCheck = inspectDebatePolicy(traceRecords, {
			// `agent_end` is the authoritative end-of-turn marker in the trace.
			// Do not use retained MQTT presence here: a pane can still advertise a
			// recent heartbeat for a process that Herdr already marked done.
			completed: traceRecords.some((record) => record.type === "agent_end" && record.role === "planner"),
		});
		const conversationCheck = inspectConversationPolicy(traceRecords);
		// A debate may contain a conversation-researcher only as the faulty
		// route we are reporting. Do not emit a misleading "conversation
		// healthy" event for that trace; the debate check owns the verdict.
		if (conversationCheck.conversationEvidence && !debateCheck.debateEvidence) {
			conversationFindings = conversationCheck.findings;
			const previousViolationFingerprints = new Set(traceRecords
				.filter((record) => record.type === "yano_watcher_conversation_violation")
				.map((record) => record.fingerprint)
				.filter(Boolean));
			for (const finding of conversationFindings) {
				if (previousViolationFingerprints.has(finding.fingerprint)) continue;
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_conversation_violation", record_type: "event", source: "yano-watcher", instance: "yano-watcher", project, ...finding } }); } catch { /* best effort */ }
				previousViolationFingerprints.add(finding.fingerprint);
			}
			try {
				appendRawTraceRecord({ cwd: watchCwd, project, record: {
					type: "yano_watcher_conversation_check",
					record_type: "event",
					source: "yano-watcher",
					instance: "yano-watcher",
					project,
					status: conversationFindings.length ? "violation" : "healthy",
					checked_at: new Date().toISOString(),
					violations: conversationFindings.length,
					message: conversationFindings.length
						? "Il trace della conversazione contiene una violazione o un errore di runtime da correggere."
						: "Regole conversation verificate: consulto read-only e nessuna operazione di consegna rilevata.",
				} });
			} catch { /* tracing must never block the watcher */ }
		}
		if (debateCheck.debateEvidence) {
			debateFindings = debateCheck.findings;
			try {
				appendRawTraceRecord({ cwd: watchCwd, project, record: {
					type: "yano_watcher_debate_check",
					record_type: "event",
					source: "yano-watcher",
					instance: "yano-watcher",
					project,
					status: debateFindings.length ? "violation" : "healthy",
					checked_at: new Date().toISOString(),
					violations: debateFindings.length,
					debaters: debateCheck.debaters,
					conversation_researchers: debateCheck.conversationResearchers,
					model_advisor_calls: debateCheck.modelAdvisorCalls,
					model_runtime_failures: debateCheck.modelRuntimeFailures,
					confirmation_requested: debateCheck.confirmationRequested,
					user_confirmed: debateCheck.userConfirmation,
					message: debateFindings.length
						? "Il trace del dibattito viola il roster o il percorso di selezione dei modelli."
						: "Regole debate verificate: roster e percorso specialistico coerenti.",
				} });
			} catch { /* tracing must never block the watcher */ }
		}
		const getBestFromCheck = inspectGetBestFromPolicy(traceRecords, {
			completed: traceRecords.some((record) => record.type === "agent_end" && record.role === "planner"),
		});
		if (getBestFromCheck.getBestFromEvidence) {
			getBestFromFindings = getBestFromCheck.findings;
			try {
				appendRawTraceRecord({ cwd: watchCwd, project, record: {
					type: "yano_watcher_get_best_from_check",
					record_type: "event",
					source: "yano-watcher",
					instance: "yano-watcher",
					project,
					status: getBestFromFindings.length ? "violation" : "healthy",
					checked_at: new Date().toISOString(),
					violations: getBestFromFindings.length,
					benchmarkers: getBestFromCheck.benchmarkers,
					model_advisor_calls: getBestFromCheck.modelAdvisorCalls,
					message: getBestFromFindings.length
						? "Il trace del confronto tra repository viola uno o più gate osservabili del playbook."
						: "Regole get-the-best-from verificate: due analisi cieche, modelli proposti, sintesi successiva e sola lettura.",
				} });
			} catch { /* tracing must never block the watcher */ }
		}
		const routedFindingKeys = new Set(traceRecords
			.filter((record) => record.type === "yano_watcher_notification_route")
			.flatMap((record) => [record.fingerprint, record.ticket_path].filter(Boolean)));
		const escalation = await processYanoWatcherFindings({
			records: traceRecords,
			projectRoot: watchCwd,
			project,
			yanoRepo,
			traceContext: { cwd: watchCwd, project_key: tracePaths({ cwd: watchCwd, project }).projectKey },
			notify: livePlanners.length === 0,
			env: config,
		});
		validationFindings = escalation.findings || [];
		if (escalation.created || escalation.notified || escalation.findings.length) {
			console.log(`yano watch: ${escalation.findings.length} segnal${escalation.findings.length === 1 ? "e" : "i"} Yano, ${escalation.created} ticket creat${escalation.created === 1 ? "o" : "i"}, ${escalation.notified} notific${escalation.notified === 1 ? "a" : "he"} Telegram.`);
		}
		if (!livePlanners.length) {
			const missingTelegram = escalation.results.find((item) => item.telegram?.detail === "telegram_env_missing")?.telegram?.missing;
			if (missingTelegram?.length) throw missingConfigError("watch", missingTelegram, { packageRoot: effectivePackageRoot });
		}
		for (const result of escalation.results.filter((item) => (livePlanners.length && (item.created || item.skipped)) || (item.skipped && !livePlanners.length))) {
			if (result.skipped && !yanoRepo) throw missingConfigError("watch", ["YANO_ORCHESTRATOR_REPO"], { packageRoot: effectivePackageRoot });
			const findingKey = result.finding.fingerprint || result.path || null;
			if (findingKey && routedFindingKeys.has(findingKey)) continue;
			await routeNotice({ summary: result.finding.summary, signal: result.finding.signal, details: { fingerprint: result.finding.fingerprint || null, ticket_path: result.path || null, severity: result.finding.severity } });
			if (findingKey) routedFindingKeys.add(findingKey);
		}
		const routedConversationKeys = new Set(traceRecords
			.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "conversation_policy_violation")
			.map((record) => record.fingerprint)
			.filter(Boolean));
		for (const finding of conversationFindings) {
			if (routedConversationKeys.has(finding.fingerprint)) continue;
			try {
				await routeNotice({
					summary: finding.summary,
					signal: finding.signal,
					details: { fingerprint: finding.fingerprint, instance: finding.instance, role: finding.role, tool: finding.tool, expected: finding.expected, actual: finding.actual },
				});
			} catch (error) {
				// A missing external notification channel must not hide the local
				// policy finding or crash the zero-token watcher.
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "local", delivered: 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: finding.signal, fingerprint: finding.fingerprint, notification_error: error instanceof Error ? error.message : String(error) } }); } catch { /* best effort */ }
			}
			routedConversationKeys.add(finding.fingerprint);
		}
		const routedDebateKeys = new Set(traceRecords
			.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "debate_policy_violation")
			.map((record) => record.fingerprint)
			.filter(Boolean));
		for (const finding of debateFindings) {
			if (routedDebateKeys.has(finding.fingerprint)) continue;
			try {
				await routeNotice({
					summary: finding.summary,
					signal: finding.signal,
					details: { fingerprint: finding.fingerprint, kind: finding.kind, instance: finding.instance, expected: finding.expected, actual: finding.actual, debaters: debateCheck.debaters, model_advisor_calls: debateCheck.modelAdvisorCalls, model_runtime_failures: debateCheck.modelRuntimeFailures },
				});
			} catch (error) {
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "local", delivered: 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: finding.signal, fingerprint: finding.fingerprint, notification_error: error instanceof Error ? error.message : String(error) } }); } catch { /* best effort */ }
			}
			routedDebateKeys.add(finding.fingerprint);
		}
		const routedGetBestKeys = new Set(traceRecords
			.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "get_best_from_policy_violation")
			.map((record) => record.fingerprint)
			.filter(Boolean));
		for (const finding of getBestFromFindings) {
			if (routedGetBestKeys.has(finding.fingerprint)) continue;
			try {
				await routeNotice({
					summary: finding.summary,
					signal: finding.signal,
					details: { fingerprint: finding.fingerprint, kind: finding.kind, instance: finding.instance, expected: finding.expected, actual: finding.actual },
				});
			} catch (error) {
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "local", delivered: 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: finding.signal, fingerprint: finding.fingerprint, notification_error: error instanceof Error ? error.message : String(error) } }); } catch { /* best effort */ }
			}
			routedGetBestKeys.add(finding.fingerprint);
		}
		const routedScopeKeys = new Set(traceRecords
			.filter((record) => record.type === "yano_watcher_notification_route" && record.signal === "project_scope_mismatch")
			.map((record) => record.fingerprint)
			.filter(Boolean));
		for (const finding of scopeFindings) {
			if (routedScopeKeys.has(finding.fingerprint)) continue;
			try {
				await routeNotice({
					summary: finding.summary,
					signal: finding.signal,
					details: { fingerprint: finding.fingerprint, kind: finding.kind, instance: finding.instance, role: finding.role, expected: finding.expected, actual: finding.actual, project: finding.project, canonical_project: finding.canonical_project },
				});
			} catch (error) {
				try { appendRawTraceRecord({ cwd: watchCwd, project, record: { type: "yano_watcher_notification_route", record_type: "event", instance: "yano-watcher", route: "local", delivered: 0, planner_instances: livePlanners.map((agent) => agent.instance), signal: finding.signal, fingerprint: finding.fingerprint, notification_error: error instanceof Error ? error.message : String(error) } }); } catch { /* best effort */ }
			}
			routedScopeKeys.add(finding.fingerprint);
		}
	} catch (error) {
		if (error?.code === "YANO_CONFIG_MISSING") throw error;
		console.warn(`yano watch: escalation Yano non riuscita — ${error instanceof Error ? error.message : String(error)}`);
	}

	// A clean validation pass is positive evidence only for the architect's
	// bounded proposal. It is never sent to Telegram as an alert and never
	// promotes anything by itself; the planner still collects user feedback.
	validationFindings = [...validationFindings, ...conversationFindings, ...debateFindings, ...getBestFromFindings, ...scopeFindings];

	if (opts.validationRun && marker.length === 0 && validationFindings.length === 0 && contextFindings.length === 0) {
		const healthy = {
			ts: new Date().toISOString(),
			type: "yano_watcher_round_ok",
			record_type: "event",
			source: "yano-watcher",
			instance: "yano-watcher",
			project,
			validation_run_id: opts.validationRun,
			proposal_id: opts.playbookProposal,
			playbook_id: opts.playbookId,
			playbook_checksum: opts.playbookChecksum,
			round: opts.validationRound,
			message: "Passata di osservazione bounded senza stall o finding Yano.",
		};
		try { appendRawTraceRecord({ cwd: watchCwd, project, record: healthy }); } catch { /* best effort */ }
		if (livePlanners.length && client) {
			for (const planner of livePlanners) {
				try {
					await client.publishAsync(`pi/${project}/agents/${planner.instance}/commands`, JSON.stringify({
						type: "command",
						assignment_id: `watcher-healthy-${crypto.randomUUID()}`,
						sender_instance: "yano-watcher",
						sender_role: "yano-watcher",
						target_instance: planner.instance,
						project,
						correlation_id: opts.validationRun,
						display: true,
						triggerTurn: true,
						followUp: true,
						prompt: `[yano-watcher] Round di validazione sano per la proposta ${opts.playbookProposal || "?"}. Nessuno stall o finding Yano osservato. Il playbook resta ephemeral: raccogli il feedback dell'utente prima di chiedere la promozione.`,
						timestamp: new Date().toISOString(),
					}), { qos: 1 });
				} catch { /* best effort */ }
			}
		}
	}

	const scanStatus = marker.length || validationFindings.length || contextFindings.length ? "finding" : "healthy";
	const scan = appendWatcherScan({
		cwd: watchCwd,
		project,
		opts,
		startedAt,
		status: scanStatus,
		reason: null,
		stalls: marker.length,
		findings: validationFindings.length + contextFindings.length,
		liveAgents: liveAgents.length,
		livePlanners: livePlanners.length,
	});

	try { db.close(); } catch { /* ignore */ }
	if (client && !sharedPersistentClient) {
		// Graceful close: force:false lets already-published (QoS0 in-flight)
		// messages flush before the connection drops — force:true here would
		// discard the ticket_stalled events we just published.
		try { await new Promise((r) => setTimeout(r, 120)); client.end(false); } catch { /* ignore */ }
	}

	if (opts.once || opts.intervalMs <= 0) return { status: scanStatus, scan }; // single pass — let the caller decide to exit
	// Real watcher loop: after this pass, wait intervalMs then run again.
	// Env-gated away mode is honored on every pass, so `--away` can be implied
	// by PI_ORCH_AWAY=1 even if the process was launched without the flag.
	scheduleNextPass({ cwd, argv, packageRoot });
	return { status: scanStatus, scan };
}

function awayEnabled(opts) {
	return opts.away || String(process.env.PI_ORCH_AWAY || "") === "1";
}

async function discoverLiveAgents(client, project) {
	if (!client) return [];
	const agents = new Map();
	const topic = `pi/${project}/agents/+/status`;
	const onMessage = (_topic, payload) => {
		try {
			const card = JSON.parse(payload.toString());
			if (card?.instance) agents.set(card.instance, card);
		} catch { /* malformed retained card */ }
	};
	try {
		client.on("message", onMessage);
		await client.subscribeAsync(topic, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 250));
	} catch { /* best effort */ }
	try { client.removeListener("message", onMessage); } catch { /* ignore */ }
	const staleAfterMs = Number(process.env.PI_ORCH_STALE_AFTER_MS) || 45_000;
	const now = Date.now();
	return [...agents.values()].filter((agent) => {
		if (agent.status === "offline") return false;
		const heartbeat = Date.parse(agent.last_heartbeat || "");
		return Number.isFinite(heartbeat) && now - heartbeat <= staleAfterMs;
	});
}

// Direct invocation: `node scripts/watch-stalls.mjs --once` — only here do we
// take ownership of the process lifetime (process.exit), so an embedded caller
// importing runWatch can still run assertions after a --once pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const invokedOnce = async () => {
		const argv = process.argv.slice(2);
		const result = await runWatch({ cwd: process.cwd(), argv });
		const intervalIndex = argv.indexOf("--interval-ms");
		const intervalMs = intervalIndex >= 0 ? Number(argv[intervalIndex + 1]) : 60000;
		if (result?.help || argv.includes("--once") || !(intervalMs > 0)) process.exit(0);
	};
	invokedOnce().catch((err) => {
		console.error(`yano watch: errore — ${err instanceof Error ? err.stack || err.message : String(err)}`);
		process.exit(1);
	});
}
