#!/usr/bin/env node

// Project-scoped application debugger registry.
//
// This is intentionally separate from the project's orchestrator.db: a
// debugger supervises several projects and must survive a project checkout
// being replaced. Raw forensic evidence still lives in the project trace;
// this SQLite file stores only the bug lifecycle and its provenance.
//
// `yano debugger serve` exposes the same lifecycle over a local-only REST
// API (127.0.0.1 by default), for callers that are not a shell — a Postman
// collection lives in `postman/yano-debugger.postman_collection.json`. The
// REST handlers call the exact same functions as the CLI switch below, so
// the two surfaces cannot drift apart.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { appendRawTraceRecord, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";

const require = createRequire(import.meta.url);
const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_SOURCES = new Set(["user", "system", "cli", "watcher"]);
const STATES = ["reported", "triaged", "reproducing", "not_reproducible", "blocked", "rejected", "duplicate"];
const TRANSITIONS = {
	reported: ["triaged", "duplicate", "rejected"],
	triaged: ["reproducing", "blocked", "rejected"],
	reproducing: ["triaged", "not_reproducible", "blocked"],
	blocked: ["triaged", "rejected"],
	not_reproducible: ["reproducing", "rejected"],
	rejected: ["triaged"],
	duplicate: ["triaged"],
};
const API_DEFAULT_PORT = 4177;
const ENDPOINTS = [
	{ method: "GET", path: "/health", description: "liveness" },
	{ method: "GET", path: "/projects", description: "elenca i progetti registrati con il loro id (project_key)" },
	{ method: "POST", path: "/projects", description: "registra/inizializza un progetto — body: { project_root, project?, mode?, base_port?, interval_ms? } (equivalente a `yano debugger init`)" },
	{ method: "GET", path: "/projects/:id", description: "dettaglio progetto" },
	{ method: "GET", path: "/projects/:id/bugs", description: "elenca i bug del progetto (equivalente a `yano debugger status --project-root ...`)" },
	{ method: "POST", path: "/projects/:id/bugs", description: "segnala un bug — body: { title, description, severity?, source?, reporter?, expected?, actual?, steps?, environment?, actor? } (equivalente a `yano debugger report`)" },
	{ method: "POST", path: "/projects/:id/start", description: "avvia/riusa il worker Herdr — body: { once?, dry_run?, foreground?, interval_ms?, base_port?, force? } (equivalente a `yano debugger start`)" },
	{ method: "POST", path: "/projects/:id/pause", description: "mette in pausa il worker (equivalente a `yano debugger pause`)" },
	{ method: "POST", path: "/projects/:id/resume", description: "riprende il worker (equivalente a `yano debugger resume`)" },
	{ method: "GET", path: "/bugs/:bugId", description: "dettaglio bug (equivalente a `yano debugger status --bug-id`)" },
	{ method: "POST", path: "/bugs/:bugId/claim", description: "assegna il bug — body: { actor? } (equivalente a `yano debugger claim`)" },
	{ method: "POST", path: "/bugs/:bugId/transition", description: "avanza lo stato diagnostico — body: { to, actor?, note?, deployment_id? } (equivalente a `yano debugger transition`)" },
];

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}

function has(argv, flag) { return argv.includes(flag); }

function slug(valueToSlug) {
	return String(valueToSlug || "project").toLowerCase().normalize("NFKD")
		.replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

function projectTabLabel(projectName) { return `debugger-${slug(projectName)}`.slice(0, 60); }

function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
	catch (error) { throw new Error(`yano debugger: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`); }
}

function dbPath() { return path.join(traceRoot(), "debugger", "debugger.sqlite"); }

