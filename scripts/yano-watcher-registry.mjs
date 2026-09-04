#!/usr/bin/env node

// Persistent registry + Herdr-tab supervision for the continuous, zero-token
// `yano watch` loop.
//
// Problem this closes: `yano watch --interval-ms 300000 --away` is a bare,
// self-rescheduling Node process (see scripts/watch-stalls.mjs). Started by
// hand in a terminal or a plain Herdr pane, it has no durable record of "this
// project is supposed to be watched" and no supervisor — a closed terminal, a
// Mac sleep/wake cycle or a crashed pane silently ends it, and nothing
// resurfaces the gap: `yano watcher projects` only reports Herdr/Pi presence
// that already exists (including the unrelated, proposal-scoped Architect
// ephemeral-watcher flow — `yano architect provision --install`), never
// "should be running but is not".
//
// This module gives the continuous watcher a durable registry and Herdr-tab
// lifecycle (launchHerdrWorker/doInit/doStart/doPause/doResume): `yano watcher
// init|start|pause|resume` register intended state in a small SQLite file
// and open/reuse a pane in the shared `yano-watcher` Herdr workspace running
// the existing bare `yano watch ... --away` loop — no LLM, no new agent kind.
// `yano watcher status` additionally cross-checks intended vs. live Herdr
// state and, unless told not to, relaunches a project whose pane died
// (self-heal), logging the recovery in that project's own trace.
//
// The watcher registry owns its own lifecycle and storage.
// (herdrSnapshot/shellQuote/slug), with one observable lifecycle and one
// persisted table: watcher_projects tracks whether a polling loop is alive.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { appendRawTraceRecord, canonicalProjectScope, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { projectDbPath } from "./yano-project.mjs";
import { ensureGlobalYanoServices } from "./yano-global-services.mjs";
import { superviseExternalServices, getService } from "./yano-services.mjs";
import { herdrSnapshot } from "./yano-herdr-client.mjs";
import { applyRetention } from "./yano-data.mjs";

