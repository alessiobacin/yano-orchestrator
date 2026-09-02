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
// This module gives the continuous watcher the same durable-registry +
// Herdr-tab lifecycle the debugger already has in yano-debugger.mjs
// (launchHerdrWorker/doInit/doStart/doPause/doResume): `yano watcher
// init|start|pause|resume` register intended state in a small SQLite file
// and open/reuse a pane in the shared `yano-watcher` Herdr workspace running
// the existing bare `yano watch ... --away` loop — no LLM, no new agent kind.
// `yano watcher status` additionally cross-checks intended vs. live Herdr
// state and, unless told not to, relaunches a project whose pane died
// (self-heal), logging the recovery in that project's own trace.
//
// Deliberately mirrors yano-debugger.mjs's shape closely: same primitives
// (herdrSnapshot/shellQuote/slug), same CLI/REST-would-be split conventions,
// so the two supervised subsystems do not drift apart in behavior. Kept as
// its own file/table (watcher_projects, not debugger_projects) because the
// two registries track different things: the debugger tracks *diagnosed
// application bugs*, this tracks *whether a polling loop is alive*.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { appendRawTraceRecord, canonicalProjectScope, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { projectDbPath } from "./yano-project.mjs";
import { ensureGlobalYanoServices } from "./yano-global-services.mjs";
import { superviseExternalServices } from "./yano-services.mjs";
import { findAgentIdentityConflicts, formatAgentIdentityConflicts } from "./yano-agent-identity.mjs";

const require = createRequire(import.meta.url);
const WORKSPACE_LABEL = "yano-watcher";
const DEFAULT_INTERVAL_MS = 300000; // 5 minuti — override esplicito con --interval-ms
const DEFAULT_LOOKBACK_MS = 3600000;
const DEFAULT_PLANNER_STALL_MS = 15 * 60_000;
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
			interval_ms INTEGER NOT NULL DEFAULT 300000,
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

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
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
		return { available: true, runs };
	} catch { return { available: false, runs: [] }; }
	finally { try { db.close(); } catch { /* best effort */ } }
}

function projectHasActiveWork(root) {
	return projectRuns(root).runs.some(runNeedsPlanner);
}

function runNeedsPlanner(run) {
	return run.status === "active" || (run.status === "completed" && !["finalized", "not_applicable"].includes(run.finalization_status));
}

