import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { globalDataPath } from "./yano-config.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COMPUTER_INSTANCE = "computer-locale";
const COMPUTER_ROLE = "computer-local";
const COMPUTER_WORKSPACE = "yano-computer-locale";
// Herdr normalizes the first tab created by a workspace to the safe slug;
// keeping this canonical prevents a second duplicate tab on recovery.
const COMPUTER_TAB = "computer-locale";
const SYSTEM_PROJECT = "yano-scheduler";
const SYSTEM_SCOPE = "yano-system";

function computerRuntimeRoot() { return path.join(globalDataPath(), "computer-local"); }
function ensureComputerRuntime() {
	const root = computerRuntimeRoot();
	const agents = path.join(root, "agents");
	const projectConfig = path.join(root, ".pi", "extensions", "yano-orchestrator", "config");
	mkdirSync(agents, { recursive: true, mode: 0o700 });
	mkdirSync(projectConfig, { recursive: true, mode: 0o700 });
	if (!existsSync(path.join(agents, "roles.yaml"))) writeFileSync(path.join(agents, "roles.yaml"), `roles:\n  ${COMPUTER_ROLE}:\n    activation: always\n    playbook: computer-local-operations\n    label: "Computer locale"\n    brief: "Agente globale per consultare e gestire, solo su richiesta esplicita, le risorse locali Apple tramite MCP. Conferma sempre prima delle operazioni distruttive o dell'invio di messaggi."\n    model:\n      provider: llmproxy\n      model: llmproxy\n    skills: [yano-cli]\n    cli: [node, yano]\n    mcp: [apple-notes, apple-messages, apple-contacts, apple-reminders, apple-calendar, apple-maps, apple-mail, apple-voice-memos]\n    teams: [system]\n`, { mode: 0o600 });
	writeFileSync(path.join(projectConfig, "project.json"), JSON.stringify({ schema_version: 1, extension_version: "global", project: SYSTEM_PROJECT, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
	const rolesPath = path.join(agents, "roles.yaml");
	const roles = readFileSync(rolesPath, "utf8");
	if (!roles.includes("yano-planner-trace-analysis")) {
		writeFileSync(rolesPath, roles.replace("skills: [yano-cli]", "skills: [yano-cli, yano-planner-trace-analysis]"), { mode: 0o600 });
	}
	const voiceKey = process.env.YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY;
	const servers = {
		"apple-notes": { command: "npx", args: ["@griches/apple-notes-mcp"] },
		"apple-messages": { command: "npx", args: ["@griches/apple-messages-mcp"] },
		"apple-contacts": { command: "npx", args: ["@griches/apple-contacts-mcp"] },
		"apple-reminders": { command: "npx", args: ["@griches/apple-reminders-mcp"] },
		"apple-calendar": { command: "npx", args: ["@griches/apple-calendar-mcp"] },
		"apple-maps": { command: "npx", args: ["@griches/apple-maps-mcp"] },
		"apple-mail": { command: "npx", args: ["@griches/apple-mail-mcp"] },
	};
	if (voiceKey) servers["apple-voice-memos"] = { command: "npx", args: ["apple-voice-memos-mcp"], env: { ASSEMBLYAI_API_KEY: voiceKey } };
	writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
	return root;
}
const SERVICES = [
	// Herdr infers the agent kind from the tab title while starting it. A tab
	// named exactly `yano-watcher`/`yano-debugger` is classified as a legacy
	// external kind and rejected as `--kind pi`; keep the workspace names but
	// use neutral owned tab labels.
	{ instance: "watcher-service", agentName: "watcher-service", role: "watcher", workspace: "yano-watcher", tab: "watcher-service" },
	{ instance: "debugger-service", agentName: "debugger-service", role: "debugger", workspace: "yano-debugger", tab: "debugger-service" },
	{ instance: "scheduler-service", agentName: "scheduler-service", role: "scheduler", workspace: "yano-scheduler", tab: "scheduler-service", project: SYSTEM_PROJECT, projectScope: SYSTEM_SCOPE },
	{ instance: COMPUTER_INSTANCE, agentName: COMPUTER_INSTANCE, role: COMPUTER_ROLE, workspace: COMPUTER_WORKSPACE, tab: COMPUTER_TAB, cwd: computerRuntimeRoot(), project: SYSTEM_PROJECT },
];

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", maxBuffer: 1_000_000, ...options });
}
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }

function snapshot() {
	const result = run("herdr", ["api", "snapshot"]);
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout || ""); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}

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
function probeService(paneId, snapshotAgent) {
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
	return {
		healthy: processHealthy && healthyState,
		state,
		process_pid: Number(foreground?.pid) || null,
		process: foreground?.argv0 || foreground?.name || null,
		visible_blocker: explanation?.visible_blocker === true,
		warning: explanation?.warning || null,
		status_snapshot: snapshotAgent?.agent_status || null,
	};
}