// Cron launches with a minimal PATH. Herdr is commonly installed in the
// user's ~/.local/bin, so make the runtime independent from the interactive
// shell profile before any Herdr probe or recovery command is attempted.
const herdrBinDir = path.join(os.homedir(), ".local", "bin");
if (!String(process.env.PATH || "").split(path.delimiter).includes(herdrBinDir)) process.env.PATH = [herdrBinDir, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
import { installOneMinuteWindowsJob, removeOneMinuteWindowsJob, statusOneMinuteWindowsJob } from "./yano-os-scheduler.mjs";
import { agentTabIdentityAudit, findAgentIdentityConflicts, formatAgentIdentityConflicts } from "./yano-agent-identity.mjs";
import { superviseScheduler } from "./yano-scheduler.mjs";
import mqtt from "mqtt";
import { claimFeedback, listFeedback, openDatabase as openFeedbackDatabase } from "./yano-feedback.mjs";

const require = createRequire(import.meta.url);
const WORKSPACE_LABEL = "yano-watcher";
const DEFAULT_INTERVAL_MS = 60000; // un controllo ogni minuto; override esplicito con --interval-ms
const DEFAULT_LOOKBACK_MS = 3600000;
const DEFAULT_PLANNER_STALL_MS = 15 * 60_000;
const ORPHANED_TICKET_IDLE_MS = 2 * 60_000;
const PLANNER_RECOVERY_COOLDOWN_MS = 10 * 60_000;
const IDLE_WATCHER_GRACE_MS = 60 * 60_000;
const CRON_MARKER = "# yano-watcher-supervisor";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function value(argv, flag) { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; }
function has(argv, flag) { return argv.includes(flag); }

function slug(valueToSlug) {
	return String(valueToSlug || "project").toLowerCase().normalize("NFKD")
		.replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

function projectTabLabel(projectName) { return `watcher-${slug(projectName)}`.slice(0, 60); }

function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
	catch (error) { throw new Error(`yano watcher: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`); }
}

function dbPath() { return path.join(traceRoot(), "watcher", "watcher-registry.sqlite"); }

function openDatabase() {
	fs.mkdirSync(path.dirname(dbPath()), { recursive: true, mode: 0o700 });
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(dbPath());
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS watcher_projects (
			project_key TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			root TEXT NOT NULL UNIQUE,
			workspace_id TEXT,
			worker_tab_id TEXT,
			worker_pane_id TEXT,
			worker_instance TEXT,
			worker_status TEXT NOT NULL DEFAULT 'stopped',
			interval_ms INTEGER NOT NULL DEFAULT 60000,
			lookback_ms INTEGER NOT NULL DEFAULT 3600000,
			last_recovery_at TEXT,
			last_recovery_reason TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	// Existing global registries predate recovery bookkeeping. Keep the upgrade
	// idempotent so a supervisor can safely start after a package update.
	for (const column of ["last_recovery_at TEXT", "last_recovery_reason TEXT"]) {
		try { db.exec(`ALTER TABLE watcher_projects ADD COLUMN ${column}`); } catch { /* already present */ }
	}
	// Migrate the old implicit five-minute cadence to the control-plane
	// contract: the cron/supervisor must inspect every registered project every
	// minute. Explicit per-project overrides remain untouched.
	db.prepare("UPDATE watcher_projects SET interval_ms = 60000 WHERE interval_ms = 300000").run();
	return db;
}

function openProjectDatabase(root) {
	const file = projectDbPath(root);
	const legacy = path.join(root, ".yano", "orchestrator.db");
	const dbFile = fs.existsSync(file) ? file : legacy;
	if (!fs.existsSync(dbFile)) return null;
	try {
		const { DatabaseSync } = requireSqlite();
		return new DatabaseSync(dbFile, { readOnly: true });
	} catch { return null; }
}

function now() { return new Date().toISOString(); }

function projectInfo(projectRoot, explicitProject = null) {
	const root = path.resolve(projectRoot || process.cwd());
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`yano watcher: project root non valida: ${root}`);
	const name = String(explicitProject || resolveTraceProject(root)).trim();
	if (!name) throw new Error("yano watcher: nome progetto vuoto");
	return { root, name, key: projectKey(root, name) };
}

function ensureProject(db, info, { intervalMs = DEFAULT_INTERVAL_MS, lookbackMs = DEFAULT_LOOKBACK_MS } = {}) {
	const timestamp = now();
	const existing = db.prepare("SELECT * FROM watcher_projects WHERE project_key = ? OR root = ?").get(info.key, info.root);
	if (existing) {
		if (existing.project_key !== info.key) throw new Error(`yano watcher: la root è già registrata con un altro project key (${existing.project_key})`);
		db.prepare("UPDATE watcher_projects SET name = ?, interval_ms = ?, lookback_ms = ?, updated_at = ? WHERE project_key = ?")
			.run(info.name, intervalMs, lookbackMs, timestamp, info.key);
		return db.prepare("SELECT * FROM watcher_projects WHERE project_key = ?").get(info.key);
	}
	db.prepare("INSERT INTO watcher_projects(project_key,name,root,worker_status,interval_ms,lookback_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
		.run(info.key, info.name, info.root, "stopped", intervalMs, lookbackMs, timestamp, timestamp);
	return db.prepare("SELECT * FROM watcher_projects WHERE project_key = ?").get(info.key);
}

function getProject(db, info) {
	return db.prepare("SELECT * FROM watcher_projects WHERE project_key = ? OR root = ?").get(info.key, info.root);
}

function infoFromRow(row) { return { root: row.root, name: row.name, key: row.project_key }; }

function shellQuote(valueToQuote) {
	return process.platform === "win32" ? `"${String(valueToQuote).replaceAll('"', '\\"')}"` : `'${String(valueToQuote).replaceAll("'", `'"'"'`)}'`;
}

function renameHerdrTab(tabId, label) {
	if (!tabId || !label) return;
	const result = spawnSync("herdr", ["tab", "rename", tabId, label], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile rinominare la tab ${tabId} in ${label}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function closeHerdrTab(tabId) {
	if (!tabId) return { closed: false, reason: "missing_tab_id" };
	const result = spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
	return result.status === 0
		? { closed: true, tab_id: tabId }
		: { closed: false, tab_id: tabId, error: (result.stderr || result.stdout || "Herdr non ha chiuso la tab").trim() };
}

function watcherProcessMatches(row, paneId) {
	if (!paneId) return null;
	const result = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], { encoding: "utf8", maxBuffer: 2_000_000 });
	if (result.status !== 0) return null;
	try {
		const payload = JSON.parse(result.stdout || "");
		const processes = payload?.result?.process_info?.foreground_processes || [];
		if (!processes.length) return null;
		const command = processes.map((item) => item.cmdline || item.argv?.join(" ") || "").join(" ");
		return command.includes("yano watch") && command.includes(`--project-root ${row.root}`) && command.includes(`--interval-ms ${Math.max(1000, Number(row.interval_ms))}`) && command.includes(`--lookback-ms ${Math.max(1000, Number(row.lookback_ms))}`);
	} catch { return null; }
}

function repairAgentTabIdentities(snapshot) {
	const repaired = [];
	for (const conflict of agentTabIdentityAudit(snapshot)) {
		if (conflict.type !== "tab_identity_mismatch") continue;
		try {
			renameHerdrTab(conflict.tab_id, conflict.actual);
			repaired.push({ tab_id: conflict.tab_id, from: conflict.label, to: conflict.actual });
		} catch (error) {
			repaired.push({ tab_id: conflict.tab_id, from: conflict.label, to: conflict.actual, error: error instanceof Error ? error.message : String(error) });
		}
	}
	// Recovery tabs are implementation artefacts, never durable agents. A
	// previous race could leave several empty planner recovery tabs behind;
	// remove only tabs with no live pane/agent, never an active work tab.
	for (const tab of snapshot?.tabs || []) {
		if (!/^planner-\d{2}-recovery-/i.test(tab.label || "")) continue;
		const pane = (snapshot.panes || []).find((item) => item.tab_id === tab.tab_id);
		const agent = pane && (snapshot.agents || []).find((item) => item.pane_id === pane.pane_id);
		if (agent && !["done", "offline", "unknown", "stopped"].includes(String(agent.agent_status || "").toLowerCase())) continue;
		const closed = closeHerdrTab(tab.tab_id);
		repaired.push({ tab_id: tab.tab_id, action: "close_orphan_recovery_tab", ...closed });
	}
	return repaired;
}

function closeUnusedInitialTab(snapshot, workspaceId, keepTabId) {
	const initial = (snapshot?.tabs || []).find((tab) => tab.workspace_id === workspaceId && tab.tab_id !== keepTabId && /^(1|\d+)$/.test(tab.label || ""));
	if (!initial) return null;
	const pane = (snapshot?.panes || []).find((item) => item.tab_id === initial.tab_id);
	const agent = pane && (snapshot?.agents || []).find((item) => item.pane_id === pane.pane_id);
	if (agent && !["done", "offline", "unknown"].includes(String(agent.agent_status || "").toLowerCase())) return null;
	return closeHerdrTab(initial.tab_id);
}

function projectRuns(root) {
	const db = openProjectDatabase(root);
	if (!db) return { available: false, runs: [] };
	try {
		const runs = db.prepare(`
			SELECT r.id, r.project, r.objective, r.status, r.finalization_status, r.updated_at,
			       MAX(COALESCE(e.created_at, r.updated_at)) AS last_activity_at,
			       COUNT(DISTINCT CASE WHEN h.status = 'open' THEN h.id END) AS open_holds
			FROM runs r
			LEFT JOIN events e ON e.run_id = r.id
			LEFT JOIN decision_holds h ON h.run_id = r.id
			GROUP BY r.id
			ORDER BY r.updated_at DESC
		`).all();
		const tickets = db.prepare("SELECT id, run_id, title, status, assigned_instance, required_playbook, updated_at FROM tickets ORDER BY updated_at DESC").all();
		const dependencies = db.prepare("SELECT d.ticket_id, d.depends_on_id, dependency.status AS dependency_status FROM ticket_dependencies d JOIN tickets dependency ON dependency.id = d.depends_on_id").all();
		const dependenciesByTicket = new Map();
		for (const dependency of dependencies) {
			if (!dependenciesByTicket.has(dependency.ticket_id)) dependenciesByTicket.set(dependency.ticket_id, []);
			dependenciesByTicket.get(dependency.ticket_id).push(dependency);
		}
		const byRun = new Map();
		for (const ticket of tickets) {
			if (!byRun.has(ticket.run_id)) byRun.set(ticket.run_id, []);
			byRun.get(ticket.run_id).push(ticket);
		}
		const bindings = new Map(db.prepare("SELECT run_id, playbook_id, checksum, snapshot FROM playbook_bindings").all().map((binding) => {
			let snapshot = null; try { snapshot = JSON.parse(binding.snapshot); } catch {}
			return [binding.run_id, { ...binding, snapshot }];
		}));
		const runtimeStates = new Map(db.prepare("SELECT run_id, state_id, generation, updated_at FROM playbook_runtime_state").all().map((state) => [state.run_id, state]));
		return { available: true, runs: runs.map((run) => {
			const runTickets = byRun.get(run.id) || [];
			const binding = bindings.get(run.id) || null;
			const flowViolations = [];
			for (const ticket of runTickets) {
				const deps = dependenciesByTicket.get(ticket.id) || [];
				if (["running", "done"].includes(ticket.status)) {
					const unfinished = deps.filter((dependency) => dependency.dependency_status !== "done");
					if (unfinished.length) flowViolations.push({ kind: "ticket_out_of_order", ticket_id: ticket.id, status: ticket.status, unfinished_dependencies: unfinished.map((item) => ({ ticket_id: item.depends_on_id, status: item.dependency_status })) });
				}
				if (binding?.playbook_id && ticket.required_playbook && ticket.required_playbook !== binding.playbook_id) flowViolations.push({ kind: "ticket_playbook_mismatch", ticket_id: ticket.id, required_playbook: ticket.required_playbook, bound_playbook: binding.playbook_id });
			}
			const runtime = runtimeStates.get(run.id) || null;
			const terminalStates = new Set((binding?.snapshot?.states || []).filter((state) => state.terminal === true).map((state) => state.id));
			if (run.status === "active" && runtime?.state_id && terminalStates.has(runtime.state_id) && runtime.state_id !== "blocked") flowViolations.push({ kind: "active_run_in_terminal_playbook_state", state_id: runtime.state_id });
			return {
				...run,
				tickets: runTickets,
				playbook_binding: binding ? { playbook_id: binding.playbook_id, checksum: binding.checksum } : null,
				playbook_state: runtime,
				playbook_flow: { status: flowViolations.length ? "violation" : "ordered", violations: flowViolations },
				active_ticket_count: runTickets.filter((ticket) => ["pending", "running"].includes(ticket.status)).length,
				running_ticket_count: runTickets.filter((ticket) => ticket.status === "running").length,
				pending_ticket_count: runTickets.filter((ticket) => ticket.status === "pending").length,
				ready_pending_tickets: runTickets.filter((ticket) => ticket.status === "pending" && (dependenciesByTicket.get(ticket.id) || []).every((dependency) => dependency.dependency_status === "done")).map((ticket) => ticket.id),
			};
		}) };
	} catch { return { available: false, runs: [] }; }
	finally { try { db.close(); } catch { /* best effort */ } }
}

function projectHasActiveWork(root) {
	return projectRuns(root).runs.some(runNeedsPlanner);
}

function runNeedsPlanner(run) {
	// A completed run is terminal. `pending_finalize` is an administrative
	// state, not evidence of live work, so it must never trigger an LLM wake-up.
	return run.status === "active";
}

export { runNeedsPlanner, projectNeedsPlanner };

function projectNeedsPlanner(root) {
	const state = projectRuns(root);
	if (!state.available) return false;
	return state.runs.some((run) => runNeedsPlanner(run) || Number(run.open_holds || 0) > 0);
}

export function findProjectWorkspace(snapshot, root, project) {
	// Workspace labels are user-facing and are not a stable identity: Herdr
	// preserves casing while Yano may derive a normalized project name. The
	// canonical identity is the project root. Prefer a case-insensitive label
	// match, then rank candidates by evidence that they actually belong to the
	// root and contain a live planner. This prevents a stale recovery workspace
	// from winning over the original project workspace (for example `llmproxy`
	// versus `llmProxy`).
	const expectedRoot = path.resolve(root || "");
	const expectedLabel = String(project || "").trim().toLocaleLowerCase();
	const candidates = (snapshot?.workspaces || []).filter((workspace) =>
		String(workspace.label || "").trim().toLocaleLowerCase() === expectedLabel,
	);
	if (!candidates.length) return null;
	const score = (workspace) => {
		const panes = (snapshot?.panes || []).filter((pane) => pane.workspace_id === workspace.workspace_id);
		const hasRootPane = panes.some((pane) => path.resolve(pane.cwd || "") === expectedRoot);
		const planners = (snapshot?.agents || []).filter((agent) =>
			agent.workspace_id === workspace.workspace_id &&
			path.resolve(agent.cwd || "") === expectedRoot &&
			(plannerLabelForAgent(snapshot, agent) || /planner/i.test(`${agent.terminal_title_stripped || ""} ${agent.terminal_title || ""} ${agent.name || ""}`)),
		);
		const livePlanner = planners.some((planner) => ["idle", "working"].includes(String(planner.agent_status || "").toLowerCase()));
		const exactLabel = workspace.label === project;
		return (livePlanner ? 1000 : 0) + (hasRootPane ? 100 : 0) + (exactLabel ? 10 : 0);
	};
	return candidates
		.map((workspace, index) => ({ workspace, index, score: score(workspace) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)[0].workspace;
}

function plannerAgentsInWorkspace(snapshot, workspaceId, root) {
	return (snapshot?.agents || []).filter((agent) =>
		agent.workspace_id === workspaceId &&
		path.resolve(agent.cwd || "") === path.resolve(root) &&
		(plannerLabelForAgent(snapshot, agent) || /planner/i.test(`${agent.terminal_title_stripped || ""} ${agent.terminal_title || ""} ${agent.name || ""}`)),
	);
}

// Herdr can expose a live Pi pane without copying Pi's instance name into
// `agent.name` (notably after a restart). The tab label is the durable Yano
// identity in that case; ignoring it made every healthy planner look missing
// and caused a new recovery tab to be created on every supervisor pass.
function plannerLabelForAgent(snapshot, agent) {
	const tab = snapshot?.tabs?.find((item) => item.tab_id === agent.tab_id);
	return Boolean(tab && /^planner(?:-\d+)?$/i.test(tab.label || ""));
}

function plannerHeartbeatHealthy(planner) {
	const status = String(planner?.agent_status || "unknown").toLowerCase();
	if (!["idle", "working"].includes(status)) return false;
	const heartbeat = Date.parse(planner?.last_heartbeat || "");
	if (Number.isFinite(heartbeat)) return Date.now() - heartbeat <= 120_000;
	// Older Herdr snapshots do not expose MQTT heartbeat fields. In that case
	// use the authoritative pane process plus Herdr's explanation API rather
	// than treating an otherwise live planner as dead every minute.
	if (!planner?.pane_id) return false;
	const processInfo = spawnSync("herdr", ["pane", "process-info", "--pane", planner.pane_id], { encoding: "utf8" });
	let process;
	try { process = JSON.parse(processInfo.stdout || "")?.result?.process_info?.foreground_processes?.[0]; } catch { process = null; }
	if (!process?.pid) return false;
	const explained = spawnSync("herdr", ["agent", "explain", planner.pane_id, "--json"], { encoding: "utf8" });
	let explanation;
	try { explanation = JSON.parse(explained.stdout || ""); } catch { explanation = null; }
	return ["idle", "working"].includes(String(explanation?.state || status).toLowerCase()) && explanation?.warning == null && explanation?.visible_blocker !== true;
}

export function ensureRegisteredPlanner(row, snapshot, db = null) {
	if (!snapshot || !fs.existsSync(row.root)) return { recovery: "project_unavailable" };
	// A registered project may be idle or contain only terminal runs. Planner
	// liveness is required for active work or an open user decision hold, not as
	// a reason to manufacture a fresh planner session for every completed project.
	if (!projectNeedsPlanner(row.root)) return { recovery: "no_active_run", planner_status: "not_required" };
	const workspace = findProjectWorkspace(snapshot, row.root, row.name);
	const planners = workspace ? plannerAgentsInWorkspace(snapshot, workspace.workspace_id, row.root) : [];
	const healthy = planners.find(plannerHeartbeatHealthy);
	if (healthy) return { recovery: "planner_healthy", planner_status: healthy.agent_status || "unknown", planner_instance: healthy.name || null };
	const reason = "planner_missing_or_stale_heartbeat";
	// Unlike reconcileProjectRun, this check used to run unconditionally on
	// every one-minute supervisor pass. A momentarily flaky heartbeat read
	// (snapshot lag right after Mac sleep/Herdr restart, or a just-recovered
	// planner that has not published its first heartbeat yet) made it close
	// and relaunch the planner tab again and again — once per minute, forever
	// — each relaunch paying for a fresh multi-hundred-MB recovery snapshot.
	// The same cooldown reconcileProjectRun already respects must gate this
	// path too, or the two recovery entry points race each other.
	if (recoveryCoolingDown(row, reason)) {
		return { recovery: "recovery_cooldown", recovery_reason: reason, last_recovery_at: row.last_recovery_at };
	}
	// A dead/blocked planner tab must not be reused as if it were live. Close it
	// first; recoverPlanner will create a clean planner-01 pane in the verified
	// project workspace and launch the normal guarded Yano command.
	for (const planner of planners) {
		const tab = snapshot.tabs?.find((item) => item.tab_id === planner.tab_id);
		if (tab) closeHerdrTab(tab.tab_id);
	}
	const recovered = recoverPlanner({ row, snapshot: herdrSnapshot() || snapshot, run: { id: "planner-presence", status: "active", finalization_status: "not_started" }, reason });
	if (db) db.prepare("UPDATE watcher_projects SET last_recovery_at = ?, last_recovery_reason = ?, updated_at = ? WHERE project_key = ?").run(now(), reason, now(), row.project_key);
	return { recovery: "planner_recovered", ...recovered };
}

function paneHasLivePiProcess(paneId) {
	if (!paneId) return false;
	const result = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], { encoding: "utf8" });
	try {
		const processes = JSON.parse(result.stdout || "")?.result?.process_info?.foreground_processes || [];
		return processes.some((item) => item?.argv0 === "pi" || item?.argv?.some((arg) => /(?:^|\/)pi(?:\.m?js)?$/.test(String(arg))));
	} catch { return false; }
}

function cleanupCompletedAgentTabs(snapshot, row, runs, plannerRequired) {
	if (!snapshot) return [];
	const terminalAssignments = new Set(runs.flatMap((run) => (run.tickets || [])
		.filter((ticket) => ["done", "failed"].includes(ticket.status) && ticket.assigned_instance)
		.map((ticket) => ticket.assigned_instance)));
	const isTerminalAssignment = (instance) => [...terminalAssignments].some((assigned) =>
		instance === assigned || instance.startsWith(`${assigned}-`) || assigned.startsWith(`${instance}-`));
	const removed = [];
	for (const agent of snapshot.agents || []) {
		if (path.resolve(agent.cwd || "") !== path.resolve(row.root)) continue;
		const instance = String(agent.name || agent.instance || agent.terminal_title_stripped || "");
		const isPlanner = /planner/i.test(instance);
		const terminalTask = isTerminalAssignment(instance);
		const status = String(agent.agent_status || "unknown").toLowerCase();
		const dead = !paneHasLivePiProcess(agent.pane_id);
		// Never close a live planner needed by an open hold/active run. For
		// specialists, close only terminal-task sessions or dead panes; a live
		// unassigned/busy pane is left untouched to avoid killing user work.
		if (isPlanner && plannerRequired && !dead) continue;
		if (!terminalTask && !dead) continue;
		if (!dead && !["idle", "offline", "unknown", "stopped", "done"].includes(status)) continue;
		const tab = snapshot.tabs?.find((item) => item.tab_id === agent.tab_id);
		if (!tab) continue;
		const closed = closeHerdrTab(tab.tab_id);
		removed.push({ tab_id: tab.tab_id, pane_id: agent.pane_id, instance, reason: dead ? "dead_process" : "terminal_ticket", ...closed });
	}
	if (removed.length) {
		try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_completed_agent_tabs_closed", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", closed: removed } }); } catch { /* best effort */ }
	}
	return removed;
}