function openDatabase() {
	fs.mkdirSync(path.dirname(dbPath()), { recursive: true, mode: 0o700 });
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(dbPath());
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS debugger_projects (
			project_key TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			root TEXT NOT NULL UNIQUE,
			mode TEXT NOT NULL DEFAULT 'project',
			workspace_id TEXT,
			worker_tab_id TEXT,
			worker_pane_id TEXT,
			worker_instance TEXT,
			worker_status TEXT NOT NULL DEFAULT 'stopped',
			interval_ms INTEGER NOT NULL DEFAULT 60000,
			backend_base_port INTEGER,
			frontend_base_port INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS debugger_bugs (
			bug_id TEXT PRIMARY KEY,
			project_key TEXT NOT NULL REFERENCES debugger_projects(project_key),
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			severity TEXT NOT NULL,
			source TEXT NOT NULL,
			reporter TEXT,
			expected TEXT,
			actual TEXT,
			steps_json TEXT NOT NULL,
			environment_json TEXT NOT NULL,
			status TEXT NOT NULL,
			assigned_instance TEXT,
			branch TEXT,
			deployment_id TEXT,
			fingerprint TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS debugger_bug_fingerprint_idx ON debugger_bugs(project_key, fingerprint);
		CREATE INDEX IF NOT EXISTS debugger_bug_status_idx ON debugger_bugs(project_key, status, updated_at);
		CREATE TABLE IF NOT EXISTS debugger_events (
			event_id TEXT PRIMARY KEY,
			bug_id TEXT NOT NULL REFERENCES debugger_bugs(bug_id),
			type TEXT NOT NULL,
			actor TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	return db;
}

function now() { return new Date().toISOString(); }

function json(value, fallback) {
	if (value === null || value === undefined || value === "") return fallback;
	try { return JSON.parse(value); } catch { return fallback; }
}

function safeJson(value, depth = 0) {
	if (depth > 4) return "[truncated]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > 6000 ? `${value.slice(0, 6000)}…` : value;
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeJson(item, depth + 1));
	const secret = /token|password|secret|authorization|api[-_]?key|cookie|private[-_]?key/i;
	return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, secret.test(key) ? "[redacted]" : safeJson(item, depth + 1)]));
}

function projectInfo(projectRoot, explicitProject = null, mode = "project") {
	const root = path.resolve(projectRoot || process.cwd());
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`yano debugger: project root non valida: ${root}`);
	const name = String(explicitProject || resolveTraceProject(root)).trim();
	if (!name) throw new Error("yano debugger: nome progetto vuoto");
	return { root, name, key: projectKey(root, name), mode };
}

function ensureProject(db, info, { intervalMs = 60000, backendBasePort = null, frontendBasePort = null } = {}) {
	const timestamp = now();
	const existing = db.prepare("SELECT * FROM debugger_projects WHERE project_key = ? OR root = ?").get(info.key, info.root);
	if (existing) {
		if (existing.project_key !== info.key) throw new Error(`yano debugger: la root è già registrata con un altro project key (${existing.project_key})`);
		db.prepare("UPDATE debugger_projects SET name = ?, mode = ?, interval_ms = ?, backend_base_port = COALESCE(?, backend_base_port), frontend_base_port = COALESCE(?, frontend_base_port), updated_at = ? WHERE project_key = ?")
			.run(info.name, info.mode, intervalMs, backendBasePort, frontendBasePort, timestamp, info.key);
		return db.prepare("SELECT * FROM debugger_projects WHERE project_key = ?").get(info.key);
	}
	db.prepare("INSERT INTO debugger_projects(project_key,name,root,mode,interval_ms,backend_base_port,frontend_base_port,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
		.run(info.key, info.name, info.root, info.mode, intervalMs, backendBasePort, frontendBasePort, timestamp, timestamp);
	return db.prepare("SELECT * FROM debugger_projects WHERE project_key = ?").get(info.key);
}

function getProject(db, info) {
	return db.prepare("SELECT * FROM debugger_projects WHERE project_key = ? OR root = ?").get(info.key, info.root);
}

function infoFromRow(row) { return { root: row.root, name: row.name, key: row.project_key, mode: row.mode }; }

function fingerprint(input) { return crypto.createHash("sha256").update(input).digest("hex"); }

function appendDebuggerEvent(db, bug, type, actor, payload = {}) {
	const timestamp = now();
	const event = { type, bug_id: bug.bug_id, project: bug.project_key, actor, ...safeJson(payload) };
	db.prepare("INSERT INTO debugger_events(event_id,bug_id,type,actor,payload_json,created_at) VALUES(?,?,?,?,?,?)")
		.run(`debug-event-${crypto.randomUUID()}`, bug.bug_id, type, actor, JSON.stringify(event), timestamp);
	try {
		appendRawTraceRecord({ cwd: bug.root, project: bug.project_name, record: {
			type: `debug_${type}`, record_type: "event", source: "yano-debugger", instance: actor,
			bug_id: bug.bug_id, status: bug.status, severity: bug.severity, project_key: bug.project_key,
			payload: safeJson(payload),
		} });
	} catch { /* trace must never block the durable debugger registry */ }
	return event;
}

function bugWithProject(db, row) {
	if (!row) return null;
	const project = db.prepare("SELECT name, root FROM debugger_projects WHERE project_key = ?").get(row.project_key);
	return { ...row, project_name: project?.name || null, root: project?.root || null, steps: json(row.steps_json, []), environment: json(row.environment_json, {}) };
}

function parseSteps(raw) {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw.map(String).slice(0, 30);
	const parsed = json(raw, null);
	if (Array.isArray(parsed)) return parsed.map(String).slice(0, 30);
	return String(raw).split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 30);
}