function closeInitialDuplicates(state, workspaceId, canonicalTabId, service) {
	const duplicateLabels = new Set(["1", "Computer locale", "computer-locale", service.instance]);
	for (const candidate of state?.tabs || []) {
		if (candidate.workspace_id !== workspaceId || candidate.tab_id === canonicalTabId || !duplicateLabels.has(candidate.label)) continue;
		run("herdr", ["tab", "close", candidate.tab_id]);
	}
}

function ensureService(service) {
	if (service.instance === COMPUTER_INSTANCE) ensureComputerRuntime();
	const serviceCwd = service.cwd || PACKAGE_ROOT;
	let state = snapshot();
	if (!state) return { service: service.instance, running: false, recovered: false, error: "Herdr non raggiungibile" };
	let workspace = state.workspaces?.find((item) => item.label === service.workspace);
	if (!workspace) {
		const created = run("herdr", ["workspace", "create", "--cwd", serviceCwd, "--label", service.workspace, "--no-focus"]);
		if (created.status !== 0) return { service: service.instance, running: false, recovered: false, error: (created.stderr || "workspace non creato").trim() };
		state = snapshot(); workspace = state?.workspaces?.find((item) => item.label === service.workspace);
	}
	if (!workspace?.workspace_id) return { service: service.instance, running: false, recovered: false, error: "workspace senza workspace_id" };
	let tab = state.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === service.tab);
	let pane = tab && state.panes?.find((item) => item.tab_id === tab.tab_id);
	let agent = pane && state.agents?.find((item) => item.pane_id === pane.pane_id);
	const health = pane ? probeService(pane.pane_id, agent) : { healthy: false, reason: "pane_missing" };
	if (isLive(agent) && health.healthy) {
		closeInitialDuplicates(state, workspace.workspace_id, tab.tab_id, service);
		return { service: service.instance, running: true, recovered: false, health, workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id };
	}
	if (tab && agent) {
		const closed = run("herdr", ["tab", "close", tab.tab_id]);
		if (closed.status !== 0) return { service: service.instance, running: false, recovered: false, error: (closed.stderr || "tab di servizio non chiusa").trim() };
		state = snapshot(); workspace = state?.workspaces?.find((item) => item.label === service.workspace);
		tab = null; pane = null;
	}
	if (!tab || !pane) {
		const created = run("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", serviceCwd, "--label", service.tab, "--no-focus"]);
		if (created.status !== 0) return { service: service.instance, running: false, recovered: false, error: (created.stderr || "tab di servizio non creata").trim() };
		state = snapshot();
		tab = state?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === service.tab);
		pane = tab && state?.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!pane?.pane_id) return { service: service.instance, running: false, recovered: false, error: "pane di servizio non trovata" };
	const composedArgs = [path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs"), "--instance", service.instance, "--role", service.role, "--json", "--print-only"];
	if (service.project) composedArgs.push("--project", service.project);
	if (service.projectScope) composedArgs.push("--project-scope", service.projectScope);
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
	const after = snapshot();
	closeInitialDuplicates(after, workspace.workspace_id, tab.tab_id, service);
	const live = after?.agents?.find((item) => item.pane_id === pane.pane_id && isLive(item));
	const afterHealth = pane?.pane_id ? probeService(pane.pane_id, live) : { healthy: false, reason: "pane_missing_after_start" };
	return { service: service.instance, running: Boolean(live && afterHealth.healthy), recovered: true, health: afterHealth, workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, error: live && afterHealth.healthy || started.status === 0 ? null : (started.stderr || started.stdout || "Herdr non ha avviato l'agente").trim() };
}

export function ensureGlobalYanoServices() { return SERVICES.map(ensureService); }
export function ensureComputerLocalService() { return ensureService(SERVICES[2]); }

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(ensureGlobalYanoServices(), null, 2));