function plannerStalled(run) {
	if (Number(run.open_holds || 0) > 0) return false;
	const activity = Date.parse(run.last_activity_at || run.updated_at || "");
	return Number.isFinite(activity) && Date.now() - activity >= (Number(process.env.YANO_PLANNER_STALL_MS) || DEFAULT_PLANNER_STALL_MS);
}

function ticketAgentStatus(snapshot, root, instance) {
	if (!snapshot || !instance) return null;
	const candidates = (snapshot.agents || []).filter((agent) => path.resolve(agent.cwd || "") === path.resolve(root));
	for (const agent of candidates) {
		const tab = snapshot.tabs?.find((item) => item.tab_id === agent.tab_id);
		const identity = [agent.name, agent.instance, agent.terminal_title_stripped, agent.terminal_title, tab?.label].filter(Boolean).join(" ");
		if (identity === instance || identity.split(/\s+/).some((part) => part === instance)) return String(agent.agent_status || "unknown").toLowerCase();
	}
	return null;
}

function orphanedRunningTickets(run, snapshot, root) {
	if (!snapshot) return [];
	return (run.tickets || []).filter((ticket) => {
		if (ticket.status !== "running" || !ticket.assigned_instance) return false;
		const updated = Date.parse(ticket.updated_at || "");
		if (!Number.isFinite(updated) || Date.now() - updated < ORPHANED_TICKET_IDLE_MS) return false;
		// A missing agent is also orphaned. Previously only an explicitly idle
		// Herdr card matched, so a killed lazy worker (notably the performance
		// benchmarker) could leave the DAG running forever with no recovery signal.
		return [null, "unknown", "idle", "offline", "dead"].includes(ticketAgentStatus(snapshot, root, ticket.assigned_instance));
	});
}

function notifyPlannerOfOrphanedTickets(row, snapshot, run, orphaned) {
	const workspace = findProjectWorkspace(snapshot, row.root, row.name);
	const planner = workspace && plannerAgentsInWorkspace(snapshot, workspace.workspace_id, row.root).find(plannerHeartbeatHealthy);
	if (!planner?.pane_id) return { notified: false, reason: "planner_not_live" };
	const ticketText = orphaned.map((item) => `${item.ticket.id} (${item.ticket.assigned_instance})`).join(", ");
	const prompt = `[yano-watcher specialist recovery] Il run ${run.id} ha ticket running senza worker vivo: ${ticketText}. Non creare ticket duplicati. Riprendi dal checkpoint, chiudi/riavvia solo gli agenti specialistici mancanti e continua il flusso fino alla risposta finale. Il planner è già vivo: non riavviare il planner.`;
	const scope = projectKey(row.root, row.name);
	const code = `import mqtt from ${JSON.stringify("mqtt")}; const c=await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL||"mqtt://127.0.0.1:1883",{connectTimeout:3000}); await c.publishAsync(${JSON.stringify(`pi/${scope}/agents/${planner.name || "planner-01"}/commands`)},JSON.stringify(${JSON.stringify({ type: "watcher_specialist_recovery", sender_instance: "yano-watcher", sender_role: "watcher", project: row.name, run_id: run.id, prompt })}),{qos:1}); await c.endAsync();`;
	const launched = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: row.root, encoding: "utf8", timeout: 5000 });
	return launched.status === 0 ? { notified: true, planner_pane_id: planner.pane_id, planner_instance: planner.name || "planner-01", ticket_ids: orphaned.map((item) => item.ticket.id) } : { notified: false, reason: "planner_notification_failed", error: (launched.stderr || "").trim() };
}

