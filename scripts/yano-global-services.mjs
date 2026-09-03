import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { globalDataPath, resolveYanoConfig } from "./yano-config.mjs";
import { materializeAgentMcp } from "./yano-agent-mcp.mjs";
import { herdrSnapshot as snapshot } from "./yano-herdr-client.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COMPUTER_INSTANCE = "yano-local-pc";
const COMPUTER_ROLE = "yano-local-pc";
const COMPUTER_WORKSPACE = "yano-local-pc";
const SCHEDULER_WORKSPACE = "yano-scheduler";
const WATCHER_WORKSPACE = "yano-watcher";
// Herdr normalizes the first tab created by a workspace to the safe slug;
// keeping this canonical prevents a second duplicate tab on recovery.
const COMPUTER_TAB = "yano-local-pc";
// Always-on control-plane services belong to the persistent Local PC runtime.
// No synthetic system project/scope exists; application checkouts remain
// ordinary optional Yano projects.
const SYSTEM_PROJECT = "yano-local-pc";

function computerRuntimeRoot() { return path.join(globalDataPath(), "yano-local-pc"); }
function serviceRuntimeRoot(name) { return path.join(globalDataPath(), name); }
function serviceLogPath() { return path.join(globalDataPath(), "logs", "global-services.jsonl"); }
function logService(event, details = {}) {
	try {
		mkdirSync(path.dirname(serviceLogPath()), { recursive: true, mode: 0o700 });
		appendFileSync(serviceLogPath(), `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 });
	} catch { /* logging must never prevent service recovery */ }
}
function applicationHeartbeatPath(agent, root, project) {
	const key = cryptoProjectKey(root, project);
	return path.join(globalDataPath(), "heartbeats", key, `${agent}.json`);
}
function cryptoProjectKey(root, project) {
	// Keep this dependency-free and identical to Yano's durable root identity.
	let canonical = root;
	try { canonical = realpathSync(root); } catch { /* root may be temporarily unavailable */ }
	return `workspace-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}
function ensureComputerRuntime() {
	const root = computerRuntimeRoot();
	const agents = path.join(root, "agents");
	const projectConfig = path.join(root, ".pi", "extensions", "yano-orchestrator", "config");
	mkdirSync(agents, { recursive: true, mode: 0o700 });
	mkdirSync(projectConfig, { recursive: true, mode: 0o700 });
	const appleMcp = process.platform === "darwin" ? "[apple-notes, apple-messages, apple-contacts, apple-reminders, apple-calendar, apple-maps, apple-mail, apple-voice-memos]" : "[]";
	if (!existsSync(path.join(agents, "roles.yaml"))) writeFileSync(path.join(agents, "roles.yaml"), `roles:\n  ${COMPUTER_ROLE}:\n    activation: always\n    playbook: yano-local-pc-operations\n    label: "Yano Local PC"\n    brief: "Agente per interagire con il PC dello sviluppatore tramite MCP, CLI e strumenti locali; porta nel contesto Yano informazioni e risorse del computer. Conferma sempre prima delle operazioni distruttive o dell'invio di messaggi."\n    model:\n      provider: llmproxy\n      model: llmproxy\n    skills: [yano-cli]\n    cli: [node, yano]\n    mcp: ${appleMcp}\n    teams: [system]\n`, { mode: 0o600 });
	writeFileSync(path.join(projectConfig, "project.json"), JSON.stringify({ schema_version: 1, extension_version: "global", project: SYSTEM_PROJECT, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
	const rolesPath = path.join(agents, "roles.yaml");
	const roles = readFileSync(rolesPath, "utf8");
	if (!roles.includes("yano-planner-trace-analysis")) {
		writeFileSync(rolesPath, roles.replace("skills: [yano-cli]", "skills: [yano-cli, yano-planner-trace-analysis]"), { mode: 0o600 });
	}
	const config = resolveYanoConfig({});
	const voiceKey = config.YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY || config.ASSEMBLYAI_API_KEY;
	const servers = process.platform === "darwin" ? {
		"apple-notes": { command: "npx", args: ["@griches/apple-notes-mcp"] },
		"apple-messages": { command: "npx", args: ["@griches/apple-messages-mcp"] },
		"apple-contacts": { command: "npx", args: ["@griches/apple-contacts-mcp"] },
		"apple-reminders": { command: "npx", args: ["@griches/apple-reminders-mcp"] },
		"apple-calendar": { command: "npx", args: ["@griches/apple-calendar-mcp"] },
		"apple-maps": { command: "npx", args: ["@griches/apple-maps-mcp"] },
		"apple-mail": { command: "npx", args: ["@griches/apple-mail-mcp"] },
	} : {};
	if (voiceKey) servers["apple-voice-memos"] = { command: "npx", args: ["apple-voice-memos-mcp"], env: { ASSEMBLYAI_API_KEY: voiceKey } };
	if (config.EVOLUTION_API_URL && config.EVOLUTION_API_KEY) servers["evolution-api"] = { command: "npx", args: ["-y", "mcp-evolution-api"], env: { EVOLUTION_API_URL: config.EVOLUTION_API_URL, EVOLUTION_API_KEY: config.EVOLUTION_API_KEY } };
	const custom = materializeAgentMcp(COMPUTER_INSTANCE);
	if (custom) Object.assign(servers, JSON.parse(readFileSync(custom, "utf8")).mcpServers || {});
	writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
	return root;
}
const SERVICES = [
	// Herdr infers the agent kind from the tab title while starting it. A tab
	// named exactly `yano-watcher` is classified as a legacy
	// external kind and rejected as `--kind pi`; keep the workspace names but
	// use neutral owned tab labels.
	{ instance: "watcher-service", agentName: "watcher-service", role: "watcher", workspace: WATCHER_WORKSPACE, tab: "watcher-service", cwd: serviceRuntimeRoot(WATCHER_WORKSPACE), project: WATCHER_WORKSPACE },
	{ instance: "scheduler-service", agentName: "scheduler-service", role: "scheduler", workspace: SCHEDULER_WORKSPACE, tab: "scheduler-service", cwd: serviceRuntimeRoot(SCHEDULER_WORKSPACE), project: SCHEDULER_WORKSPACE },
	{ instance: "planner-01", agentName: "planner-01", role: "planner", workspace: COMPUTER_WORKSPACE, tab: "planner-01", cwd: computerRuntimeRoot(), project: SYSTEM_PROJECT },
	{ instance: COMPUTER_INSTANCE, agentName: COMPUTER_INSTANCE, role: COMPUTER_ROLE, workspace: COMPUTER_WORKSPACE, tab: COMPUTER_TAB, cwd: computerRuntimeRoot(), project: SYSTEM_PROJECT },
];

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", maxBuffer: 1_000_000, ...options });
}
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }

// Herdr versions differ in whether the top-level `agent` field is `pi` or
// the requested instance name. The authoritative signal here is the owned
// name plus a non-terminal status (the session metadata identifies Pi when
// available).
function isLive(agent, expectedName = null) {
	return Boolean(agent && (!expectedName || agent.name === expectedName) && !["done", "offline", "unknown"].includes(String(agent.agent_status || "").toLowerCase()));
}

// Zero-token health probe. Snapshot status is useful for discovery but can be
// stale after a Pi turn ends. Herdr's lifecycle explanation plus the
// foreground process are the authoritative local signals; no model/MQTT
// request is made here.
function probeService(paneId, snapshotAgent, { instance = null, root = PACKAGE_ROOT, project = "yano-orchestrator", warmup = false } = {}) {
	if (!paneId) return { healthy: false, reason: "pane_missing" };
	const info = run("herdr", ["pane", "process-info", "--pane", paneId]);
	let processInfo = null;
	try { processInfo = JSON.parse(info.stdout || "")?.result?.process_info || null; } catch { /* handled below */ }
	const foreground = processInfo?.foreground_processes?.[0];
	const processHealthy = Boolean(foreground && (foreground.argv0 === "pi" || foreground.name === "node") && Number(foreground.pid) > 0);
	const explained = run("herdr", ["agent", "explain", paneId, "--json"]);
	let explanation = null;
	try { explanation = JSON.parse(explained.stdout || ""); } catch { /* older Herdr: fall back to snapshot */ }
	const state = String(explanation?.state || snapshotAgent?.agent_status || "unknown").toLowerCase();
	const healthyState = ["idle", "working"].includes(state) && explanation?.warning == null && explanation?.visible_blocker !== true;
	let applicationHeartbeat = { healthy: false, reason: "missing" };
	if (instance) {
		try {
			const heartbeat = JSON.parse(readFileSync(applicationHeartbeatPath(instance, root, project), "utf8"));
			const observed = Date.parse(heartbeat.observed_at || heartbeat.last_heartbeat || "");
			const ageMs = Number.isFinite(observed) ? Math.max(0, Date.now() - observed) : Infinity;
			applicationHeartbeat = { healthy: ageMs <= 60_000, age_ms: ageMs, observed_at: heartbeat.observed_at || heartbeat.last_heartbeat || null, status: heartbeat.status || null };
		} catch { /* first boot: process health remains useful during warm-up */ }
	}
	// A newly launched process gets one bounded grace probe; an already-live
	// process without an application heartbeat is unhealthy. This prevents a
	// decorative/stuck PID from remaining accepted forever, while still letting
	// a fresh Pi session publish its first heartbeat during startup.
	return {
		healthy: processHealthy && healthyState && (warmup ? true : applicationHeartbeat.healthy),
		state,
		process_pid: Number(foreground?.pid) || null,
		process: foreground?.argv0 || foreground?.name || null,
		visible_blocker: explanation?.visible_blocker === true,
		warning: explanation?.warning || null,
		status_snapshot: snapshotAgent?.agent_status || null,
		application_heartbeat: applicationHeartbeat,
	};
}

function closeInitialDuplicates(state, workspaceId, canonicalTabId, service) {
	const duplicateLabels = new Set(["1", "Local PC", "yano-local-pc", service.instance]);
	for (const candidate of state?.tabs || []) {
		if (candidate.workspace_id !== workspaceId || candidate.tab_id === canonicalTabId || !duplicateLabels.has(candidate.label)) continue;
		run("herdr", ["tab", "close", candidate.tab_id]);
	}
}

function ensureService(service) {
	if (service.workspace === COMPUTER_WORKSPACE) ensureComputerRuntime();
	else mkdirSync(service.cwd || serviceRuntimeRoot(service.workspace), { recursive: true, mode: 0o700 });
	logService("service_check_started", { service: service.instance, role: service.role, workspace: service.workspace, cwd: service.cwd, project: service.project });
	const serviceCwd = service.cwd || PACKAGE_ROOT;
	let state = snapshot();
	if (!state) { logService("service_check_failed", { service: service.instance, reason: "herdr_unreachable" }); return { service: service.instance, running: false, recovered: false, error: "Herdr non raggiungibile" }; }
	let workspace = state.workspaces?.find((item) => item.label === service.workspace);
	if (!workspace) {
		const created = run("herdr", ["workspace", "create", "--cwd", serviceCwd, "--label", service.workspace, "--no-focus"]);
		if (created.status !== 0) return { service: service.instance, running: false, recovered: false, error: (created.stderr || "workspace non creato").trim() };
		state = snapshot(); workspace = state?.workspaces?.find((item) => item.label === service.workspace);
	}
	if (!workspace?.workspace_id) return { service: service.instance, running: false, recovered: false, error: "workspace senza workspace_id" };
	const workspaceId = workspace.workspace_id;
	let tab = state.tabs?.find((item) => item.workspace_id === workspaceId && item.label === service.tab);
	let pane = tab && state.panes?.find((item) => item.tab_id === tab.tab_id);
	let agent = pane && state.agents?.find((item) => item.pane_id === pane.pane_id);
	// A fresh Herdr workspace may contain only its automatic tab `1`. Reuse it
	// when it is empty instead of opening a second tab for the service.
	if (!tab) {
		const initial = state.tabs?.find((item) => item.workspace_id === workspaceId && /^(1|\d+)$/.test(item.label || ""));
		const initialPane = initial && state.panes?.find((item) => item.tab_id === initial.tab_id);
		const initialAgent = initialPane && state.agents?.find((item) => item.pane_id === initialPane.pane_id);
		if (initial && initialPane && (!initialAgent || ["done", "offline", "unknown"].includes(String(initialAgent.agent_status || "").toLowerCase()))) {
			const renamed = run("herdr", ["tab", "rename", initial.tab_id, service.tab]);
			if (renamed.status === 0) { tab = { ...initial, label: service.tab }; pane = initialPane; agent = initialAgent; }
		}
	}
	const health = pane ? probeService(pane.pane_id, agent, { instance: service.instance, root: serviceCwd, project: service.project || "yano-orchestrator" }) : { healthy: false, reason: "pane_missing" };
	if (isLive(agent) && health.healthy) {
		closeInitialDuplicates(state, workspaceId, tab.tab_id, service);
		logService("service_healthy", { service: service.instance, workspace_id: workspaceId, tab_id: tab.tab_id, pane_id: pane.pane_id, health });
		return { service: service.instance, running: true, recovered: false, health, workspace_id: workspaceId, tab_id: tab.tab_id, pane_id: pane.pane_id };
	}
	if (tab && agent) {
		logService("service_tab_closed_for_recovery", { service: service.instance, tab_id: tab.tab_id, pane_id: pane?.pane_id, previous_health: health });
		const closed = run("herdr", ["tab", "close", tab.tab_id]);
		if (closed.status !== 0) return { service: service.instance, running: false, recovered: false, error: (closed.stderr || "tab di servizio non chiusa").trim() };
		state = snapshot(); workspace = state?.workspaces?.find((item) => item.label === service.workspace);
		tab = null; pane = null;
	}
	if (!tab || !pane) {
		const created = run("herdr", ["tab", "create", "--workspace", workspaceId, "--cwd", serviceCwd, "--label", service.tab, "--no-focus"]);
		if (created.status !== 0) return { service: service.instance, running: false, recovered: false, error: (created.stderr || "tab di servizio non creata").trim() };
		state = snapshot();
		tab = state?.tabs?.find((item) => item.workspace_id === workspaceId && item.label === service.tab);
		pane = tab && state?.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!pane?.pane_id) return { service: service.instance, running: false, recovered: false, error: "pane di servizio non trovata" };
	const composedArgs = [path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs"), "--instance", service.instance, "--role", service.role, "--json", "--print-only"];
	if (service.project) composedArgs.push("--project", service.project);
	// Use the package roster explicitly: the persistent Local PC runtime only
	// needs its own role file, while watcher/scheduler are package roles.
	composedArgs.push("--config-dir", path.join(PACKAGE_ROOT, "agents"));
	if (service.instance === COMPUTER_INSTANCE) composedArgs.push("--approve", "--mcp-config", path.join(serviceCwd, ".mcp.json"));
	const composed = run(process.execPath, composedArgs, { cwd: serviceCwd, env: { ...process.env, YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY: process.env.YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY || "" } });
	let args;
	try { args = JSON.parse(composed.stdout || "").args; } catch { return { service: service.instance, running: false, recovered: false, error: `composizione agente fallita: ${(composed.stderr || composed.stdout || "risposta vuota").trim()}` }; }
	// `herdr agent start` infers the current kind from a newly created tab's
	// title and rejects service names as non-Pi kinds. Starting Pi explicitly in
	// the owned pane lets the orchestrator extension publish the authoritative
	// Pi presence without that heuristic.
	const command = ["pi", ...args].map(shellQuote).join(" ");
	const started = run("herdr", ["pane", "run", pane.pane_id, `exec ${command}`], { cwd: serviceCwd });
	let after = snapshot();
	// Herdr reports the shell immediately after `pane run`; give Pi one short
	// bounded startup window before declaring an always-on service dead. Without
	// this grace period the next one-minute tick could close a healthy process
	// that had not published its first presence card yet.
	if (!after?.agents?.some((item) => item.pane_id === pane.pane_id && isLive(item))) {
		run("sleep", ["1"]);
		after = snapshot();
	}
	closeInitialDuplicates(after, workspaceId, tab.tab_id, service);
	const live = after?.agents?.find((item) => item.pane_id === pane.pane_id && isLive(item));
	const afterHealth = pane?.pane_id ? probeService(pane.pane_id, live, { instance: service.instance, root: serviceCwd, project: service.project || "yano-orchestrator", warmup: true }) : { healthy: false, reason: "pane_missing_after_start" };
	logService("service_recovery_attempted", { service: service.instance, recovered: true, running: Boolean(live && afterHealth.healthy), workspace_id: workspaceId, tab_id: tab.tab_id, pane_id: pane.pane_id, health: afterHealth, start_status: started.status });
	return { service: service.instance, running: Boolean(live && afterHealth.healthy), recovered: true, health: afterHealth, workspace_id: workspaceId, tab_id: tab.tab_id, pane_id: pane.pane_id, error: live && afterHealth.healthy || started.status === 0 ? null : (started.stderr || started.stdout || "Herdr non ha avviato l'agente").trim() };
}

export function ensureGlobalYanoServices() { return SERVICES.map(ensureService); }
export function ensureComputerLocalService() {
	const localPc = ensureService(SERVICES.find((service) => service.instance === COMPUTER_INSTANCE));
	const planner = ensureService(SERVICES.find((service) => service.instance === "planner-01"));
	return { ...localPc, planner };
}

export function globalServiceLogPath() { return serviceLogPath(); }

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(ensureGlobalYanoServices(), null, 2));