function findProjectWorkspace(snapshot, root, project) {
	// A project can have specialist tabs in a shared workspace (for example
	// `code-mem`). Matching by any pane cwd therefore restarts the wrong
	// project's planner. The recovery workspace is the explicitly labelled
	// project workspace; create it if it was lost.
	return snapshot?.workspaces?.find((workspace) => workspace.label === project) || null;
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

function plannerStalled(run) {
	if (Number(run.open_holds || 0) > 0) return false;
	const activity = Date.parse(run.last_activity_at || run.updated_at || "");
	return Number.isFinite(activity) && Date.now() - activity >= (Number(process.env.YANO_PLANNER_STALL_MS) || DEFAULT_PLANNER_STALL_MS);
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
	if (incomplete.length) {
		const workspace = findProjectWorkspace(snapshot, row.root, row.name);
		const planners = workspace ? plannerAgentsInWorkspace(snapshot, workspace.workspace_id, row.root) : [];
		const stalled = incomplete.filter(plannerStalled);
		const held = incomplete.filter((run) => Number(run.open_holds || 0) > 0);
		const reason = stalled.length ? "planner_stalled" : "planner_missing";
		if (planners.length && !stalled.length) return { recovery: held.length ? "waiting_for_user" : "planner_present", incomplete_runs: incomplete.map((run) => run.id), planner_statuses: planners.map((planner) => planner.agent_status || "unknown") };
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
	return { recovery: "project_completed", watcher_kept: true };
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

// Same shared-tab convention documented in docs/quick_guides/10-watcher-falle-yano.md
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

// --- shared operations, mirroring yano-debugger.mjs's doInit/doStart/doPause/doResume ---

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
function doStatusForRow(db, row, { heal = true } = {}) {
	const info = infoFromRow(row);
	const base = { ...row, live: null, drift: false, recovered: false };
	if (row.worker_status !== "running") return base; // paused/stopped/planned: respect the explicit state, nothing to heal
	if (!row.worker_pane_id) return { ...base, live: "unknown", drift: false }; // e.g. started with --foreground: not Herdr-managed, nothing this check can observe
	const snapshot = herdrSnapshot();
	if (!snapshot) return { ...base, live: "unknown", note: "Herdr non raggiungibile: impossibile verificare lo stato reale" };
	const identity_conflicts = findAgentIdentityConflicts(snapshot).filter((conflict) => path.resolve(conflict.root) === path.resolve(row.root));
	const tab = snapshot.tabs?.find((item) => item.tab_id === row.worker_tab_id);
	const pane = tab && snapshot.panes?.find((item) => item.pane_id === row.worker_pane_id);
	if (tab && pane) return { ...base, live: "running", identity_conflicts, ...reconcileProjectRun(db, row, snapshot) };
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
			const age = Date.now() - fs.statSync(lock).mtimeMs;
			if (age > 120_000) {
				fs.unlinkSync(lock);
				fd = fs.openSync(lock, "wx");
				fs.writeSync(fd, `${process.pid}\n${now()}\n`);
			} else return { skipped: true, reason: "supervisor_already_running", lock_path: lock };
		} catch (retryError) {
			return { skipped: true, reason: "supervisor_lock_unavailable", lock_path: lock, detail: retryError instanceof Error ? retryError.message : String(retryError) };
		}
	}
	try {
		return await callback();
	} finally {
		try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
		try { fs.unlinkSync(lock); } catch { /* best effort */ }
	}
}

function externalWorkerRecovery(snapshot) {
	const results = [];
	const dataRoot = traceRoot();
	const launch = (args, detail) => {
		const result = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, "bin", "yano.mjs"), ...args], { encoding: "utf8", maxBuffer: 4_000_000 });
		results.push({ ...detail, recovered: result.status === 0, error: result.status === 0 ? null : (result.stderr || result.stdout || "external recovery failed").trim() });
	};
	// A proposal with an installed Architect instance is durable for the whole
	// proposal lifecycle: initially project-scoped/ephemeral, then global only
	// after an explicit promotion. Drafts awaiting a first install are omitted.
	const architectDb = path.join(dataRoot, "architect", "architect.sqlite");
	if (fs.existsSync(architectDb)) {
		try {
			const { DatabaseSync } = requireSqlite();
			const externalDb = new DatabaseSync(architectDb, { readOnly: true });
			const rows = externalDb.prepare("SELECT proposal_id, architect_instance, status FROM architect_proposals WHERE architect_instance IS NOT NULL AND status IN ('provisioning','ready_ephemeral','promotion_candidate','revision_required','persistent')").all();
			externalDb.close();
			for (const row of rows) {
				const live = snapshot?.agents?.some((agent) => agent.agent === "pi" && agent.name === row.architect_instance && !["done", "offline", "unknown"].includes(agent.agent_status));
				if (!live) launch(["architect", "start", "--proposal-id", row.proposal_id, "--json"], { role: "architect", proposal_id: row.proposal_id, proposal_status: row.status, instance: row.architect_instance });
			}
		} catch (error) { results.push({ role: "architect", recovered: false, error: error instanceof Error ? error.message : String(error) }); }
	}
	// Debugger workers marked running have a durable, explicit intent just like
	// watchers. Recreate them only when their exact instance is no longer live.
	const debuggerDb = path.join(dataRoot, "debugger", "debugger.sqlite");
	if (fs.existsSync(debuggerDb)) {
		try {
			const { DatabaseSync } = requireSqlite();
			const externalDb = new DatabaseSync(debuggerDb);
			const rows = externalDb.prepare("SELECT root, name, worker_instance FROM debugger_projects WHERE worker_status = 'running'").all();
			for (const row of rows) {
				// A stale running flag is not a request to resurrect a debugger on a
				// completed project. Debugger follows the same active-run boundary as
				// watcher; completed/finalized projects must stay closed.
				if (!projectHasActiveWork(row.root)) {
					externalDb.prepare("UPDATE debugger_projects SET worker_status = 'stopped', workspace_id = NULL, worker_tab_id = NULL, worker_pane_id = NULL, updated_at = ? WHERE root = ? AND worker_status = 'running'").run(now(), row.root);
					continue;
				}
				const live = snapshot?.agents?.some((agent) => agent.agent === "pi" && agent.name === row.worker_instance && !["done", "offline", "unknown"].includes(agent.agent_status));
				if (!live) launch(["debugger", "resume", "--project-root", row.root, "--project", row.name, "--json"], { role: "debugger", project: row.name, instance: row.worker_instance });
			}
			externalDb.close();
		} catch (error) { results.push({ role: "debugger", recovered: false, error: error instanceof Error ? error.message : String(error) }); }
	}
	// A suggester gets an LLM tab only for a pending analysis. Never recreate an
	// idle worker merely because an old tab disappeared.
	const suggesterDb = path.join(dataRoot, "suggester", "suggester.sqlite");
	if (fs.existsSync(suggesterDb)) {
		try {
			const { DatabaseSync } = requireSqlite();
			const externalDb = new DatabaseSync(suggesterDb, { readOnly: true });
			const rows = externalDb.prepare("SELECT p.root, p.name, p.worker_instance FROM suggester_projects p WHERE p.worker_status NOT IN ('paused','stopped') AND EXISTS (SELECT 1 FROM suggestions s WHERE s.project_key = p.project_key AND s.status IN ('received','analyzing'))").all();
			externalDb.close();
			for (const row of rows) {
				const live = snapshot?.agents?.some((agent) => agent.agent === "pi" && agent.name === row.worker_instance && !["done", "offline", "unknown"].includes(agent.agent_status));
				if (!live) launch(["suggester", "resume", "--project-root", row.root, "--project", row.name, "--json"], { role: "suggester", project: row.name, instance: row.worker_instance });
			}
		} catch (error) { results.push({ role: "suggester", recovered: false, error: error instanceof Error ? error.message : String(error) }); }
	}
	// Auto-improver is a scheduled service: recovering it means restarting the
	// scheduler, never launching a blank audit tab.
	const autoDb = path.join(dataRoot, "auto-improver", "auto-improver.sqlite");
	if (fs.existsSync(autoDb)) {
		try {
			const { DatabaseSync } = requireSqlite();
			const externalDb = new DatabaseSync(autoDb, { readOnly: true });
			const enabled = externalDb.prepare("SELECT COUNT(*) AS count FROM auto_projects WHERE worker_status NOT IN ('paused','stopped')").get().count;
			externalDb.close();
			if (enabled) launch(["auto-improve", "supervise", "--json"], { role: "auto-improver", enabled_projects: enabled });
		} catch (error) { results.push({ role: "auto-improver", recovered: false, error: error instanceof Error ? error.message : String(error) }); }
	}
	return results;
}