async function notifyYanoOrchestratorPlanner(flow, sourceProject) {
	const root = PACKAGE_ROOT;
	let snapshot = herdrSnapshot();
	const row = { name: "yano-orchestrator", root, project_key: projectKey(root, "yano-orchestrator") };
	let workspace = findProjectWorkspace(snapshot, root, "yano-orchestrator");
	let planner = workspace && plannerAgentsInWorkspace(snapshot, workspace.workspace_id, root).find(plannerHeartbeatHealthy);
	if (!planner) {
		try {
			recoverPlanner({ row, snapshot, run: { id: "playbook-flow-audit", status: "active", finalization_status: "not_started" }, reason: "playbook_flow_violation" });
			snapshot = herdrSnapshot() || snapshot;
			workspace = findProjectWorkspace(snapshot, root, "yano-orchestrator");
			planner = workspace && plannerAgentsInWorkspace(snapshot, workspace.workspace_id, root).find(plannerHeartbeatHealthy);
		} catch (error) { return { notified: false, reason: "planner_recovery_failed", error: error instanceof Error ? error.message : String(error) }; }
	}
	if (!planner?.name) return { notified: false, reason: "planner_not_live" };
	const scope = projectKey(root, "yano-orchestrator");
	const prompt = `[yano-watcher playbook audit] Violazione deterministica del flusso rilevata nel progetto ${sourceProject}. Run ${flow.run_id}. Evidenze: ${JSON.stringify(flow)}. Analizza e correggi il problema nel codice/configurazione di Yano; non modificare il progetto sorgente e non creare ticket duplicati.`;
	const client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3000 });
	try { await client.publishAsync(`pi/${scope}/agents/${planner.name}/commands`, JSON.stringify({ type: "watcher_playbook_flow_violation", sender_instance: "yano-watcher", sender_role: "watcher", source_project: sourceProject, ...flow, prompt }), { qos: 1 }); return { notified: true, planner_instance: planner.name }; }
	finally { await client.endAsync(); }
}

function readyPendingTickets(run) {
	return (run.ready_pending_tickets || []).filter(Boolean);
}

function recoveryCoolingDown(row, reason) {
	if (row.last_recovery_reason !== reason || !row.last_recovery_at) return false;
	const elapsed = Date.now() - Date.parse(row.last_recovery_at);
	return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PLANNER_RECOVERY_COOLDOWN_MS;
}

function stopCompletedWatcher(db, row, snapshot, recovery) {
	const tabExists = Boolean(row.worker_tab_id && snapshot?.tabs?.some((tab) => tab.tab_id === row.worker_tab_id));
	const closed = tabExists ? closeHerdrTab(row.worker_tab_id) : { closed: false, reason: "tab_already_absent" };
	// Closing a tab is best effort; the durable desired state must be stopped
	// even when Herdr already lost the tab, otherwise the next cron pass brings
	// a completed project's watcher back to life.
	db.prepare("UPDATE watcher_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run("stopped", now(), row.project_key);
	try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_project_completed", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", closed_tab: closed, recovery } }); } catch { /* best effort */ }
	return { recovery, watcher_closed: closed.closed, watcher_close_error: closed.error || null, watcher_tab_absent: !tabExists };
}

function recoverPlanner({ row, snapshot, run, reason }) {
	const workspaceRoot = path.join(traceRoot(), "agent-workspaces", "recovery");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	let current = snapshot;
	let workspace = findProjectWorkspace(current, row.root, row.name);
	if (!workspace) {
		const created = spawnSync("herdr", ["workspace", "create", "--cwd", row.root, "--label", row.name, "--focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error((created.stderr || "workspace non creato").trim());
		current = herdrSnapshot() || current;
		workspace = findProjectWorkspace(current, row.root, row.name);
	}
	if (!workspace) throw new Error(`workspace Herdr non trovato per ${row.name}`);
	// A stale planner can still be registered by Herdr as an apparently live
	// identity. Reusing its pane would make `yano start` reject recovery as a
	// duplicate instance. Close only planners that fail the heartbeat gate,
	// then refresh before selecting or creating the replacement pane.
	for (const planner of plannerAgentsInWorkspace(current, workspace.workspace_id, row.root)) {
		// A planner process can be technically healthy while its orchestration
		// state is orphaned (for example a reviewer finished but the final
		// handoff was rejected). In that case a clean restart is the recovery,
		// not another optimistic "planner_present" result.
		if (!["planner_handoff_missing", "planner_ready_queue_stalled"].includes(reason) && plannerHeartbeatHealthy(planner)) continue;
		const staleTab = current.tabs?.find((item) => item.tab_id === planner.tab_id);
		if (staleTab) closeHerdrTab(staleTab.tab_id);
	}
	current = herdrSnapshot() || current;
	workspace = findProjectWorkspace(current, row.root, row.name);
	if (!workspace) {
		const created = spawnSync("herdr", ["workspace", "create", "--cwd", row.root, "--label", row.name, "--focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error((created.stderr || "workspace non ricreato").trim());
		current = herdrSnapshot() || current;
		workspace = findProjectWorkspace(current, row.root, row.name);
	}
	if (!workspace) throw new Error(`workspace Herdr non ricreato per ${row.name}`);
	const livePlanner = plannerAgentsInWorkspace(current, workspace.workspace_id, row.root)[0];
	let tab = livePlanner && current?.tabs?.find((item) => item.tab_id === livePlanner.tab_id);
	let pane = livePlanner && current?.panes?.find((item) => item.pane_id === livePlanner.pane_id);
	if (!pane) {
		tab = current?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === "planner-01");
		pane = tab && current?.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!pane) {
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", row.root, "--label", "planner-01", "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error((created.stderr || "tab planner non creata").trim());
		current = herdrSnapshot() || current;
		tab = current?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === "planner-01");
		pane = tab && current?.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!pane) throw new Error(`pane planner non trovato per ${row.name}`);
	// The snapshot can change between the initial health check and this launch
	// (another supervisor or a manual start may have brought the planner back).
	// Never send a second planner-01 command into a pane after that race.
	const alreadyHealthy = plannerAgentsInWorkspace(current, workspace.workspace_id, row.root).find(plannerHeartbeatHealthy);
	if (alreadyHealthy) {
		const healthyTab = current.tabs?.find((item) => item.tab_id === alreadyHealthy.tab_id);
		return {
			recovered: false,
			reused_existing: true,
			workspace_id: workspace.workspace_id,
			planner_tab_id: healthyTab?.tab_id || alreadyHealthy.tab_id,
			planner_pane_id: alreadyHealthy.pane_id,
			run_id: run.id,
			recovery_reason: reason,
		};
	}
	const prompt = `[yano-watcher recovery] Il progetto ${row.name} richiede ripristino (${reason}). Controlla SQLite, trace, run ${run.id}, ticket pending/running e worktree. Il run non è concluso (status=${run.status}, finalization_status=${run.finalization_status || "not_started"}). Non ricreare ticket esistenti; riprendi dal checkpoint osservabile, riattiva gli agenti mancanti e porta il lavoro fino alla risposta finale all'utente.`;
	const launched = spawnSync("herdr", ["pane", "run", pane.pane_id, `yano start --instance planner-01 --role planner --project ${shellQuote(row.name)} ${shellQuote(prompt)}`], { cwd: row.root, encoding: "utf8" });
	if (launched.status !== 0) throw new Error((launched.stderr || "planner non riavviato").trim());
	return { recovered: true, workspace_id: workspace.workspace_id, planner_tab_id: tab.tab_id, planner_pane_id: pane.pane_id, run_id: run.id, recovery_reason: reason };
}

function reconcileProjectRun(db, row, snapshot) {
	const identityConflicts = snapshot ? findAgentIdentityConflicts(snapshot).filter((conflict) => path.resolve(conflict.root) === path.resolve(row.root)) : [];
	if (identityConflicts.length) {
		return { recovery: "identity_conflict", watcher_kept: true, identity_conflicts: identityConflicts, recovery_error: formatAgentIdentityConflicts(identityConflicts).join("; ") };
	}
	const { available, runs } = projectRuns(row.root);
	// Registration is explicit user intent. A project can exist before its
	// first Yano run (or while its checkout is temporarily unavailable), so a
	// missing DB must not silently disable a running watcher after the idle
	// grace period. The zero-token scan reports `not_initialized`; closure is
	// reserved for initialized projects with no active runs or explicit leave.
	if (!available) return { recovery: "waiting_for_initialization", watcher_kept: true };
	if (!runs.length) return { recovery: "project_idle", watcher_kept: true };
	const incomplete = runs.filter(runNeedsPlanner);
	const flowViolations = runs.flatMap((run) => (run.playbook_flow?.violations || []).map((violation) => ({ run_id: run.id, ...violation })));
	if (flowViolations.length) {
		try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "playbook_flow_violation", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", project: row.name, violations: flowViolations } }); } catch { /* audit must not stop supervision */ }
	}
	if (incomplete.length) {
		const workspace = findProjectWorkspace(snapshot, row.root, row.name);
		const planners = workspace ? plannerAgentsInWorkspace(snapshot, workspace.workspace_id, row.root) : [];
		const orphaned = incomplete.flatMap((run) => orphanedRunningTickets(run, snapshot, row.root).map((ticket) => ({ run, ticket })));
		const ready = incomplete.flatMap((run) => readyPendingTickets(run).map((ticketId) => ({ run, ticket_id: ticketId })));
		const plannersIdle = planners.length > 0 && planners.every((planner) => String(planner.agent_status || "unknown").toLowerCase() === "idle");
		const held = incomplete.filter((run) => Number(run.open_holds || 0) > 0);
		const stalled = incomplete.filter((run) => Number(run.open_holds || 0) === 0 && (plannerStalled(run) || orphaned.some((item) => item.run.id === run.id) || (plannersIdle && ready.some((item) => item.run.id === run.id))));
		const reason = orphaned.length ? "planner_handoff_missing" : ready.length && plannersIdle ? "planner_ready_queue_stalled" : stalled.length ? "planner_stalled" : "planner_missing";
		if (orphaned.length && planners.some(plannerHeartbeatHealthy)) {
			const targetRun = orphaned[0].run;
			const notification = notifyPlannerOfOrphanedTickets(row, snapshot, targetRun, orphaned.filter((item) => item.run.id === targetRun.id));
			try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_specialist_recovery_requested", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", run_id: targetRun.id, tickets: orphaned.map((item) => item.ticket.id), notification } }); } catch { /* best effort */ }
			return { recovery: "specialist_recovery_requested", incomplete_runs: incomplete.map((run) => run.id), notification, planner_statuses: planners.map((planner) => planner.agent_status || "unknown") };
		}
		if (planners.length && !stalled.length) return { recovery: held.length ? "waiting_for_user" : "planner_present", incomplete_runs: incomplete.map((run) => run.id), planner_statuses: planners.map((planner) => planner.agent_status || "unknown"), playbook_flow: flowViolations.length ? "violation" : "ordered", playbook_flow_violations: flowViolations };
		if (recoveryCoolingDown(row, reason)) return { recovery: "recovery_cooldown", incomplete_runs: incomplete.map((run) => run.id), recovery_reason: reason, last_recovery_at: row.last_recovery_at };
		try {
			const recovered = recoverPlanner({ row, snapshot, run: (stalled[0] || incomplete[0]), reason });
			db.prepare("UPDATE watcher_projects SET last_recovery_at = ?, last_recovery_reason = ?, updated_at = ? WHERE project_key = ?").run(now(), reason, now(), row.project_key);
			try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_planner_recovered", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", run_ids: incomplete.map((run) => run.id), ...recovered } }); } catch { /* best effort */ }
			return { recovery: "planner_recovered", incomplete_runs: incomplete.map((run) => run.id), ...recovered };
		} catch (error) {
			return { recovery: "planner_recovery_failed", incomplete_runs: incomplete.map((run) => run.id), recovery_error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { recovery: "project_completed", watcher_kept: true, playbook_flow: flowViolations.length ? "violation" : "ordered", playbook_flow_violations: flowViolations };
}

function findOrCreateWatcherWorkspace(snapshot, root, dryRun = false) {
	let workspace = snapshot?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (workspace) return { workspace, created: false };
	if (dryRun) return { workspace: { workspace_id: null, label: WORKSPACE_LABEL }, created: false, dry_run: true };
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", root, "--label", WORKSPACE_LABEL, "--focus"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile creare il workspace Herdr "${WORKSPACE_LABEL}"${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	try {
		const parsed = JSON.parse(result.stdout);
		workspace = parsed?.result?.workspace || parsed?.workspace;
	} catch { /* refresh below */ }
	if (!workspace?.workspace_id) workspace = herdrSnapshot()?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (!workspace?.workspace_id) throw new Error("yano watcher: Herdr ha creato il workspace ma non ha restituito workspace_id");
	return { workspace, created: true };
}

