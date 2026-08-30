#!/usr/bin/env node

// Persistent registry + Herdr-tab supervision for the continuous, zero-token
// `yano watch` loop.
//
// Problem this closes: `yano watch --interval-ms 600000 --away` is a bare,
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
import { appendRawTraceRecord, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";

const require = createRequire(import.meta.url);
const WORKSPACE_LABEL = "yano-watcher";
const DEFAULT_INTERVAL_MS = 600000; // 10 minuti — stesso default operativo di prompts/watcher.md
const DEFAULT_LOOKBACK_MS = 3600000;

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
			interval_ms INTEGER NOT NULL DEFAULT 600000,
			lookback_ms INTEGER NOT NULL DEFAULT 3600000,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	return db;
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
	return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, instance, command, dry_run: dryRun };
}

function watcherOnce(info, project) {
	const trace = readTraceRecords({ cwd: info.root, project: info.name, limit: 200 });
	const scans = trace.filter((record) => record.type === "yano_watcher_scan");
	const findings = trace.filter((record) => record.type === "yano_watcher_finding");
	return {
		once: true,
		read_only: true,
		project: info.name,
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
	return { project, db_path: dbPath() };
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
	db.prepare("UPDATE watcher_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run("paused", now(), existing.project_key);
	const result = { project: info.name, worker_status: "paused", note: "pausa logica; nessuna tab Herdr viene chiusa e lo stato resta ripristinabile" };
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "watcher_registry_pause", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", worker_status: "paused" } }); } catch { /* best effort */ }
	return result;
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
	const tab = snapshot.tabs?.find((item) => item.tab_id === row.worker_tab_id);
	const pane = tab && snapshot.panes?.find((item) => item.pane_id === row.worker_pane_id);
	if (tab && pane) return { ...base, live: "running" };
	const drifted = { ...base, live: "not_found", drift: true };
	if (!heal) return drifted;
	try {
		const relaunched = launchHerdrWorker({ project: info, root: row.root, db, row, intervalMs: row.interval_ms, lookbackMs: row.lookback_ms, dryRun: false });
		try { appendRawTraceRecord({ cwd: row.root, project: row.name, record: { type: "watcher_worker_recovered", record_type: "event", source: "yano-watcher-registry", instance: "yano-watcher", previous_tab_id: row.worker_tab_id, previous_pane_id: row.worker_pane_id } }); } catch { /* best effort */ }
		return { ...drifted, recovered: true, ...relaunched, worker_status: "running" };
	} catch (error) {
		return { ...drifted, recovered: false, recover_error: error instanceof Error ? error.message : String(error) };
	}
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
		projectRoot: value(argv, "--project-root") || null,
		project: value(argv, "--project"),
		intervalMs: value(argv, "--interval-ms") ? Number(value(argv, "--interval-ms")) : null,
		lookbackMs: value(argv, "--lookback-ms") ? Number(value(argv, "--lookback-ms")) : null,
		json: has(argv, "--json"),
		dryRun: has(argv, "--dry-run"),
		once: has(argv, "--once"),
		foreground: has(argv, "--foreground"),
		force: has(argv, "--force"),
		noHeal: has(argv, "--no-heal"),
	};
}

function usage() {
	return [
		"Uso: yano watcher <init|start|status|pause|resume|projects> [opzioni]",
		"",
		"  init --project-root <dir> [--interval-ms 600000] [--lookback-ms 3600000]",
		"                                                     registra un progetto nel registro persistente",
		"  start --project-root <dir> [--dry-run]            apre/riusa la tab Herdr del watcher continuo (yano-watcher)",
		"  start --project-root <dir> --once                 esegue una sola preflight read-only senza avviare Herdr",
		"  status [--project-root <dir>] [--no-heal] [--json]",
		"                                                     mostra lo stato registrato di uno o tutti i progetti e,",
		"                                                     salvo --no-heal, rilancia il pane se risulta morto",
		"  pause|resume --project-root <dir>                 sospende/riattiva il loop di polling",
		"  projects [--all] [--json]                         presenza Herdr/Pi effettiva (vedi yano watcher projects)",
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
	if (!opts.sub || opts.sub === "--help" || opts.sub === "-h") { console.log(usage()); return; }
	const db = openDatabase();
	try {
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
		if (opts.sub === "pause" || opts.sub === "resume") {
			const info = projectInfo(opts.projectRoot, opts.project);
			const existing = getProject(db, info);
			if (!existing) throw new Error("yano watcher: progetto non registrato; esegui prima `yano watcher init`");
			const result = opts.sub === "pause" ? doPause(db, info, existing) : doResume(db, info, existing, { dryRun: opts.dryRun, force: opts.force, intervalMs: opts.intervalMs, lookbackMs: opts.lookbackMs, foreground: opts.foreground });
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
		throw new Error(`yano watcher: comando sconosciuto "${opts.sub}".\n${usage()}`);
	} finally {
		try { db.close(); } catch { /* ignore */ }
	}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runYanoWatcherRegistry({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano watcher: ${error.message}`); process.exit(1); });
