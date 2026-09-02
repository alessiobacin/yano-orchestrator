import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVICES = [
	// Herdr infers the agent kind from the tab title while starting it. A tab
	// named exactly `yano-watcher`/`yano-debugger` is classified as a legacy
	// external kind and rejected as `--kind pi`; keep the workspace names but
	// use neutral owned tab labels.
	{ instance: "watcher-service", agentName: "watcher-service", role: "watcher", workspace: "yano-watcher", tab: "watcher-service" },
	{ instance: "debugger-service", agentName: "debugger-service", role: "debugger", workspace: "yano-debugger", tab: "debugger-service" },
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

function ensureService(service) {
	let state = snapshot();
	if (!state) return { service: service.instance, running: false, recovered: false, error: "Herdr non raggiungibile" };
	let workspace = state.workspaces?.find((item) => item.label === service.workspace);
	if (!workspace) {
		const created = run("herdr", ["workspace", "create", "--cwd", PACKAGE_ROOT, "--label", service.workspace, "--no-focus"]);
		if (created.status !== 0) return { service: service.instance, running: false, recovered: false, error: (created.stderr || "workspace non creato").trim() };
		state = snapshot(); workspace = state?.workspaces?.find((item) => item.label === service.workspace);
	}
	if (!workspace?.workspace_id) return { service: service.instance, running: false, recovered: false, error: "workspace senza workspace_id" };
	let tab = state.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === service.tab);
	let pane = tab && state.panes?.find((item) => item.tab_id === tab.tab_id);
	let agent = pane && state.agents?.find((item) => item.pane_id === pane.pane_id);
	if (isLive(agent)) return { service: service.instance, running: true, recovered: false, workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id };
	if (tab && agent) {
		const closed = run("herdr", ["tab", "close", tab.tab_id]);
		if (closed.status !== 0) return { service: service.instance, running: false, recovered: false, error: (closed.stderr || "tab di servizio non chiusa").trim() };
		state = snapshot(); workspace = state?.workspaces?.find((item) => item.label === service.workspace);
		tab = null; pane = null;
	}
	if (!tab || !pane) {
		const created = run("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", PACKAGE_ROOT, "--label", service.tab, "--no-focus"]);
		if (created.status !== 0) return { service: service.instance, running: false, recovered: false, error: (created.stderr || "tab di servizio non creata").trim() };
		state = snapshot();
		tab = state?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === service.tab);
		pane = tab && state?.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!pane?.pane_id) return { service: service.instance, running: false, recovered: false, error: "pane di servizio non trovata" };
	const composed = run(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs"), "--instance", service.instance, "--role", service.role, "--json", "--print-only"], { cwd: PACKAGE_ROOT });
	let args;
	try { args = JSON.parse(composed.stdout || "").args; } catch { return { service: service.instance, running: false, recovered: false, error: `composizione agente fallita: ${(composed.stderr || composed.stdout || "risposta vuota").trim()}` }; }
	// `herdr agent start` infers the current kind from a newly created tab's
	// title and rejects service names as non-Pi kinds. Starting Pi explicitly in
	// the owned pane lets the orchestrator extension publish the authoritative
	// Pi presence without that heuristic.
	const command = ["pi", ...args].map(shellQuote).join(" ");
	const started = run("herdr", ["pane", "run", pane.pane_id, `exec ${command}`], { cwd: PACKAGE_ROOT });
	const after = snapshot();
	const live = after?.agents?.find((item) => item.pane_id === pane.pane_id && isLive(item));
	return { service: service.instance, running: Boolean(live), recovered: true, workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, error: live || started.status === 0 ? null : (started.stderr || started.stdout || "Herdr non ha avviato l'agente").trim() };
}

export function ensureGlobalYanoServices() { return SERVICES.map(ensureService); }

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(ensureGlobalYanoServices(), null, 2));