// Same shared-tab convention documented in docs/quick-guides/10-watcher-falle-yano.md
// for the Architect ephemeral-proposal flow (workspace `yano-watcher`, tab
// `watcher-<project-name>`): a project watched through either path lands on
// the same pane, so there is exactly one continuous watcher per project,
// never two racing loops.
function launchHerdrWorker({ project, root, db, row, intervalMs, lookbackMs, dryRun }) {
	const workspaceRoot = path.join(traceRoot(), "agent-workspaces", WORKSPACE_LABEL);
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const instance = row.worker_instance || `watcher-${project.name}`;
	const command = `yano watch --project-root ${shellQuote(root)} --interval-ms ${Math.max(1000, Number(intervalMs))} --lookback-ms ${Math.max(1000, Number(lookbackMs))} --away`;
	if (dryRun) {
		db.prepare("UPDATE watcher_projects SET worker_instance = ?, worker_status = ?, interval_ms = ?, lookback_ms = ?, updated_at = ? WHERE project_key = ?")
			.run(instance, "planned", intervalMs, lookbackMs, now(), project.key);
		return { workspace_id: row.workspace_id, tab_id: row.worker_tab_id, pane_id: row.worker_pane_id, instance, command, dry_run: true };
	}
	const snapshot = herdrSnapshot();
	if (!snapshot) throw new Error("yano watcher: Herdr non raggiungibile; avvia Herdr e riprova");
	const workspaceResult = findOrCreateWatcherWorkspace(snapshot, workspaceRoot);
	const { workspace } = workspaceResult;
	const tabLabel = projectTabLabel(project.name);
	let refreshed = herdrSnapshot() || snapshot;
	let tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && (item.label === tabLabel || item.tab_id === row.worker_tab_id));
	let pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	if (tab && tab.label !== tabLabel) {
		renameHerdrTab(tab.tab_id, tabLabel);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.tab_id === tab.tab_id);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab) {
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", root, "--label", tabLabel, "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error(`yano watcher: Herdr non ha creato la tab ${tabLabel}${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === tabLabel);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab || !pane) throw new Error(`yano watcher: workspace Herdr pronto ma tab/pane non trovati per ${tabLabel}`);
	const launched = spawnSync("herdr", ["pane", "run", pane.pane_id, `exec ${command}`], { cwd: root, encoding: "utf8" });
	if (launched.status !== 0) throw new Error(`yano watcher: avvio del loop di polling fallito${launched.stderr ? `: ${launched.stderr.trim()}` : ""}`);
	const timestamp = now();
	db.prepare("UPDATE watcher_projects SET workspace_id = ?, worker_tab_id = ?, worker_pane_id = ?, worker_instance = ?, worker_status = ?, interval_ms = ?, lookback_ms = ?, updated_at = ? WHERE project_key = ?")
		.run(workspace.workspace_id, tab.tab_id, pane.pane_id, instance, "running", intervalMs, lookbackMs, timestamp, project.key);
	closeUnusedInitialTab(herdrSnapshot(), workspace.workspace_id, tab.tab_id);
	return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, instance, command, dry_run: dryRun };
}

function watcherOnce(info, project) {
	const scope = canonicalProjectScope(info.root, info.name);
	const trace = readTraceRecords({ cwd: info.root, project: scope, limit: 200 });
	const scans = trace.filter((record) => record.type === "yano_watcher_scan");
	const findings = trace.filter((record) => record.type === "yano_watcher_finding");
	return {
		once: true,
		read_only: true,
		project: scope,
		project_root: info.root,
		worker_started: false,
		worker_status: project.worker_status,
		trace_records: trace.length,
		scans_seen: scans.length,
		last_scan_at: scans.at(-1)?.ts || null,
		findings_seen: findings.length,
		message: "Preflight watcher completata: nessuna tab Herdr, nessun processo persistente e nessuna modifica al progetto.",
	};
}

// --- shared watcher operations ---

function doInit(db, info, opts = {}) {
	const project = ensureProject(db, info, { intervalMs: Math.max(1000, Number(opts.intervalMs || DEFAULT_INTERVAL_MS)), lookbackMs: Math.max(1000, Number(opts.lookbackMs || DEFAULT_LOOKBACK_MS)) });
	// Registration means visible-by-default. `pause`/`leave` are the explicit
	// opt-out commands; init must not leave a project in a permanently hidden
	// stopped state that the minute supervisor silently respects.
	const started = project.worker_status === "paused"
		? { worker_status: "paused", hidden: true, note: "progetto già messo in pausa esplicitamente" }
		: launchHerdrWorker({ project: info, root: info.root, db, row: project, intervalMs: project.interval_ms, lookbackMs: project.lookback_ms, dryRun: false });
	return { project: { ...project, ...(started.worker_status ? { worker_status: started.worker_status } : { worker_status: "running", ...started }) }, db_path: dbPath() };
}

function doStart(db, info, opts = {}) {
	const registered = getProject(db, info);
	const intervalMs = Math.max(1000, Number(opts.intervalMs || registered?.interval_ms || DEFAULT_INTERVAL_MS));
	const lookbackMs = Math.max(1000, Number(opts.lookbackMs || registered?.lookback_ms || DEFAULT_LOOKBACK_MS));
	const project = ensureProject(db, info, { intervalMs, lookbackMs });
	if (opts.once) return watcherOnce(info, project);
	if (project.worker_status === "running" && !opts.dryRun && !opts.force) {
		return { project: info.name, worker_status: "running", already_running: true, workspace_id: project.workspace_id, tab_id: project.worker_tab_id, instance: project.worker_instance };
	}
	const launched = opts.foreground
		? { workspace_id: project.workspace_id, tab_id: project.worker_tab_id, pane_id: project.worker_pane_id, instance: project.worker_instance || `watcher-${info.name}`, command: `yano watch --project-root ${shellQuote(info.root)} --interval-ms ${intervalMs} --lookback-ms ${lookbackMs} --away`, supervisor: "foreground", dry_run: Boolean(opts.dryRun) }
		: launchHerdrWorker({ project: info, root: info.root, db, row: project, intervalMs, lookbackMs, dryRun: Boolean(opts.dryRun) });
	if (opts.foreground) db.prepare("UPDATE watcher_projects SET worker_instance = ?, worker_status = ?, interval_ms = ?, lookback_ms = ?, updated_at = ? WHERE project_key = ?").run(launched.instance, opts.dryRun ? "planned" : "running", intervalMs, lookbackMs, now(), project.project_key);
	return { project: info.name, worker_status: opts.dryRun ? "planned" : "running", ...launched };
}

function doPause(db, info, existing) {
	const snapshot = herdrSnapshot();
	const closed = existing.worker_tab_id && snapshot?.tabs?.some((tab) => tab.tab_id === existing.worker_tab_id)
		? closeHerdrTab(existing.worker_tab_id) : { closed: false, reason: "tab_already_absent" };
	db.prepare("UPDATE watcher_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run("paused", now(), existing.project_key);
	const result = { project: info.name, worker_status: "paused", hidden: true, watcher_closed: closed.closed, note: "pausa esplicita: la tab viene nascosta e il supervisore non la riapre" };
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "watcher_registry_pause", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", worker_status: "paused" } }); } catch { /* best effort */ }
	return result;
}

function doLeave(db, info, existing, { dryRun = false } = {}) {
	if (!existing) return { project: info.name, left: false, reason: "not_registered" };
	const snapshot = herdrSnapshot();
	const tabExists = Boolean(existing.worker_tab_id && snapshot?.tabs?.some((tab) => tab.tab_id === existing.worker_tab_id));
	const closed = dryRun || !tabExists ? { closed: false, reason: dryRun ? "dry_run" : "tab_already_absent" } : closeHerdrTab(existing.worker_tab_id);
	if (!dryRun) {
		db.prepare("DELETE FROM watcher_projects WHERE project_key = ?").run(existing.project_key);
		try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "watcher_project_left", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", closed_tab: closed } }); } catch { /* best effort */ }
	}
	return { project: info.name, left: !dryRun, dry_run: dryRun, watcher_closed: closed.closed, watcher_close_error: closed.error || null };
}

function doResume(db, info, existing, opts = {}) {
	if (existing.worker_status === "running" && !opts.dryRun && !opts.force) {
		return { project: info.name, worker_status: "running", already_running: true, workspace_id: existing.workspace_id, tab_id: existing.worker_tab_id, instance: existing.worker_instance };
	}
	const intervalMs = Math.max(1000, Number(opts.intervalMs || existing.interval_ms || DEFAULT_INTERVAL_MS));
	const lookbackMs = Math.max(1000, Number(opts.lookbackMs || existing.lookback_ms || DEFAULT_LOOKBACK_MS));
	const launched = opts.foreground
		? { workspace_id: existing.workspace_id, tab_id: existing.worker_tab_id, pane_id: existing.worker_pane_id, instance: existing.worker_instance || `watcher-${info.name}`, command: `yano watch --project-root ${shellQuote(info.root)} --interval-ms ${intervalMs} --lookback-ms ${lookbackMs} --away`, supervisor: "foreground", dry_run: Boolean(opts.dryRun) }
		: launchHerdrWorker({ project: info, root: info.root, db, row: existing, intervalMs, lookbackMs, dryRun: Boolean(opts.dryRun) });
	const status = opts.dryRun ? "planned" : "running";
	db.prepare("UPDATE watcher_projects SET worker_status = ?, interval_ms = ?, lookback_ms = ?, updated_at = ? WHERE project_key = ?").run(status, intervalMs, lookbackMs, now(), existing.project_key);
	const result = { project: info.name, worker_status: status, ...launched, note: "worker ripristinato dal registro persistente" };
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "watcher_registry_resume", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", worker_status: status } }); } catch { /* best effort */ }
	return result;
}

// Cross-checks the registry's intended state against the live Herdr snapshot
// and — unless disabled — relaunches a project whose pane silently died
// (Mac sleep, Herdr restart, crashed pane, closed terminal). This is what
// closes the original gap: a stopped watcher used to be invisible until
// someone happened to check `herdr agent list`; now the routine status call
// itself notices and repairs it.
function doStatusForRow(db, row, { heal = true, snapshot: suppliedSnapshot = null } = {}) {
	const info = infoFromRow(row);
	const base = { ...row, live: null, drift: false, recovered: false };
	if (row.worker_status !== "running") return base; // paused/stopped/planned: respect the explicit state, nothing to heal
	if (!row.worker_pane_id) return { ...base, live: "unknown", drift: false }; // e.g. started with --foreground: not Herdr-managed, nothing this check can observe
	const snapshot = suppliedSnapshot || herdrSnapshot();
	if (!snapshot) return { ...base, live: "unknown", note: "Herdr non raggiungibile: impossibile verificare lo stato reale" };
	const identity_conflicts = findAgentIdentityConflicts(snapshot).filter((conflict) => path.resolve(conflict.root) === path.resolve(row.root));
	const tab = snapshot.tabs?.find((item) => item.tab_id === row.worker_tab_id);
	const pane = tab && snapshot.panes?.find((item) => item.pane_id === row.worker_pane_id);
	if (tab && pane) {
		// The registry is authoritative for cadence. Older workers may still be
		// alive with the former five-minute interval after an upgrade; keeping
		// them marked healthy silently defeats the one-minute supervisor contract.
		const watcherMatches = watcherProcessMatches(row, pane.pane_id);
		if (watcherMatches === false) {
			const closed = closeHerdrTab(tab.tab_id);
			try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_worker_restarted_for_config_drift", record_type: "event", source: "yano-watcher-registry", expected_interval_ms: row.interval_ms, expected_lookback_ms: row.lookback_ms, previous_tab_id: tab.tab_id, close: closed } }); } catch { /* best effort */ }
			try {
				const relaunched = launchHerdrWorker({ project: infoFromRow(row), root: row.root, db, row, intervalMs: row.interval_ms, lookbackMs: row.lookback_ms, dryRun: false });
				return { ...base, live: "restarted", drift: true, recovered: true, worker_config_repaired: true, ...relaunched, ...reconcileProjectRun(db, row, herdrSnapshot()) };
			} catch (error) {
				return { ...base, live: "config_drift", drift: true, recovered: false, worker_config_repaired: false, recover_error: error instanceof Error ? error.message : String(error) };
			}
		}
		const runs = projectRuns(row.root).runs;
		const plannerRequired = projectNeedsPlanner(row.root);
		const agent_tabs_closed = heal ? cleanupCompletedAgentTabs(snapshot, row, runs, plannerRequired) : [];
		const planner = heal ? (() => { try { return ensureRegisteredPlanner(row, snapshot, db); } catch (error) { return { recovery: "planner_recovery_failed", recovery_error: error instanceof Error ? error.message : String(error) }; } })() : { recovery: "not_checked" };
		return { ...base, live: "running", identity_conflicts, planner, agent_tabs_closed, ...reconcileProjectRun(db, row, snapshot) };
	}
	const drifted = { ...base, live: "not_found", drift: true };
	if (!heal) return drifted;
	try {
		const relaunched = launchHerdrWorker({ project: info, root: row.root, db, row, intervalMs: row.interval_ms, lookbackMs: row.lookback_ms, dryRun: false });
		try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_worker_recovered", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", previous_tab_id: row.worker_tab_id, previous_pane_id: row.worker_pane_id } }); } catch { /* best effort */ }
		return { ...drifted, recovered: true, ...relaunched, worker_status: "running", ...reconcileProjectRun(db, row, herdrSnapshot()) };
	} catch (error) {
		return { ...drifted, recovered: false, recover_error: error instanceof Error ? error.message : String(error) };
	}
}

function supervisorLockPath() { return path.join(traceRoot(), "watcher", "supervisor.lock"); }
function supervisorHeartbeatPath() { return path.join(traceRoot(), "watcher", "supervisor-heartbeat.json"); }
function retentionMarkerPath() { return path.join(traceRoot(), "retention", "last-run.json"); }
function superviseRetention() {
	const marker = retentionMarkerPath();
	let last = 0;
	try { last = Date.parse(JSON.parse(fs.readFileSync(marker, "utf8")).completed_at || "") || 0; } catch {}
	if (Date.now() - last < 86_400_000) return { skipped: true, reason: "daily_cadence", last_run_at: last ? new Date(last).toISOString() : null };
	const result = applyRetention({ root: traceRoot(), yes: true });
	fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
	fs.writeFileSync(marker, JSON.stringify({ completed_at: now(), files: result.files.length, bytes: result.bytes, action: result.action || "none", backup: result.backup }, null, 2), { mode: 0o600 });
	return { ...result, scheduled: true };
}

async function withSupervisorLock(callback) {
	const lock = supervisorLockPath();
	fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
	let fd;
	try {
		fd = fs.openSync(lock, "wx");
		fs.writeSync(fd, `${process.pid}\n${now()}\n`);
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		try {
			const lockContents = fs.readFileSync(lock, "utf8").split(/\s+/);
			const ownerPid = Number(lockContents[0]);
			let ownerAlive = false;
			if (Number.isInteger(ownerPid) && ownerPid > 1) {
				try { process.kill(ownerPid, 0); ownerAlive = true; } catch (probeError) { ownerAlive = probeError?.code === "EPERM"; }
			}
			const age = Date.now() - fs.statSync(lock).mtimeMs;
			// A dead owner always releases the lock on the next invocation. The
			// age fallback remains for old lock files written before PID metadata
			// existed, but a live long-running supervisor is never overlapped just
			// because one pass needs more than two minutes.
			if (!ownerAlive || age > 120_000) {
				// A live PID is not proof of a healthy supervisor: synchronous Herdr
				// probes or a deadlocked child can keep it alive indefinitely. The
				// supervisor is intentionally bounded; terminate only this control
				// process after two minutes, never a project agent.
				if (ownerAlive && ownerPid !== process.pid) {
					try { process.kill(ownerPid, "SIGTERM"); } catch {}
					for (let attempt = 0; attempt < 5; attempt++) { try { process.kill(ownerPid, 0); } catch { break; } spawnSync("sleep", ["0.1"], { encoding: "utf8" }); }
					try { process.kill(ownerPid, "SIGKILL"); } catch {}
				}
				fs.unlinkSync(lock);
				fd = fs.openSync(lock, "wx");
				fs.writeSync(fd, `${process.pid}\n${now()}\n`);
			} else return { skipped: true, reason: "supervisor_already_running", lock_path: lock };
		} catch (retryError) {
			return { skipped: true, reason: "supervisor_lock_unavailable", lock_path: lock, detail: retryError instanceof Error ? retryError.message : String(retryError) };
		}
	}
	try {
		try { fs.writeFileSync(supervisorHeartbeatPath(), JSON.stringify({ checked_at: now(), pid: process.pid, status: "running" }, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
		const heartbeatTimer = setInterval(() => { try { fs.writeFileSync(supervisorHeartbeatPath(), JSON.stringify({ checked_at: now(), pid: process.pid, status: "running" }, null, 2), { mode: 0o600 }); } catch {} }, 30_000);
		try { return await callback(); } finally { clearInterval(heartbeatTimer); }
	} finally {
		try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
		try { fs.unlinkSync(lock); } catch { /* best effort */ }
	}
}

function pruneOrphanWatcherTabs(snapshot, rows) {
	if (!snapshot) return [];
	const knownRoots = new Set(rows.map((row) => path.resolve(row.root)));
	const removed = [];
	for (const tab of snapshot.tabs || []) {
		if (/^(debugger|suggester)(-|$)/i.test(tab.label || "")) {
			const closed = closeHerdrTab(tab.tab_id);
			removed.push({ tab_id: tab.tab_id, label: tab.label, root: null, obsolete_agent: true, ...closed });
			continue;
		}
		if (!/^watcher-/i.test(tab.label || "")) continue;
		const pane = (snapshot.panes || []).find((item) => item.tab_id === tab.tab_id);
		const root = pane?.cwd ? path.resolve(pane.cwd) : null;
		if (!root || (root !== path.resolve(traceRoot()) && !knownRoots.has(root) && !fs.existsSync(root))) {
			const closed = closeHerdrTab(tab.tab_id);
			removed.push({ tab_id: tab.tab_id, label: tab.label, root, ...closed });
		}
	}
	return removed;
}

function activateDefaultWorkers(db, row) {
	// Every registered project is visible by default. Only `paused` is an
	// explicit per-project opt-out; `stopped` is a recoverable stale state.
	if (row.worker_status !== "stopped" || !fs.existsSync(row.root)) return null;
	const info = infoFromRow(row);
	const watcher = doStart(db, info, { intervalMs: row.interval_ms, lookbackMs: row.lookback_ms });
	return {
		project: row.name,
		root: row.root,
		activated: true,
		watcher: { worker_status: watcher.worker_status, instance: watcher.instance || null },
	};
}

async function superviseFeedbackQueue(rows, snapshot) {
	const result = { checked: 0, delivered: 0, claimed: [], deferred: [] };
	let feedbackDb;
	try { feedbackDb = openFeedbackDatabase(); } catch (error) { return { ...result, error: error instanceof Error ? error.message : String(error) }; }
	const pending = listFeedback(feedbackDb, { statuses: ["pending_planner", "queued", "retry"] });
	if (!pending.length) { feedbackDb.close(); return result; }
	let client;
	try { client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3000 }); } catch (error) { feedbackDb.close(); return { ...result, checked: pending.length, error: error instanceof Error ? error.message : String(error) }; }
	try {
		for (const item of pending) {
			result.checked++;
			const row = rows.find((candidate) => candidate.project_key === item.project_id || candidate.name === item.project_id || slug(candidate.name) === slug(item.project_id));
			const workspace = row && findProjectWorkspace(snapshot, row.root, row.name);
			const planner = workspace && plannerAgentsInWorkspace(snapshot, workspace.workspace_id, row.root).find(plannerHeartbeatHealthy);
			if (!planner) { result.deferred.push({ id: item.id, project_id: item.project_id, reason: "planner_not_live" }); continue; }
			const scope = row?.project_key || item.project_id;
			await client.publishAsync(`pi/${scope}/agents/${planner.name || "planner-01"}/commands`, JSON.stringify({ type: "feedback_received", feedback_type: item.type, feedback_id: item.id, project_id: item.project_id, message: item.message, resolution: item.resolution, screenshots: item.screenshots || [], requires_user_confirmation: item.type === "suggestion" || item.resolution === "user_confirmation", sender_instance: "yano-watcher", sender_role: "watcher" }), { qos: 1 });
			claimFeedback(feedbackDb, item.id); result.delivered++; result.claimed.push(item.id);
		}
	} finally { try { await client.endAsync(); } catch {} feedbackDb.close(); }
	return result;
}

function supervise(db) {
	return withSupervisorLock(async () => {
		const rows = db.prepare("SELECT * FROM watcher_projects ORDER BY updated_at DESC").all();
		// User-declared external dependencies (Docker/pm2/llmProxy/...) run
		// FIRST, before this pass's own Herdr snapshot: if the operator has
		// registered a service literally named "herdr" (`yano services add
		// --name herdr --healthcheck-command "..." --restart-command "..."`),
		// this is what gives Herdr itself a chance to be restarted before the
		// snapshot below is attempted — Yano does not guess how to start Herdr
		// on an unknown machine (GUI app, background service, ...), the
		// operator declares it once like any other dependency.
		let external_services;
		try { external_services = await superviseExternalServices({ includeBuiltIns: true }); } catch (error) { external_services = { error: error instanceof Error ? error.message : String(error) }; }
		const herdrServiceRegistered = Boolean(getService("herdr"));
		// herdrSnapshot() itself retries with backoff (ticket #118): a
		// transient blip — Herdr's server still waking up right after being
		// restarted above, or after the machine itself just rebooted — no
		// longer needs to wait for the next one-minute cron tick to resolve.
		const snapshot = herdrSnapshot();
		const orphan_tabs_removed = pruneOrphanWatcherTabs(snapshot, rows);
		const agent_identity_repaired = snapshot ? repairAgentTabIdentities(snapshot) : [];
		const repairedSnapshot = agent_identity_repaired.length ? herdrSnapshot() : snapshot;
		const identityConflicts = repairedSnapshot ? [...findAgentIdentityConflicts(repairedSnapshot), ...agentTabIdentityAudit(repairedSnapshot)] : [];
		for (const conflict of identityConflicts) {
			const row = rows.find((candidate) => path.resolve(candidate.root) === path.resolve(conflict.root));
			if (row) appendRawTraceRecord({ cwd: row.root, project: resolveTraceProject(row.root), record: { type: "watcher_identity_conflict", payload: conflict } });
		}
		const global_services = ensureGlobalYanoServices();
		// The watcher supervisor is the single deterministic control-plane pass:
		// reconcile services/projects and the scheduler registry in the same
		// minute. A queued schedule is not healthy until its bridge returns an
		// observable result; failures/timeouts are retried here and preserved in
		// scheduler JSON plus the global watcher log.
		let scheduler;
		try { scheduler = await superviseScheduler({ now: new Date() }); }
		catch (error) { scheduler = { checked_at: now(), error: error instanceof Error ? error.message : String(error) }; }
		let retention;
		try { retention = superviseRetention(); } catch (error) { retention = { error: error instanceof Error ? error.message : String(error) }; }
		try {
			const logPath = path.join(path.dirname(dbPath()), "..", "logs", "watcher-global.jsonl");
			fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
			fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event: "global_watch_supervision", scheduler, retention, global_services, projects: rows.length })}\n`, { mode: 0o600 });
		} catch { /* recovery must not be blocked by logging */ }
		// Refresh the activation state after global-service recovery.
		const activated = [...rows.map((row) => activateDefaultWorkers(db, row)).filter(Boolean)];
		let feedback_queue;
		try { feedback_queue = await superviseFeedbackQueue(rows, repairedSnapshot); } catch (error) { feedback_queue = { error: error instanceof Error ? error.message : String(error) }; }
		const projectResults = rows.map((row) => doStatusForRow(db, row, { heal: true, snapshot: repairedSnapshot }));
		const playbook_flow_alerts = [];
		for (let index = 0; index < projectResults.length; index++) {
			const item = projectResults[index];
			if (!item.playbook_flow_violations?.length) continue;
			try { playbook_flow_alerts.push({ project: rows[index].name, ...await notifyYanoOrchestratorPlanner(item.playbook_flow_violations[0], rows[index].name) }); }
			catch (error) { playbook_flow_alerts.push({ project: rows[index].name, notified: false, reason: error instanceof Error ? error.message : String(error) }); }
		}
		const result = {
			checked_at: now(),
			herdr_reachable: Boolean(snapshot),
			herdr_service_registered: herdrServiceRegistered,
			projects: projectResults,
			playbook_flow_alerts,
			activated,
			feedback_queue,
			global_services,
			scheduler,
			retention,
			external_services,
			external_workers: [],
			orphan_tabs_removed,
			agent_identity_repaired,
			identity_conflicts: identityConflicts,
			errors: formatAgentIdentityConflicts(identityConflicts),
		};
		try { fs.writeFileSync(supervisorHeartbeatPath(), JSON.stringify({ checked_at: result.checked_at, pid: process.pid, status: "idle", project_count: rows.length, external_recoveries: result.external_workers }, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
		return result;
	});
}

function readCrontab() {
	const result = spawnSync("crontab", ["-l"], { encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status === 0) return result.stdout || "";
	if (/no crontab for|can't open crontab/i.test(`${result.stdout || ""}\n${result.stderr || ""}`)) return "";
	throw new Error(`yano watcher: impossibile leggere il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function cronCommand() {
	return `PATH=${shellQuote(herdrBinDir)}:\$PATH ${shellQuote(process.execPath)} ${shellQuote(path.join(PACKAGE_ROOT, "bin", "yano.mjs"))} watcher supervise --json >/dev/null 2>&1 ${CRON_MARKER}`;
}