function pruneOrphanWatcherTabs(snapshot, rows) {
	if (!snapshot) return [];
	const knownRoots = new Set(rows.map((row) => path.resolve(row.root)));
	const removed = [];
	for (const tab of snapshot.tabs || []) {
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

function activateDefaultDebuggers() {
	const file = path.join(traceRoot(), "debugger", "debugger.sqlite");
	if (!fs.existsSync(file)) return [];
	const results = [];
	try {
		const { DatabaseSync } = requireSqlite();
		const db = new DatabaseSync(file, { readOnly: true });
		const rows = db.prepare("SELECT root, name, worker_status FROM debugger_projects WHERE worker_status = 'stopped'").all();
		db.close();
		for (const row of rows) {
			if (!projectHasActiveWork(row.root)) continue;
			const args = ["debugger", "start", "--project-root", row.root, "--project", row.name, "--json"];
			const launched = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, "bin", "yano.mjs"), ...args], { encoding: "utf8", maxBuffer: 4_000_000 });
			results.push({ role: "debugger", project: row.name, root: row.root, activated: launched.status === 0, error: launched.status === 0 ? null : (launched.stderr || launched.stdout || "debugger start failed").trim() });
		}
	} catch (error) {
		results.push({ role: "debugger", activated: false, error: error instanceof Error ? error.message : String(error) });
	}
	return results;
}