function validateBasePort(port) {
	if (port === null || port === undefined || port === "") return null;
	const value = Number(port);
	if (!Number.isInteger(value) || value < 3000 || value > 3999) throw new Error("yano debugger: --base-port deve essere un intero tra 3000 e 3999");
	return value;
}

function portsFor(basePort) {
	if (!basePort) return null;
	return { backend: { development: basePort, staging: basePort + 1000, production: basePort + 2000 }, frontend: { development: basePort + 3000, staging: basePort + 4000, production: basePort + 5000 } };
}

function parseCommand(argv) {
	const sub = argv[0];
	return { sub, projectRoot: value(argv, "--project-root") || process.cwd(), project: value(argv, "--project"), bugId: value(argv, "--bug-id") || value(argv, "--id"), mode: value(argv, "--mode") || "project", actor: value(argv, "--actor") || "operator", intervalMs: Math.max(1000, Number(value(argv, "--interval-ms") || 60000)), basePort: validateBasePort(value(argv, "--base-port")), port: value(argv, "--port") ? Number(value(argv, "--port")) : null, host: value(argv, "--host") || null, json: has(argv, "--json"), dryRun: has(argv, "--dry-run"), once: has(argv, "--once"), foreground: has(argv, "--foreground"), yes: has(argv, "--yes"), force: has(argv, "--force"), to: value(argv, "--to"), note: value(argv, "--note") || "", deploymentId: value(argv, "--deployment-id"), title: value(argv, "--title"), description: value(argv, "--description"), severity: value(argv, "--severity") || "medium", source: value(argv, "--source") || "cli", reporter: value(argv, "--reporter"), expected: value(argv, "--expected"), actual: value(argv, "--actual"), steps: value(argv, "--steps"), environment: value(argv, "--environment") };
}

function usage() {
	return [
		"Uso: yano debugger <init|start|status|report|claim|transition|pause|resume|serve> [opzioni]",
		"",
		"  init --project-root <dir>                         registra un progetto",
		"  start --project-root <dir> [--dry-run]            apre/riusa la tab Herdr del debugger",
		"  start --project-root <dir> --once                 esegue una sola preflight read-only senza avviare Herdr",
		"  status --project-root <dir> [--bug-id <id>]       mostra progetti o bug",
		"  report --project-root <dir> --title ...           registra un bug applicativo",
		"  claim --project-root <dir> --bug-id <id>          assegna il bug al debugger",
		"  transition --project-root <dir> --bug-id <id> --to <stato>",
		"  pause|resume --project-root <dir>                sospende/riattiva il worker logico",
		"  serve [--port <porta>] [--host <host>] [--json]  avvia l'API REST del debugger",
		"                                                    (un'unica istanza per tutti i progetti registrati;",
		"                                                    default 127.0.0.1:4177, override con",
		"                                                    YANO_DEBUGGER_API_PORT / --port; imposta",
		"                                                    YANO_DEBUGGER_API_TOKEN per richiedere",
		"                                                    'Authorization: Bearer <token>'). Collection",
		"                                                    Postman: postman/yano-debugger.postman_collection.json",
		"",
		"Stati diagnostici: reported, triaged, reproducing, not_reproducible, blocked, rejected, duplicate",
		"Il debugger non corregge, deploya o promuove: il planner apre il normale flusso di sviluppo/deployment.",
	].join("\n");
}

function ensureMode(mode) {
	if (!["project", "yano-maintenance"].includes(mode)) throw new Error("yano debugger: --mode deve essere project oppure yano-maintenance");
}

function ensureSource(source) {
	if (!VALID_SOURCES.has(source)) throw new Error(`yano debugger: --source deve essere uno tra ${[...VALID_SOURCES].join(", ")}`);
}

function getBugOrThrow(db, bugId) {
	if (!bugId) throw new Error("yano debugger: --bug-id è obbligatorio");
	const bug = bugWithProject(db, db.prepare("SELECT b.*, p.name AS project_name, p.root FROM debugger_bugs b JOIN debugger_projects p ON p.project_key = b.project_key WHERE b.bug_id = ?").get(bugId));
	if (!bug) throw new Error(`yano debugger: bug non trovato: ${bugId}`);
	return bug;
}

function print(valueToPrint, machine) {
	if (machine) console.log(JSON.stringify(valueToPrint, null, 2));
	else if (Array.isArray(valueToPrint)) for (const item of valueToPrint) console.log(`${item.bug_id || item.project_key} — ${item.status || item.worker_status || "registered"} — ${item.title || item.name || item.root}`);
	else console.log(JSON.stringify(valueToPrint, null, 2));
}