function cronInstall() {
	const windows = installOneMinuteWindowsJob({ marker: CRON_MARKER, command: cronCommand() });
	if (windows) return windows;
	const line = `* * * * * ${cronCommand()}`;
	const existing = readCrontab().split("\n").filter((item) => item.trim() && !item.includes(CRON_MARKER));
	const content = [...existing, line].join("\n") + "\n";
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile installare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: true, schedule: "* * * * *", command: line, marker: CRON_MARKER, backend: "crontab" };
}

function cronStatus() {
	const windows = statusOneMinuteWindowsJob({ marker: CRON_MARKER });
	let heartbeat = null;
	try { heartbeat = JSON.parse(fs.readFileSync(supervisorHeartbeatPath(), "utf8")); } catch { /* not run yet */ }
	const heartbeatAt = heartbeat?.checked_at || null;
	const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - Date.parse(heartbeatAt)) : null;
	const healthy = Boolean(heartbeatAt && heartbeatAgeMs <= 130_000);
	if (windows) return { ...windows, installed: windows.installed, last_heartbeat_at: heartbeatAt, heartbeat_age_ms: heartbeatAgeMs, healthy: Boolean(windows.installed && healthy) };
	const line = readCrontab().split("\n").find((item) => item.includes(CRON_MARKER)) || null;
	return { installed: Boolean(line), schedule: line ? "* * * * *" : null, command: line, marker: CRON_MARKER, backend: "crontab", last_heartbeat_at: heartbeatAt, heartbeat_age_ms: heartbeatAgeMs, healthy: Boolean(line && healthy) };
}