function supervise(db) {
	return withSupervisorLock(async () => {
		const rows = db.prepare("SELECT * FROM watcher_projects ORDER BY updated_at DESC").all();
		const snapshot = herdrSnapshot();
		const orphan_tabs_removed = pruneOrphanWatcherTabs(snapshot, rows);
		const identityConflicts = snapshot ? findAgentIdentityConflicts(snapshot) : [];
		for (const conflict of identityConflicts) {
			const row = rows.find((candidate) => path.resolve(candidate.root) === path.resolve(conflict.root));
			if (row) appendRawTraceRecord({ cwd: row.root, project: resolveTraceProject(row.root), record: { type: "watcher_identity_conflict", payload: conflict } });
		}
		const global_services = ensureGlobalYanoServices();
		// User-declared external dependencies (Docker/pm2/llmProxy/...): same
		// one-per-minute cadence as every other recovery in this loop, so the
		// whole fleet — Yano's own service tabs above, project planners below,
		// and now the operator's own external services — heals deterministically
		// after a computer restart or a crashed container/process, not just the
		// parts Yano happens to own directly.
		let external_services;
		try { external_services = await superviseExternalServices(); } catch (error) { external_services = { error: error instanceof Error ? error.message : String(error) }; }
		const activated = [...rows.map((row) => activateDefaultWorkers(db, row)).filter(Boolean), ...activateDefaultDebuggers()];
		const result = {
			checked_at: now(),
			projects: rows.map((row) => doStatusForRow(db, row, { heal: true })),
			activated,
			global_services,
			external_services,
			external_workers: externalWorkerRecovery(snapshot),
			orphan_tabs_removed,
			identity_conflicts: identityConflicts,
			errors: formatAgentIdentityConflicts(identityConflicts),
		};
		try { fs.writeFileSync(supervisorHeartbeatPath(), JSON.stringify({ checked_at: result.checked_at, pid: process.pid, project_count: rows.length, external_recoveries: result.external_workers }, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
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
	return `${shellQuote(process.execPath)} ${shellQuote(path.join(PACKAGE_ROOT, "bin", "yano.mjs"))} watcher supervise --json >/dev/null 2>&1 ${CRON_MARKER}`;
}

function cronInstall() {
	const line = `* * * * * ${cronCommand()}`;
	const existing = readCrontab().split("\n").filter((item) => item.trim() && !item.includes(CRON_MARKER));
	const content = [...existing, line].join("\n") + "\n";
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile installare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: true, schedule: "* * * * *", command: line, marker: CRON_MARKER };
}

function cronStatus() {
	const line = readCrontab().split("\n").find((item) => item.includes(CRON_MARKER)) || null;
	let heartbeat = null;
	try { heartbeat = JSON.parse(fs.readFileSync(supervisorHeartbeatPath(), "utf8")); } catch { /* not run yet */ }
	const heartbeatAt = heartbeat?.checked_at || null;
	const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - Date.parse(heartbeatAt)) : null;
	return { installed: Boolean(line), schedule: line ? "* * * * *" : null, command: line, marker: CRON_MARKER, last_heartbeat_at: heartbeatAt, heartbeat_age_ms: heartbeatAgeMs, healthy: Boolean(line && heartbeatAt && heartbeatAgeMs <= 130_000) };
}

function cronRemove() {
	const existing = readCrontab().split("\n").filter((item) => item.trim() && !item.includes(CRON_MARKER));
	const content = existing.length ? `${existing.join("\n")}\n` : "";
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile rimuovere il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: false, removed: true, marker: CRON_MARKER };
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
		"  init --project-root <dir> [--interval-ms 300000] [--lookback-ms 3600000]",
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