function debuggerOnce(db, info, project) {
	const trace = readTraceRecords({ cwd: info.root, project: info.name, limit: 100 });
	const bugs = db.prepare("SELECT status, COUNT(*) AS count FROM debugger_bugs WHERE project_key = ? GROUP BY status ORDER BY status").all(project.project_key);
	return {
		once: true,
		read_only: true,
		project: info.name,
		project_root: info.root,
		worker_started: false,
		worker_status: project.worker_status,
		ports: portsFor(project.backend_base_port),
		trace_records: trace.length,
		bugs_by_status: bugs,
		message: "Preflight debugger completata: nessuna tab Herdr, nessun processo persistente e nessuna modifica al progetto.",
	};
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}

function renameHerdrTab(tabId, label) {
	if (!tabId || !label) return;
	const result = spawnSync("herdr", ["tab", "rename", tabId, label], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano debugger: impossibile rinominare la tab ${tabId} in ${label}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function shellQuote(valueToQuote) {
	return process.platform === "win32" ? `"${String(valueToQuote).replaceAll('"', '\\"')}"` : `'${String(valueToQuote).replaceAll("'", `\'"'"\'`)}'`;
}

function findOrCreateDebuggerWorkspace(snapshot, root, dryRun = false) {
	const label = "yano-debugger";
	let workspace = snapshot?.workspaces?.find((item) => item.label === label);
	if (workspace) return { workspace, created: false };
	if (dryRun) return { workspace: { workspace_id: null, label }, created: false, dry_run: true };
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", root, "--label", label, "--focus"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano debugger: impossibile creare il workspace Herdr "${label}"${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	try {
		const parsed = JSON.parse(result.stdout);
		workspace = parsed?.result?.workspace || parsed?.workspace;
	} catch { /* refresh below */ }
	if (!workspace?.workspace_id) workspace = herdrSnapshot()?.workspaces?.find((item) => item.label === label);
	if (!workspace?.workspace_id) throw new Error("yano debugger: Herdr ha creato il workspace ma non ha restituito workspace_id");
	return { workspace, created: true };
}

function launchHerdrWorker({ project, root, db, row, intervalMs, dryRun }) {
	const workspaceRoot = path.join(traceRoot(), "agent-workspaces", "yano-debugger");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const instance = row.worker_instance || `debugger-${project.name}`;
	const command = `yano start --instance ${shellQuote(instance)} --role debugger --project ${shellQuote(project.name)}`;
	if (dryRun) {
		db.prepare("UPDATE debugger_projects SET worker_instance = ?, worker_status = ?, interval_ms = ?, updated_at = ? WHERE project_key = ?")
			.run(instance, "planned", intervalMs, now(), project.key);
		return { workspace_id: row.workspace_id, tab_id: row.worker_tab_id, pane_id: row.worker_pane_id, instance, command, dry_run: true };
	}
	const snapshot = herdrSnapshot();
	if (!snapshot) throw new Error("yano debugger: Herdr non raggiungibile; avvia Herdr e riprova");
	const workspaceResult = findOrCreateDebuggerWorkspace(snapshot, workspaceRoot);
	const { workspace } = workspaceResult;
	const tabLabel = projectTabLabel(project.name);
	let refreshed = herdrSnapshot() || snapshot;
	let tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && (item.label === tabLabel || item.tab_id === row.worker_tab_id || item.label === project.name));
	let pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	if (tab && tab.label !== tabLabel) {
		renameHerdrTab(tab.tab_id, tabLabel);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.tab_id === tab.tab_id);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab) {
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", root, "--label", tabLabel, "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error(`yano debugger: Herdr non ha creato la tab ${tabLabel}${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === tabLabel);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab || !pane) throw new Error(`yano debugger: workspace Herdr pronto ma tab/pane non trovati per ${tabLabel}`);
	const launched = spawnSync("herdr", ["pane", "run", pane.pane_id, `exec ${command}`], { cwd: root, encoding: "utf8" });
	if (launched.status !== 0) throw new Error(`yano debugger: avvio dell'agente fallito${launched.stderr ? `: ${launched.stderr.trim()}` : ""}`);
	const timestamp = now();
	db.prepare("UPDATE debugger_projects SET workspace_id = ?, worker_tab_id = ?, worker_pane_id = ?, worker_instance = ?, worker_status = ?, interval_ms = ?, updated_at = ? WHERE project_key = ?")
		.run(workspace.workspace_id, tab.tab_id, pane.pane_id, instance, "running", intervalMs, timestamp, project.key);
	return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, instance, command, dry_run: dryRun };
}