function cronRemove() {
	const windows = removeOneMinuteWindowsJob({ marker: CRON_MARKER });
	if (windows) return windows;
	const existing = readCrontab().split("\n").filter((item) => item.trim() && !item.includes(CRON_MARKER));
	const content = existing.length ? `${existing.join("\n")}\n` : "";
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile rimuovere il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: false, removed: true, marker: CRON_MARKER, backend: "crontab" };
}

function print(valueToPrint, machine) {
	if (machine) console.log(JSON.stringify(valueToPrint, null, 2));
	else if (Array.isArray(valueToPrint)) for (const item of valueToPrint) console.log(`${item.name || item.project} — ${item.worker_status}${item.drift ? " (drift: pane non trovato)" : ""}${item.recovered ? " → recuperato" : ""}`);
	else console.log(JSON.stringify(valueToPrint, null, 2));
}

function parseCommand(argv) {
	const sub = argv[0];
	return {
		sub,
		cronAction: argv[1] || null,
		projectRoot: value(argv, "--project-root") || null,
		project: value(argv, "--project"),
		intervalMs: value(argv, "--interval-ms") ? Number(value(argv, "--interval-ms")) : null,
		lookbackMs: value(argv, "--lookback-ms") ? Number(value(argv, "--lookback-ms")) : null,
		json: has(argv, "--json"),
		dryRun: has(argv, "--dry-run"),
		once: has(argv, "--once"),
		foreground: has(argv, "--foreground"),
		force: has(argv, "--force"),
		yes: has(argv, "--yes"),
		noHeal: has(argv, "--no-heal"),
		help: has(argv, "--help") || has(argv, "-h"),
	};
}