function reportBug(db, opts) {
	if (!opts.title?.trim()) throw new Error("yano debugger report: --title è obbligatorio");
	if (!opts.description?.trim()) throw new Error("yano debugger report: --description è obbligatorio");
	if (!VALID_SEVERITIES.has(opts.severity)) throw new Error(`yano debugger report: --severity deve essere uno tra ${[...VALID_SEVERITIES].join(", ")}`);
	ensureSource(opts.source);
	ensureMode(opts.mode);
	if (opts.mode === "yano-maintenance" && !opts.projectRoot.includes("yano-orchestrator")) throw new Error("yano debugger: la modalità yano-maintenance richiede una root esplicita del repository yano-orchestrator");
	const info = projectInfo(opts.projectRoot, opts.project, opts.mode);
	const project = ensureProject(db, info);
	const normalized = { title: opts.title.trim(), description: opts.description.trim(), expected: opts.expected || "", actual: opts.actual || "", steps: parseSteps(opts.steps), environment: safeJson(typeof opts.environment === "object" && opts.environment !== null ? opts.environment : json(opts.environment, opts.environment ? { value: opts.environment } : {})) };
	const hash = fingerprint(`${info.key}|${normalized.title.toLowerCase()}|${normalized.description.toLowerCase()}|${normalized.actual.toLowerCase()}`);
	const duplicate = db.prepare("SELECT * FROM debugger_bugs WHERE project_key = ? AND fingerprint = ?").get(info.key, hash);
	if (duplicate) return { bug: bugWithProject(db, duplicate), duplicate: true };
	const bugId = `BUG-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	const timestamp = now();
	db.prepare("INSERT INTO debugger_bugs(bug_id,project_key,title,description,severity,source,reporter,expected,actual,steps_json,environment_json,status,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
		.run(bugId, project.project_key, normalized.title, normalized.description, opts.severity, opts.source, opts.reporter || null, normalized.expected, normalized.actual, JSON.stringify(normalized.steps), JSON.stringify(normalized.environment), "reported", hash, timestamp, timestamp);
	const bug = bugWithProject(db, db.prepare("SELECT * FROM debugger_bugs WHERE bug_id = ?").get(bugId));
	appendDebuggerEvent(db, bug, "report_received", opts.actor, { source: opts.source, reporter: opts.reporter || null });
	return { bug, duplicate: false };
}

function transitionBug(db, opts) {
	const bug = getBugOrThrow(db, opts.bugId);
	if (!STATES.includes(opts.to)) throw new Error(`yano debugger transition: stato non valido "${opts.to}"`);
	if (!(TRANSITIONS[bug.status] || []).includes(opts.to)) throw new Error(`yano debugger transition: ${bug.status} → ${opts.to} non consentito; transizioni possibili: ${(TRANSITIONS[bug.status] || []).join(", ") || "nessuna"}`);
	if (["fixing", "testing", "staging", "awaiting_validation", "production", "rolled_back"].includes(opts.to)) throw new Error("yano debugger: stato non diagnostico; il planner deve aprire il flusso coder/reviewer/deployment-agent");
	const timestamp = now();
	db.prepare("UPDATE debugger_bugs SET status = ?, deployment_id = COALESCE(?, deployment_id), updated_at = ? WHERE bug_id = ?").run(opts.to, opts.deploymentId || null, timestamp, bug.bug_id);
	const updated = bugWithProject(db, db.prepare("SELECT * FROM debugger_bugs WHERE bug_id = ?").get(bug.bug_id));
	appendDebuggerEvent(db, updated, "state_changed", opts.actor, { from: bug.status, to: opts.to, note: opts.note || null, deployment_id: opts.deploymentId || null });
	return updated;
}

function claimBug(db, bug, actor) {
	if (bug.assigned_instance && bug.assigned_instance !== actor) throw new Error(`yano debugger claim: bug già assegnato a ${bug.assigned_instance}`);
	db.prepare("UPDATE debugger_bugs SET assigned_instance = ?, updated_at = ? WHERE bug_id = ?").run(actor, now(), bug.bug_id);
	const updated = bugWithProject(db, db.prepare("SELECT * FROM debugger_bugs WHERE bug_id = ?").get(bug.bug_id));
	appendDebuggerEvent(db, updated, "claimed", actor);
	return updated;
}

async function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

async function allocateBasePort(db, requested) {
	if (requested) return requested;
	const used = new Set(db.prepare("SELECT backend_base_port AS port FROM debugger_projects WHERE backend_base_port IS NOT NULL").all().map((row) => Number(row.port)));
	for (let base = 3000; base <= 3999; base++) {
		if (used.has(base)) continue;
		const ports = portsFor(base);
		const candidates = [...Object.values(ports.backend), ...Object.values(ports.frontend)];
		let free = true;
		for (const port of candidates) if (!(await isPortFree(port))) { free = false; break; }
		if (free) return base;
	}
	throw new Error("yano debugger: nessun set di porte libero nei range dev/staging/production");
}

// --- shared operations: CLI switch cases and the REST API below both call
// these, so the two surfaces cannot behave differently. ---

async function doInit(db, info, opts = {}) {
	const basePort = await allocateBasePort(db, opts.basePort || null);
	const project = ensureProject(db, info, { intervalMs: Math.max(1000, Number(opts.intervalMs || 60000)), backendBasePort: basePort, frontendBasePort: basePort + 3000 });
	return { project, ports: portsFor(basePort), db_path: dbPath() };
}

async function doStart(db, info, opts = {}) {
	const registered = getProject(db, info);
	const basePort = opts.basePort || registered?.backend_base_port || await allocateBasePort(db, null);
	const intervalMs = Math.max(1000, Number(opts.intervalMs || registered?.interval_ms || 60000));
	const project = ensureProject(db, info, { intervalMs, backendBasePort: basePort, frontendBasePort: basePort + 3000 });
	if (opts.once) return debuggerOnce(db, info, project);
	if (project.worker_status === "running" && !opts.dryRun && !opts.force) {
		return { project: info.name, worker_status: "running", already_running: true, workspace_id: project.workspace_id, tab_id: project.worker_tab_id, instance: project.worker_instance };
	}
	const launched = opts.foreground
		? { workspace_id: project.workspace_id, tab_id: project.worker_tab_id, pane_id: project.worker_pane_id, instance: project.worker_instance || `debugger-${info.name}`, command: null, supervisor: "foreground", dry_run: Boolean(opts.dryRun) }
		: launchHerdrWorker({ project: info, root: info.root, db, row: project, intervalMs, dryRun: Boolean(opts.dryRun) });
	if (opts.foreground) db.prepare("UPDATE debugger_projects SET worker_instance = ?, worker_status = ?, interval_ms = ?, updated_at = ? WHERE project_key = ?").run(launched.instance, opts.dryRun ? "planned" : "running", intervalMs, now(), project.project_key);
	return { project: info.name, worker_status: opts.dryRun ? "planned" : "running", ports: portsFor(basePort), ...launched };
}

function doPause(db, info, existing) {
	db.prepare("UPDATE debugger_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run("paused", now(), existing.project_key);
	const result = { project: info.name, worker_status: "paused", note: "pausa logica; nessuna tab Herdr viene chiusa e lo stato resta ripristinabile" };
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "debugger_pause", record_type: "event", source: "yano-debugger", instance: "yano-debugger", worker_status: "paused" } }); } catch { /* best effort */ }
	return result;
}

async function doResume(db, info, existing, opts = {}) {
	if (existing.worker_status === "running" && !opts.dryRun && !opts.force) {
		return { project: info.name, worker_status: "running", already_running: true, workspace_id: existing.workspace_id, tab_id: existing.worker_tab_id, instance: existing.worker_instance };
	}
	const basePort = existing.backend_base_port || await allocateBasePort(db, opts.basePort || null);
	const intervalMs = Math.max(1000, Number(opts.intervalMs || existing.interval_ms || 60000));
	const launched = opts.foreground
		? { workspace_id: existing.workspace_id, tab_id: existing.worker_tab_id, pane_id: existing.worker_pane_id, instance: existing.worker_instance || `debugger-${info.name}`, command: null, supervisor: "foreground", dry_run: Boolean(opts.dryRun) }
		: launchHerdrWorker({ project: info, root: info.root, db, row: existing, intervalMs, dryRun: Boolean(opts.dryRun) });
	const status = opts.dryRun ? "planned" : "running";
	db.prepare("UPDATE debugger_projects SET worker_status = ?, backend_base_port = COALESCE(?, backend_base_port), frontend_base_port = COALESCE(?, frontend_base_port), updated_at = ? WHERE project_key = ?").run(status, basePort, basePort + 3000, now(), existing.project_key);
	const result = { project: info.name, worker_status: status, ports: portsFor(basePort), ...launched, note: "worker ripristinato dal registro persistente" };
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "debugger_resume", record_type: "event", source: "yano-debugger", instance: "yano-debugger", worker_status: status } }); } catch { /* best effort */ }
	return result;
}

// --- REST API (`yano debugger serve`) ---

function sendJson(res, status, body) {
	const text = JSON.stringify(body, null, 2);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1_000_000) throw new Error("body troppo grande (max 1MB)");
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
	catch { throw new Error("body JSON non valido"); }
}

function checkAuth(req, token) {
	if (!token) return true;
	const header = req.headers.authorization || "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	return Boolean(match && match[1] === token);
}

async function routeApiRequest(db, req, res) {
	const url = new URL(req.url, "http://localhost");
	const parts = url.pathname.split("/").filter(Boolean);
	const method = req.method;

	if (method === "GET" && parts.length === 0) return sendJson(res, 200, { ok: true, service: "yano-debugger", endpoints: ENDPOINTS });
	if (method === "GET" && parts[0] === "health") return sendJson(res, 200, { ok: true });

	if (parts[0] === "projects") {
		if (method === "GET" && parts.length === 1) {
			const rows = db.prepare("SELECT * FROM debugger_projects ORDER BY created_at DESC").all();
			return sendJson(res, 200, { projects: rows.map((row) => ({ ...row, ports: portsFor(row.backend_base_port) })) });
		}
		if (method === "POST" && parts.length === 1) {
			const body = await readJsonBody(req);
			if (!body.project_root) return sendJson(res, 400, { error: "project_root è obbligatorio" });
			const info = projectInfo(body.project_root, body.project || null, body.mode || "project");
			const result = await doInit(db, info, { basePort: validateBasePort(body.base_port), intervalMs: body.interval_ms });
			return sendJson(res, 201, result);
		}
		const key = parts[1];
		if (!key) return sendJson(res, 404, { error: "not found" });
		const row = db.prepare("SELECT * FROM debugger_projects WHERE project_key = ?").get(key);
		if (!row) return sendJson(res, 404, { error: `progetto non trovato: ${key}` });
		const info = infoFromRow(row);

		if (method === "GET" && parts.length === 2) return sendJson(res, 200, { ...row, ports: portsFor(row.backend_base_port) });

		if (parts[2] === "bugs" && method === "GET" && parts.length === 3) {
			const bugs = db.prepare("SELECT * FROM debugger_bugs WHERE project_key = ? ORDER BY created_at DESC").all(row.project_key).map((b) => bugWithProject(db, b));
			return sendJson(res, 200, { project: row, bugs });
		}
		if (parts[2] === "bugs" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req);
			const opts = { projectRoot: row.root, project: row.name, mode: row.mode, title: body.title, description: body.description, severity: body.severity || "medium", source: body.source || "cli", reporter: body.reporter || null, expected: body.expected || "", actual: body.actual || "", steps: body.steps, environment: body.environment ?? {}, actor: body.actor || "api" };
			const result = reportBug(db, opts);
			return sendJson(res, result.duplicate ? 200 : 201, { bug_id: result.bug.bug_id, status: result.bug.status, duplicate: result.duplicate, project: result.bug.project_name, bug: result.bug });
		}
		if (parts[2] === "start" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req);
			const result = await doStart(db, info, { basePort: validateBasePort(body.base_port), intervalMs: body.interval_ms, once: Boolean(body.once), dryRun: Boolean(body.dry_run), foreground: Boolean(body.foreground), force: Boolean(body.force) });
			return sendJson(res, 200, result);
		}
		if (parts[2] === "pause" && method === "POST" && parts.length === 3) return sendJson(res, 200, doPause(db, info, row));
		if (parts[2] === "resume" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req).catch(() => ({}));
			const result = await doResume(db, info, row, { basePort: validateBasePort(body.base_port), intervalMs: body.interval_ms, dryRun: Boolean(body.dry_run), foreground: Boolean(body.foreground), force: Boolean(body.force) });
			return sendJson(res, 200, result);
		}
		return sendJson(res, 404, { error: "not found" });
	}

	if (parts[0] === "bugs" && parts[1]) {
		const bugId = parts[1];
		if (method === "GET" && parts.length === 2) return sendJson(res, 200, getBugOrThrow(db, bugId));
		if (parts[2] === "claim" && method === "POST") {
			const body = await readJsonBody(req).catch(() => ({}));
			const bug = getBugOrThrow(db, bugId);
			try { return sendJson(res, 200, claimBug(db, bug, body.actor || "api")); }
			catch (error) { return sendJson(res, 409, { error: error.message }); }
		}
		if (parts[2] === "transition" && method === "POST") {
			const body = await readJsonBody(req);
			const updated = transitionBug(db, { bugId, to: body.to, actor: body.actor || "api", note: body.note || "", deploymentId: body.deployment_id || null });
			return sendJson(res, 200, updated);
		}
	}
	return sendJson(res, 404, { error: "not found" });
}

async function handleApiRequest(db, req, res, token) {
	try {
		if (!checkAuth(req, token)) return sendJson(res, 401, { error: "unauthorized: header 'Authorization: Bearer <token>' richiesto o non valido" });
		await routeApiRequest(db, req, res);
	} catch (error) {
		if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
	}
}

async function runServe(db, opts) {
	const port = opts.port || Number(process.env.YANO_DEBUGGER_API_PORT) || API_DEFAULT_PORT;
	const host = opts.host || "127.0.0.1";
	const token = process.env.YANO_DEBUGGER_API_TOKEN || null;
	const server = http.createServer((req, res) => { handleApiRequest(db, req, res, token); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
	const info = { ok: true, host, port, token_required: Boolean(token), db_path: dbPath(), endpoints: ENDPOINTS };
	print(info, opts.json);
	if (!opts.json) console.log(`yano debugger: API in ascolto su http://${host}:${port} — Ctrl+C per fermarla${token ? " (Authorization: Bearer <token> richiesto)" : " (nessun token configurato — YANO_DEBUGGER_API_TOKEN per proteggerla)"}`);
	await new Promise((resolve) => {
		let closing = false;
		const shutdown = () => { if (closing) return; closing = true; server.close(() => resolve()); };
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}

export async function runYanoDebugger({ argv = [] } = {}) {
	const opts = parseCommand(argv);
	if (!opts.sub || opts.sub === "--help" || opts.sub === "-h") { console.log(usage()); return; }
	ensureMode(opts.mode);
	const db = openDatabase();
	try {
		if (opts.sub === "serve") {
			await runServe(db, { port: opts.port, host: opts.host, json: opts.json });
			return;
		}
		if (opts.sub === "status" && opts.bugId) {
			const bug = getBugOrThrow(db, opts.bugId);
			if (opts.json) print(bug, true); else { console.log(`${bug.bug_id} — ${bug.status} — ${bug.title}`); console.log(`progetto: ${bug.project_name} (${bug.root})`); console.log(`severità: ${bug.severity}; assegnatario: ${bug.assigned_instance || "nessuno"}`); }
			return bug;
		}
		if (opts.sub === "status") {
			const info = projectInfo(opts.projectRoot, opts.project, opts.mode);
			const project = getProject(db, info);
			if (!project) { print([], opts.json); return []; }
			const bugs = db.prepare("SELECT * FROM debugger_bugs WHERE project_key = ? ORDER BY created_at DESC").all(project.project_key).map((row) => bugWithProject(db, row));
			print(opts.json ? { project, bugs } : bugs, opts.json);
			return { project, bugs };
		}
		if (opts.sub === "init") {
			const info = projectInfo(opts.projectRoot, opts.project, opts.mode);
			const result = await doInit(db, info, { basePort: opts.basePort, intervalMs: opts.intervalMs });
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "report") {
			const result = reportBug(db, opts);
			print({ bug_id: result.bug.bug_id, status: result.bug.status, duplicate: result.duplicate, project: result.bug.project_name }, opts.json);
			return result;
		}
		if (["claim", "transition", "promote"].includes(opts.sub)) {
			const bug = getBugOrThrow(db, opts.bugId);
			if (opts.sub === "claim") {
				const updated = claimBug(db, bug, opts.actor);
				print(updated, opts.json);
				return updated;
			}
			if (opts.sub === "promote") {
				throw new Error("yano debugger promote: il debugger è read-only; il planner deve usare deployment-agent per staging/production");
			}
			const updated = transitionBug(db, opts);
			print(updated, opts.json);
			return updated;
		}
		if (opts.sub === "pause" || opts.sub === "resume") {
			const info = projectInfo(opts.projectRoot, opts.project, opts.mode);
			const existing = getProject(db, info);
			if (!existing) throw new Error("yano debugger: progetto non inizializzato; esegui prima `yano debugger init`");
			const result = opts.sub === "pause"
				? doPause(db, info, existing)
				: await doResume(db, info, existing, { dryRun: opts.dryRun, force: opts.force, basePort: opts.basePort, intervalMs: opts.intervalMs, foreground: opts.foreground });
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "start") {
			const info = projectInfo(opts.projectRoot, opts.project, opts.mode);
			const result = await doStart(db, info, { basePort: opts.basePort, intervalMs: opts.intervalMs, once: opts.once, dryRun: opts.dryRun, foreground: opts.foreground, force: opts.force });
			print(result, opts.json);
			return result;
		}
		throw new Error(`yano debugger: comando sconosciuto "${opts.sub}".\n${usage()}`);
	} finally {
		try { db.close(); } catch { /* ignore */ }
	}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runYanoDebugger({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano debugger: ${error.message}`); process.exit(1); });