function usage() {
	return [
		"Uso: yano watcher <init|start|status|pause|resume|leave|supervise|cron|projects> [opzioni]",
		"",
		"  init --project-root <dir> [--interval-ms 60000] [--lookback-ms 3600000]",
		"                                                     registra e apre subito la tab del watcher",
		"  start --project-root <dir> [--dry-run]            apre/riusa la tab Herdr del watcher continuo (yano-watcher)",
		"  start --project-root <dir> --once                 esegue una sola preflight read-only senza avviare Herdr",
		"  status [--project-root <dir>] [--no-heal] [--json]",
		"                                                     mostra lo stato registrato di uno o tutti i progetti e,",
		"                                                     salvo --no-heal, rilancia il pane se risulta morto",
		"  pause|resume --project-root <dir>                 sospende/riattiva il loop di polling",
		"  leave --project-root <dir> --yes                  rimuove definitivamente il progetto dal registro e chiude la tab se presente",
		"  supervise [--json]                                controllo globale idempotente; rilancia ogni watcher atteso ma morto",
		"  cron install|status|remove                        installa/verifica/rimuove il controllo globale ogni minuto",
		"  projects|list [--json]                             registro persistente, stato e presenza di ogni watcher",
		"",
		"`start`/`resume` lanciano il comando bounded/zero-token già esistente",
		"(`yano watch --interval-ms ... --away`, vedi scripts/watch-stalls.mjs) in una",
		"tab Herdr supervisionata; nessun agente LLM viene avviato per il polling.",
		"Il registro sopravvive a un riavvio: `yano watcher status` verifica lo stato",
		"reale e ripristina automaticamente un pane morto (Mac in sleep, terminale",
		"chiuso, Herdr riavviato) salvo pausa esplicita.",
	].join("\n");
}

export async function runYanoWatcherRegistry({ argv = [] } = {}) {
	const opts = parseCommand(argv);
	if (opts.sub === "list") opts.sub = "projects";
	if (!opts.sub || opts.sub === "--help" || opts.sub === "-h" || opts.help) { console.log(usage()); return { help: true }; }
	const db = openDatabase();
	try {
		if (opts.sub === "projects") {
			const rows = db.prepare("SELECT * FROM watcher_projects ORDER BY name, root").all();
			const result = rows.map((row) => doStatusForRow(db, row, { heal: false }));
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "init") {
			const info = projectInfo(opts.projectRoot, opts.project);
			const result = doInit(db, info, { intervalMs: opts.intervalMs, lookbackMs: opts.lookbackMs });
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "start") {
			const info = projectInfo(opts.projectRoot, opts.project);
			const result = doStart(db, info, { intervalMs: opts.intervalMs, lookbackMs: opts.lookbackMs, once: opts.once, dryRun: opts.dryRun, foreground: opts.foreground, force: opts.force });
			print(result, opts.json);
			return result;
		}
		if (["pause", "resume", "leave"].includes(opts.sub)) {
			// `leave` must also clean stale registrations whose temporary checkout
			// was deleted (common after smoke tests). Resolve the persisted row by
			// canonical root before applying the normal directory validation used by
			// pause/resume/start.
			let info;
			let existing;
			if (opts.sub === "leave" && opts.projectRoot) {
				const requestedRoot = path.resolve(opts.projectRoot);
				existing = db.prepare("SELECT * FROM watcher_projects WHERE root = ?").get(requestedRoot);
				if (existing) info = { root: existing.root, name: existing.name, key: existing.project_key };
			}
			if (!info) {
				info = projectInfo(opts.projectRoot, opts.project);
				existing ||= getProject(db, info);
			}
			if (opts.sub === "leave" && !opts.yes && !opts.dryRun) throw new Error("yano watcher leave: aggiungi --yes per rimuovere definitivamente il progetto dal watcher");
			if (!existing && opts.sub !== "leave") throw new Error("yano watcher: progetto non registrato; esegui prima `yano watcher init`");
			const result = opts.sub === "pause" ? doPause(db, info, existing) : opts.sub === "leave" ? doLeave(db, info, existing, { dryRun: opts.dryRun }) : doResume(db, info, existing, { dryRun: opts.dryRun, force: opts.force, intervalMs: opts.intervalMs, lookbackMs: opts.lookbackMs, foreground: opts.foreground });
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "status") {
			const heal = !opts.noHeal;
			if (opts.projectRoot) {
				const info = projectInfo(opts.projectRoot, opts.project);
				const row = getProject(db, info);
				if (!row) { print({ registered: false, project: info.name, root: info.root }, opts.json); return { registered: false }; }
				const result = doStatusForRow(db, row, { heal });
				print(result, opts.json);
				return result;
			}
			const rows = db.prepare("SELECT * FROM watcher_projects ORDER BY updated_at DESC").all();
			const results = rows.map((row) => doStatusForRow(db, row, { heal }));
			print(results, opts.json);
			return results;
		}
		if (opts.sub === "supervise") {
			const result = await supervise(db);
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "cron") {
			const action = opts.cronAction || "status";
			const result = action === "install" ? cronInstall() : action === "remove" ? cronRemove() : action === "status" ? cronStatus() : (() => { throw new Error(`yano watcher: azione cron sconosciuta "${action}"; usa install, status o remove`); })();
			print(result, opts.json);
			return result;
		}
		throw new Error(`yano watcher: comando sconosciuto "${opts.sub}".\n${usage()}`);
	} finally {
		try { db.close(); } catch { /* ignore */ }
	}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runYanoWatcherRegistry({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano watcher: ${error.message}`); process.exit(1); });
