#!/usr/bin/env node

// User-suggestion observer. It owns intake, durable state, bounded evidence,
// approval gates and planner notification. The project under observation is
// never edited by this process or by the yano-suggester worker.
//
// `yano suggester serve` exposes the same registry over a local-only REST
// API (127.0.0.1 by default). The REST handlers call the exact same
// functions as the CLI switch below, so the two surfaces cannot drift apart.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { appendRawTraceRecord, buildTraceOverview, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { planTraceRetrieval } from "./yano-trace-index.mjs";
import { resolveYanoConfig } from "./yano-config.mjs";
import { routeAgentMessage } from "./yano-agent-routing.mjs";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_LABEL = "yano-suggester";
const MAX_TEXT = 12_000;
const VALID_CATEGORIES = new Set(["bug", "feature", "improvement", "ux", "out_of_scope", "unsafe"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_SOURCES = new Set(["user", "cli", "system", "debugger", "watcher", "auto-improver"]);
const VALID_NOTIFY = new Set(["auto", "none", "telegram", "whatsapp", "email"]);
const API_DEFAULT_PORT = 4179;
const ENDPOINTS = [
	{ method: "GET", path: "/health", description: "liveness" },
	{ method: "GET", path: "/projects", description: "elenca i progetti registrati con il loro id (project_key)" },
	{ method: "POST", path: "/projects", description: "registra/inizializza un progetto — body: { project_root, project?, notify? } (equivalente a `yano suggester init`)" },
	{ method: "GET", path: "/projects/:id", description: "dettaglio progetto" },
	{ method: "GET", path: "/projects/:id/suggestions", description: "elenca i suggerimenti del progetto (equivalente a `yano suggester status`)" },
	{ method: "GET", path: "/projects/:id/reports", description: "elenca i report globali del progetto (equivalente a `yano suggester reports`)" },
	{ method: "POST", path: "/projects/:id/suggestions", description: "invia un nuovo suggerimento — body: { title, description, source?, user_id?, priority?, route?, app_version?, queue_only?, once? } (equivalente a `yano suggester submit`)" },
	{ method: "POST", path: "/projects/:id/pause", description: "mette in pausa il worker (equivalente a `yano suggester pause`)" },
	{ method: "POST", path: "/projects/:id/resume", description: "riprende/processa la prossima proposta pendente (equivalente a `yano suggester resume`/`start`)" },
	{ method: "POST", path: "/projects/:id/stop", description: "ferma il worker (equivalente a `yano suggester stop`)" },
	{ method: "POST", path: "/suggestions/:suggestionId/complete", description: "registra la proposta dell'agente — body per opzioni (equivalente a `yano suggester complete`)" },
	{ method: "POST", path: "/suggestions/:suggestionId/approve", description: "approva la proposta — body: { actor, yes: true } (equivalente a `yano suggester approve`)" },
	{ method: "POST", path: "/suggestions/:suggestionId/reject", description: "rifiuta la proposta — body: { actor, reason, yes: true } (equivalente a `yano suggester reject`)" },
];

function now() { return new Date().toISOString(); }
function value(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
function has(argv, flag) { return argv.includes(flag); }
function json(raw, fallback) { try { return JSON.parse(raw); } catch { return fallback; } }
function slug(valueToSlug) {
	return String(valueToSlug || "project").toLowerCase().normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}
function projectTabLabel(projectName) { return `suggester-${slug(projectName)}`.slice(0, 60); }

function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
	catch (error) { throw new Error(`yano suggester: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`); }
}

function dataRoot() { return path.join(traceRoot(), "suggester"); }
function dbPath() { return path.join(dataRoot(), "suggester.sqlite"); }
function projectDataRoot(key) { return path.join(dataRoot(), "projects", key); }
function normalize(text) { return String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
function redact(text) {
	return String(text || "").slice(0, MAX_TEXT)
		.replace(/((?:sk|api|token|secret|password|key)[-_]?[a-z0-9_]*\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}
function fingerprint(title, description, route = "") { return crypto.createHash("sha256").update(`${normalize(title)}\n${normalize(description)}\n${normalize(route)}`).digest("hex"); }

function openDatabase() {
	fs.mkdirSync(path.dirname(dbPath()), { recursive: true, mode: 0o700 });
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(dbPath());
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS suggester_projects (
			project_key TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			root TEXT NOT NULL UNIQUE,
			workspace_id TEXT,
			worker_tab_id TEXT,
			worker_pane_id TEXT,
			worker_instance TEXT,
			worker_status TEXT NOT NULL DEFAULT 'stopped',
			notify TEXT NOT NULL DEFAULT 'auto',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS suggestions (
			suggestion_id TEXT PRIMARY KEY,
			project_key TEXT NOT NULL REFERENCES suggester_projects(project_key),
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			source TEXT NOT NULL,
			user_id TEXT,
			priority TEXT NOT NULL,
			route TEXT,
			app_version TEXT,
			status TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			approved_by TEXT,
			approved_at TEXT,
			rejected_reason TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS suggestions_fingerprint_idx ON suggestions(project_key, fingerprint);
		CREATE INDEX IF NOT EXISTS suggestions_status_idx ON suggestions(project_key, status, created_at);
		CREATE TABLE IF NOT EXISTS suggestion_analyses (
			analysis_id TEXT PRIMARY KEY,
			suggestion_id TEXT NOT NULL REFERENCES suggestions(suggestion_id),
			category TEXT NOT NULL,
			summary TEXT NOT NULL,
			value TEXT NOT NULL,
			complexity TEXT NOT NULL,
			risk TEXT NOT NULL,
			confidence TEXT NOT NULL,
			duplicate_of TEXT,
			requires_human_decision INTEGER NOT NULL DEFAULT 1,
			report_path TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS suggester_events (
			event_id TEXT PRIMARY KEY,
			project_key TEXT NOT NULL,
			suggestion_id TEXT,
			type TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	return db;
}

function projectInfo(projectRoot, explicitProject = null) {
	const root = path.resolve(projectRoot || process.cwd());
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`yano suggester: project root non valida: ${root}`);
	const name = String(explicitProject || resolveTraceProject(root)).trim();
	if (!name) throw new Error("yano suggester: nome progetto vuoto");
	return { root, name, key: projectKey(root, name) };
}

function ensureProject(db, info, notify = null) {
	const timestamp = now();
	const existing = db.prepare("SELECT * FROM suggester_projects WHERE project_key = ? OR root = ?").get(info.key, info.root);
	if (existing) {
		if (existing.project_key !== info.key) throw new Error(`yano suggester: root già registrata con project key ${existing.project_key}`);
		db.prepare("UPDATE suggester_projects SET name = ?, notify = COALESCE(?, notify), updated_at = ? WHERE project_key = ?").run(info.name, notify, timestamp, info.key);
		return db.prepare("SELECT * FROM suggester_projects WHERE project_key = ?").get(info.key);
	}
	db.prepare("INSERT INTO suggester_projects(project_key,name,root,notify,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(info.key, info.name, info.root, notify || "auto", timestamp, timestamp);
	return db.prepare("SELECT * FROM suggester_projects WHERE project_key = ?").get(info.key);
}

function infoFromRow(row) { return { root: row.root, name: row.name, key: row.project_key }; }

function event(db, info, suggestionId, type, payload = {}) {
	db.prepare("INSERT INTO suggester_events(event_id,project_key,suggestion_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)").run(`suggest-event-${crypto.randomUUID()}`, info.key, suggestionId, type, JSON.stringify(payload), now());
}

function shellQuote(input) {
	return process.platform === "win32" ? `"${String(input).replaceAll('"', '\\"')}"` : `'${String(input).replaceAll("'", `\\'"'"'`)}'`;
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}

function renameHerdrTab(tabId, label) {
	if (!tabId || !label) return;
	const result = spawnSync("herdr", ["tab", "rename", tabId, label], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano suggester: impossibile rinominare la tab ${tabId} in ${label}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function ensureWorkspace(snapshot, dryRun) {
	const existing = snapshot?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (existing) return existing;
	if (dryRun) return { workspace_id: null, label: WORKSPACE_LABEL };
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", path.join(dataRoot(), "agent-workspaces"), "--label", WORKSPACE_LABEL, "--focus"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano suggester: impossibile creare workspace Herdr${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	let workspace = json(result.stdout, null)?.result?.workspace || json(result.stdout, null)?.workspace;
	workspace ||= herdrSnapshot()?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (!workspace?.workspace_id) throw new Error("yano suggester: workspace Herdr creato ma senza workspace_id");
	return workspace;
}

function writeEvidence(info, suggestion) {
	const dir = projectDataRoot(info.key);
	fs.mkdirSync(path.join(dir, "evidence"), { recursive: true, mode: 0o700 });
	const records = readTraceRecords({ cwd: info.root, project: info.name, limit: 80 });
	const overview = buildTraceOverview({ cwd: info.root, project: info.name, limit: 80 });
	const retrieval = planTraceRetrieval({ cwd: info.root, project: info.name, query: `${suggestion.title} ${suggestion.description}`, limit: 10, budget: 5000 });
	const evidence = {
		read_only: true,
		suggestion: { ...suggestion, title: redact(suggestion.title), description: redact(suggestion.description) },
		collected_at: now(),
		trace: { count: records.length, records: records.slice(-40), overview },
		semantic_retrieval: retrieval,
		instructions: "Usa solo queste evidenze e completa il report nella directory globale <YANO_DATA_DIR>/suggester.",
	};
	const evidencePath = path.join(dir, "evidence", `${suggestion.suggestion_id}.json`);
	fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
	return evidencePath;
}

function writeReportSkeleton(info, suggestion, evidencePath) {
	const dir = projectDataRoot(info.key);
	fs.mkdirSync(path.join(dir, "reports"), { recursive: true, mode: 0o700 });
	const reportPath = path.join(dir, "reports", `${suggestion.suggestion_id}.md`);
	fs.writeFileSync(reportPath, [
		`# Suggestion proposal ${suggestion.suggestion_id}`,
		"",
		"> Proposta preliminare read-only. Il report finale richiede analisi dell'agente e approvazione del superadmin.",
		"",
		`- Progetto: ${info.name}`,
		`- Suggerimento: ${suggestion.title}`,
		`- Evidenze: ${evidencePath}`,
		"- Modifiche al progetto: nessuna",
		"",
		"## Output obbligatorio",
		"",
		"Indicare categoria, summary, valore utente, complessità, rischio, confidenza, duplicati, domande aperte e requires_human_decision.",
		"",
		"## Gate",
		"",
		"Non notificare il planner come task operativo prima di `yano suggester approve`.",
		"",
	].join("\n"), { mode: 0o600 });
	return reportPath;
}

function dispatchWorker(info, project, suggestion, { dryRun = false } = {}) {
	const evidencePath = writeEvidence(info, suggestion);
	const reportPath = writeReportSkeleton(info, suggestion, evidencePath);
	const instance = project.worker_instance || `suggester-${info.name}`;
	const prompt = `Analizza il suggerimento ${suggestion.suggestion_id} in modo esclusivamente read-only. Leggi ${evidencePath} e completa ${reportPath}. Non modificare mai ${info.root}. Al termine usa yano suggester complete --project-root ${shellQuote(info.root)} --suggestion-id ${shellQuote(suggestion.suggestion_id)} --report-file ${shellQuote(reportPath)} con i campi della proposta.`;
	const commandLine = `yano start --instance ${shellQuote(instance)} --role suggester --project ${shellQuote(info.name)} --continue ${shellQuote(prompt)}`;
	if (dryRun) return { workspace_id: project.workspace_id, tab_id: project.worker_tab_id, pane_id: project.worker_pane_id, instance, command: commandLine, evidence_path: evidencePath, report_path: reportPath, dry_run: true };
	const snapshot = herdrSnapshot();
	if (!snapshot) throw new Error("yano suggester: Herdr non raggiungibile; avvia Herdr e riprova");
	const workspace = ensureWorkspace(snapshot, false);
	const tabLabel = projectTabLabel(info.name);
	let refreshed = herdrSnapshot() || snapshot;
	let tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && (item.label === tabLabel || item.tab_id === project.worker_tab_id || item.label === info.name));
	let pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	if (tab && tab.label !== tabLabel) {
		renameHerdrTab(tab.tab_id, tabLabel);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.tab_id === tab.tab_id);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab) {
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", tabLabel, "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error(`yano suggester: Herdr non ha creato la tab ${tabLabel}${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === tabLabel);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab || !pane) throw new Error(`yano suggester: tab/pane non trovati per ${tabLabel}`);
	const launched = spawnSync("herdr", ["pane", "run", pane.pane_id, `exec ${commandLine}`], { cwd: info.root, encoding: "utf8" });
	if (launched.status !== 0) throw new Error(`yano suggester: avvio agente fallito${launched.stderr ? `: ${launched.stderr.trim()}` : ""}`);
	return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, instance, command: commandLine, evidence_path: evidencePath, report_path: reportPath, dry_run: false };
}

function nextSuggestion(db, info) { return db.prepare("SELECT * FROM suggestions WHERE project_key = ? AND status = 'received' ORDER BY created_at ASC LIMIT 1").get(info.key); }

function dispatchNext(db, info, project, dryRun = false) {
	if (["paused", "running"].includes(project.worker_status)) return { skipped: true, reason: `worker_${project.worker_status}` };
	const suggestion = nextSuggestion(db, info);
	if (!suggestion) return { skipped: true, reason: "no_pending_suggestion" };
	const launched = dispatchWorker(info, project, suggestion, { dryRun });
	db.prepare("UPDATE suggestions SET status = ?, updated_at = ? WHERE suggestion_id = ?").run("analyzing", now(), suggestion.suggestion_id);
	db.prepare("UPDATE suggester_projects SET workspace_id = COALESCE(?, workspace_id), worker_tab_id = COALESCE(?, worker_tab_id), worker_pane_id = COALESCE(?, worker_pane_id), worker_instance = ?, worker_status = ?, updated_at = ? WHERE project_key = ?").run(launched.workspace_id, launched.tab_id, launched.pane_id, launched.instance, dryRun ? "planned" : "running", now(), info.key);
	event(db, info, suggestion.suggestion_id, "suggestion_dispatched", { read_only: true, ...launched });
	return { suggestion, launched, read_only: true };
}

async function notifyTelegram(message, config) {
	if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_DESTINATION_CHAT_ID) return { ok: false, detail: "telegram_not_configured" };
	try { const response = await fetch(`${(config.YANO_TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, "")}/bot${encodeURIComponent(config.TELEGRAM_BOT_TOKEN)}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: config.TELEGRAM_DESTINATION_CHAT_ID, text: message, disable_web_page_preview: true }) }); return { ok: response.ok, detail: response.ok ? "sent" : `http_${response.status}` }; }
	catch (error) { return { ok: false, detail: `network_${error instanceof Error ? error.message : String(error)}` }; }
}
async function notifyWhatsApp(message, config) {
	const required = ["EVOLUTION_API_URL", "EVOLUTION_API_KEY", "EVOLUTION_INSTANCE_NAME", "DESTINATION_PHONE_NUMBER"];
	if (required.some((key) => !config[key])) return { ok: false, detail: "whatsapp_not_configured" };
	try { const response = await fetch(`${String(config.EVOLUTION_API_URL).replace(/\/$/, "")}/message/sendText/${encodeURIComponent(config.EVOLUTION_INSTANCE_NAME)}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: config.EVOLUTION_API_KEY }, body: JSON.stringify({ number: config.DESTINATION_PHONE_NUMBER, text: message }) }); return { ok: response.ok, detail: response.ok ? "sent" : `http_${response.status}` }; }
	catch (error) { return { ok: false, detail: `network_${error instanceof Error ? error.message : String(error)}` }; }
}
async function notifyEmail(message, config) {
	const required = ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "SENDGRID_TO_EMAIL"];
	if (required.some((key) => !config[key])) return { ok: false, detail: "email_not_configured" };
	try { const response = await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.SENDGRID_API_KEY}` }, body: JSON.stringify({ personalizations: String(config.SENDGRID_TO_EMAIL).split(",").map((email) => ({ to: [{ email: email.trim() }] })), from: { email: config.SENDGRID_FROM_EMAIL }, subject: config.SENDGRID_SUBJECT || "Yano suggester proposal", content: [{ type: "text/plain", value: message }] }) }); return { ok: response.ok, detail: response.ok ? "sent" : `http_${response.status}` }; }
	catch (error) { return { ok: false, detail: `network_${error instanceof Error ? error.message : String(error)}` }; }
}
async function notifyChannels(message, mode) {
	const config = resolveYanoConfig({ packageRoot: PACKAGE_ROOT });
	const selected = mode === "auto" ? ["telegram", "whatsapp", "email"] : mode === "none" ? [] : mode.split(",").map((item) => item.trim());
	const results = {};
	if (selected.includes("telegram")) results.telegram = await notifyTelegram(message, config);
	if (selected.includes("whatsapp")) results.whatsapp = await notifyWhatsApp(message, config);
	if (selected.includes("email")) results.email = await notifyEmail(message, config);
	return results;
}

async function notifyPlanner(info, suggestion, analysis) {
	const client = mqtt.connect(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { reconnectPeriod: 0, connectTimeout: 1500 });
	try {
		await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("planner discovery timeout")), 1800); client.once("connect", () => { clearTimeout(timer); resolve(); }); client.once("error", (error) => { clearTimeout(timer); reject(error); }); });
		const message = { type: "command", assignment_id: `suggestion-${suggestion.suggestion_id}`, sender_instance: "yano-suggester", sender_role: "suggester", project: info.name, correlation_id: suggestion.suggestion_id, display: true, triggerTurn: true, followUp: true, prompt: `[yano-suggester] Suggerimento approvato dal superadmin per ${info.name}. Leggi il report ${analysis.report_path}. Non è stata modificata alcuna parte del progetto. Decidi se chiedere chiarimenti o avviare to-spec → to-tickets.` };
		const routed = await routeAgentMessage({ client, projectRoot: info.root, project: info.name, packageRoot: PACKAGE_ROOT, message, targetRole: "planner" });
		return { delivered: routed.route === "watcher" ? 0 : routed.delivered, planners: routed.planners || [], route: routed.route, watcher_bootstrap: routed.watcher_bootstrap || null };
	} catch (error) { return { delivered: 0, planners: [], detail: error instanceof Error ? error.message : String(error) }; }
	finally { client.end(true); }
}

function assertTempPath(file) {
	const resolved = path.resolve(file);
	if (!resolved.startsWith(`${path.resolve(dataRoot())}${path.sep}`)) throw new Error("yano suggester: report deve restare nella directory globale <YANO_DATA_DIR>/suggester");
	return resolved;
}

async function completeSuggestion(db, opts) {
	const suggestion = db.prepare("SELECT s.*, p.name, p.root, p.notify FROM suggestions s JOIN suggester_projects p ON p.project_key = s.project_key WHERE s.suggestion_id = ?").get(opts.suggestionId);
	if (!suggestion) throw new Error(`yano suggester: suggerimento non trovato: ${opts.suggestionId}`);
	const reportPath = assertTempPath(opts.reportFile || "");
	if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`yano suggester: report non trovato: ${reportPath}`);
	if (!VALID_CATEGORIES.has(opts.category)) throw new Error(`yano suggester: --category deve essere ${[...VALID_CATEGORIES].join(", ")}`);
	const timestamp = now();
	const status = opts.duplicateOf ? "duplicate" : "awaiting_approval";
	const info = { root: suggestion.root, name: suggestion.name, key: suggestion.project_key };
	db.prepare("INSERT INTO suggestion_analyses(analysis_id,suggestion_id,category,summary,value,complexity,risk,confidence,duplicate_of,requires_human_decision,report_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(`ANALYSIS-${crypto.randomUUID()}`, suggestion.suggestion_id, opts.category, redact(opts.summary || "Proposta completata; leggere il report."), redact(opts.value || "Da valutare"), redact(opts.complexity || "Da valutare"), redact(opts.risk || "Da valutare"), redact(opts.confidence || "medium"), opts.duplicateOf || null, opts.requiresHumanDecision === false ? 0 : 1, reportPath, timestamp);
	db.prepare("UPDATE suggestions SET status = ?, updated_at = ? WHERE suggestion_id = ?").run(status, timestamp, suggestion.suggestion_id);
	db.prepare("UPDATE suggester_projects SET worker_status = 'idle', updated_at = ? WHERE project_key = ?").run(timestamp, suggestion.project_key);
	event(db, info, suggestion.suggestion_id, "suggestion_proposed", { status, report_path: reportPath, read_only: true });
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "suggestion_proposed", record_type: "event", source: "yano-suggester", suggestion_id: suggestion.suggestion_id, report_path: reportPath, read_only: true } }); } catch { /* best effort */ }
	return { suggestion_id: suggestion.suggestion_id, status, report_path: reportPath, planner_notified: false, requires_human_decision: true, read_only: true };
}

function parseOptions(argv) {
	const notify = value(argv, "--notify") || "auto";
	if (notify.split(",").some((item) => !VALID_NOTIFY.has(item.trim()))) throw new Error("yano suggester: --notify non valido");
	return { sub: argv[0], projectRoot: value(argv, "--project-root") || process.cwd(), project: value(argv, "--project"), notify: value(argv, "--notify"), title: value(argv, "--title"), description: value(argv, "--description"), source: value(argv, "--source") || "user", userId: value(argv, "--user-id"), priority: value(argv, "--priority") || "medium", route: value(argv, "--route"), appVersion: value(argv, "--app-version"), suggestionId: value(argv, "--suggestion-id"), reportFile: value(argv, "--report-file"), category: value(argv, "--category"), summary: value(argv, "--summary"), value: value(argv, "--value"), complexity: value(argv, "--complexity"), risk: value(argv, "--risk"), confidence: value(argv, "--confidence"), duplicateOf: value(argv, "--duplicate-of"), actor: value(argv, "--actor"), reason: value(argv, "--reason"), port: value(argv, "--port") ? Number(value(argv, "--port")) : null, host: value(argv, "--host") || null, json: has(argv, "--json"), dryRun: has(argv, "--dry-run"), once: has(argv, "--once"), queueOnly: has(argv, "--queue-only"), yes: has(argv, "--yes") };
}

function print(result) { console.log(JSON.stringify(result, null, 2)); }
function usage() { return ["Uso: yano suggester <init|start|submit|status|reports|complete|approve|reject|pause|resume|stop|serve>", "", "  init --project-root <dir> [--notify auto]", "  submit --project-root <dir> --title <titolo> --description <testo> [--queue-only] [--once]", "  start --project-root <dir> [--dry-run] [--once]     processa una sola proposta senza scheduler", "  complete --suggestion-id <id> --report-file <temp-file> --category <bug|feature|improvement|ux>", "  approve --suggestion-id <id> --actor <superadmin> --yes", "  reject --suggestion-id <id> --actor <superadmin> --reason <motivo> --yes", "  status|reports|pause|resume|stop --project-root <dir>", "  serve [--port <porta>] [--host <host>] [--json]     avvia l'API REST del suggester (un'unica istanza per", "                                                        tutti i progetti registrati; default 127.0.0.1:4179,", "                                                        override con YANO_SUGGESTER_API_PORT / --port; imposta", "                                                        YANO_SUGGESTER_API_TOKEN per richiedere 'Authorization:", "                                                        Bearer <token>')", "", "Il worker è read-only; il planner viene notificato soltanto dopo approve. I dati vivono in <YANO_DATA_DIR>/suggester/."] .join("\n"); }

// --- shared operations: CLI switch cases and the REST API below both call
// these, so the two surfaces cannot behave differently. ---

function doInit(project, info) {
	return { project, db_path: dbPath(), data_root: projectDataRoot(info.key), read_only: true };
}

function doStatus(db, project, info) {
	const suggestions = db.prepare("SELECT * FROM suggestions WHERE project_key = ? ORDER BY created_at DESC LIMIT 50").all(info.key);
	const analyses = db.prepare("SELECT * FROM suggestion_analyses WHERE suggestion_id IN (SELECT suggestion_id FROM suggestions WHERE project_key = ?) ORDER BY created_at DESC LIMIT 50").all(info.key);
	return { project, suggestions, analyses, db_path: dbPath(), data_root: projectDataRoot(info.key), read_only: true };
}

function doReports(db, info) {
	return db.prepare("SELECT s.suggestion_id,s.status,s.title,s.created_at,a.report_path,a.category,a.summary FROM suggestions s LEFT JOIN suggestion_analyses a ON a.suggestion_id = s.suggestion_id WHERE s.project_key = ? ORDER BY s.created_at DESC").all(info.key);
}

function doPauseOrStop(db, info, mode) {
	const workerStatus = mode === "pause" ? "paused" : "stopped";
	db.prepare("UPDATE suggester_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run(workerStatus, now(), info.key);
	return { project: info.name, worker_status: workerStatus, note: "stato logico; nessun file del progetto o tab Herdr viene cancellato" };
}

function doResumeOrStart(db, info, project, opts = {}) {
	db.prepare("UPDATE suggester_projects SET worker_status = 'idle', updated_at = ? WHERE project_key = ?").run(now(), info.key);
	return { once: opts.once, ...dispatchNext(db, info, { ...project, worker_status: "idle" }, opts.dryRun) };
}

function doSubmit(db, info, project, opts) {
	if (!opts.title || !opts.description) throw new Error("yano suggester: submit richiede --title e --description");
	if (!VALID_SOURCES.has(opts.source)) throw new Error(`yano suggester: --source deve essere ${[...VALID_SOURCES].join(", ")}`);
	if (!VALID_PRIORITIES.has(opts.priority)) throw new Error(`yano suggester: --priority deve essere ${[...VALID_PRIORITIES].join(", ")}`);
	const title = redact(opts.title).trim();
	const description = redact(opts.description).trim();
	const fp = fingerprint(title, description, opts.route);
	const duplicate = db.prepare("SELECT suggestion_id,status FROM suggestions WHERE project_key = ? AND fingerprint = ?").get(info.key, fp);
	if (duplicate) return { duplicate: true, suggestion_id: duplicate.suggestion_id, status: duplicate.status, read_only: true };
	const suggestionId = `SUG-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	const timestamp = now();
	db.prepare("INSERT INTO suggestions(suggestion_id,project_key,title,description,source,user_id,priority,route,app_version,status,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(suggestionId, info.key, title, description, opts.source, redact(opts.userId), opts.priority, redact(opts.route), redact(opts.appVersion), "received", fp, timestamp, timestamp);
	event(db, info, suggestionId, "suggestion_received", { source: opts.source, priority: opts.priority, read_only: true });
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "suggestion_received", record_type: "feedback", source: "yano-suggester", suggestion_id: suggestionId, priority: opts.priority, read_only: true } }); } catch { /* best effort */ }
	const dispatched = opts.queueOnly ? { skipped: true, reason: "queue_only" } : dispatchNext(db, info, { ...project, worker_status: project.worker_status === "planned" ? "idle" : project.worker_status }, opts.dryRun);
	return { suggestion_id: suggestionId, status: dispatched.suggestion ? "analyzing" : "received", once: opts.once, dispatched, read_only: true, db_path: dbPath() };
}

async function doApproveOrReject(db, info, opts) {
	if (!opts.yes) throw new Error(`yano suggester: ${opts.mode} richiede --yes per confermare il gate umano`);
	if (!opts.actor) throw new Error("yano suggester: serve --actor per auditare l'approvazione");
	const suggestion = db.prepare("SELECT s.*,p.name,p.root,p.notify FROM suggestions s JOIN suggester_projects p ON p.project_key=s.project_key WHERE s.suggestion_id=?").get(opts.suggestionId);
	if (!suggestion) throw new Error(`yano suggester: suggerimento non trovato: ${opts.suggestionId}`);
	if (opts.mode === "approve" && suggestion.status !== "awaiting_approval") throw new Error(`yano suggester: solo una proposta in stato awaiting_approval può essere approvata (stato attuale: ${suggestion.status})`);
	const timestamp = now();
	const nextStatus = opts.mode === "approve" ? "accepted" : "rejected";
	db.prepare("UPDATE suggestions SET status=?,approved_by=?,approved_at=?,rejected_reason=?,updated_at=? WHERE suggestion_id=?").run(nextStatus, opts.mode === "approve" ? opts.actor : null, opts.mode === "approve" ? timestamp : null, opts.mode === "reject" ? redact(opts.reason || "rifiutato dal superadmin") : null, timestamp, suggestion.suggestion_id);
	event(db, info, suggestion.suggestion_id, opts.mode === "approve" ? "suggestion_approved" : "suggestion_rejected", { actor: opts.actor, reason: redact(opts.reason), read_only: true });
	if (opts.mode === "reject") return { suggestion_id: suggestion.suggestion_id, status: nextStatus, planner_notified: false, read_only: true };
	const analysis = db.prepare("SELECT * FROM suggestion_analyses WHERE suggestion_id=? ORDER BY created_at DESC LIMIT 1").get(suggestion.suggestion_id);
	const planner = await notifyPlanner({ root: suggestion.root, name: suggestion.name, key: suggestion.project_key }, suggestion, analysis || { report_path: "" });
	const notifications = await notifyChannels(`✅ Yano suggester: proposta approvata\nProgetto: ${suggestion.name}\nSuggerimento: ${suggestion.suggestion_id}\n${suggestion.title}\nPlanner notificati: ${planner.delivered}`, suggestion.notify);
	return { suggestion_id: suggestion.suggestion_id, status: nextStatus, planner, notifications, read_only: true };
}

// --- REST API (`yano suggester serve`) ---

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

	if (method === "GET" && parts.length === 0) return sendJson(res, 200, { ok: true, service: "yano-suggester", endpoints: ENDPOINTS });
	if (method === "GET" && parts[0] === "health") return sendJson(res, 200, { ok: true });

	if (parts[0] === "projects") {
		if (method === "GET" && parts.length === 1) {
			const rows = db.prepare("SELECT * FROM suggester_projects ORDER BY created_at DESC").all();
			return sendJson(res, 200, { projects: rows });
		}
		if (method === "POST" && parts.length === 1) {
			const body = await readJsonBody(req);
			if (!body.project_root) return sendJson(res, 400, { error: "project_root è obbligatorio" });
			const info = projectInfo(body.project_root, body.project || null);
			const project = ensureProject(db, info, body.notify || null);
			return sendJson(res, 201, doInit(project, info));
		}
		const key = parts[1];
		if (!key) return sendJson(res, 404, { error: "not found" });
		const row = db.prepare("SELECT * FROM suggester_projects WHERE project_key = ?").get(key);
		if (!row) return sendJson(res, 404, { error: `progetto non trovato: ${key}` });
		const info = infoFromRow(row);

		if (method === "GET" && parts.length === 2) return sendJson(res, 200, row);

		if (parts[2] === "suggestions" && method === "GET" && parts.length === 3) return sendJson(res, 200, doStatus(db, row, info));
		if (parts[2] === "reports" && method === "GET" && parts.length === 3) return sendJson(res, 200, { project: row, reports: doReports(db, info) });
		if (parts[2] === "suggestions" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req);
			const opts = { title: body.title, description: body.description, source: body.source || "user", priority: body.priority || "medium", route: body.route || null, userId: body.user_id || null, appVersion: body.app_version || null, queueOnly: Boolean(body.queue_only), once: Boolean(body.once), dryRun: false };
			const result = doSubmit(db, info, row, opts);
			return sendJson(res, result.duplicate ? 200 : 201, result);
		}
		if (parts[2] === "pause" && method === "POST" && parts.length === 3) return sendJson(res, 200, doPauseOrStop(db, info, "pause"));
		if (parts[2] === "stop" && method === "POST" && parts.length === 3) return sendJson(res, 200, doPauseOrStop(db, info, "stop"));
		if (parts[2] === "resume" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req).catch(() => ({}));
			return sendJson(res, 200, doResumeOrStart(db, info, row, { dryRun: Boolean(body.dry_run) }));
		}
		return sendJson(res, 404, { error: "not found" });
	}

	if (parts[0] === "suggestions" && parts[1]) {
		const suggestionId = parts[1];
		if (parts[2] === "complete" && method === "POST") {
			const body = await readJsonBody(req);
			const result = await completeSuggestion(db, { suggestionId, reportFile: body.report_file, category: body.category, summary: body.summary, value: body.value, complexity: body.complexity, risk: body.risk, confidence: body.confidence, duplicateOf: body.duplicate_of });
			return sendJson(res, 200, result);
		}
		if ((parts[2] === "approve" || parts[2] === "reject") && method === "POST") {
			const body = await readJsonBody(req);
			if (body.yes !== true) return sendJson(res, 400, { error: `${parts[2]} richiede { yes: true } per confermare il gate umano` });
			const suggestionRow = db.prepare("SELECT s.suggestion_id, p.project_key, p.root, p.name FROM suggestions s JOIN suggester_projects p ON p.project_key = s.project_key WHERE s.suggestion_id = ?").get(suggestionId);
			if (!suggestionRow) return sendJson(res, 404, { error: `suggerimento non trovato: ${suggestionId}` });
			const info = { root: suggestionRow.root, name: suggestionRow.name, key: suggestionRow.project_key };
			const result = await doApproveOrReject(db, info, { mode: parts[2], actor: body.actor, yes: true, suggestionId, reason: body.reason || null });
			return sendJson(res, 200, result);
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
	const port = opts.port || Number(process.env.YANO_SUGGESTER_API_PORT) || API_DEFAULT_PORT;
	const host = opts.host || "127.0.0.1";
	const token = process.env.YANO_SUGGESTER_API_TOKEN || null;
	const server = http.createServer((req, res) => { handleApiRequest(db, req, res, token); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
	const info = { ok: true, host, port, token_required: Boolean(token), db_path: dbPath(), endpoints: ENDPOINTS };
	console.log(JSON.stringify(info, null, 2));
	if (!opts.json) console.log(`yano suggester: API in ascolto su http://${host}:${port} — Ctrl+C per fermarla${token ? " (Authorization: Bearer <token> richiesto)" : " (nessun token configurato — YANO_SUGGESTER_API_TOKEN per proteggerla)"}`);
	await new Promise((resolve) => {
		let closing = false;
		const shutdown = () => { if (closing) return; closing = true; server.close(() => resolve()); };
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}

export async function runYanoSuggester({ argv = [] } = {}) {
	const opts = parseOptions(argv);
	if (!opts.sub || opts.sub === "--help" || opts.sub === "-h") { console.log(usage()); return; }
	if (opts.sub === "serve") {
		const db = openDatabase();
		try { await runServe(db, { port: opts.port, host: opts.host, json: opts.json }); } finally { db.close(); }
		return;
	}
	if (opts.sub === "complete") {
		const db = openDatabase();
		try { const result = await completeSuggestion(db, opts); print(result); return result; } finally { db.close(); }
	}
	const db = openDatabase();
	try {
		const info = projectInfo(opts.projectRoot, opts.project);
		const project = ensureProject(db, info, opts.notify);
		if (opts.sub === "init") { const result = doInit(project, info); print(result); return result; }
		if (opts.sub === "status") { const result = doStatus(db, project, info); print(result); return result; }
		if (opts.sub === "reports") { const reports = doReports(db, info); print(reports); return reports; }
		if (opts.sub === "pause" || opts.sub === "stop") { const result = doPauseOrStop(db, info, opts.sub); print(result); return result; }
		if (opts.sub === "resume" || opts.sub === "start") { const result = doResumeOrStart(db, info, project, opts); print(result); return result; }
		if (opts.sub === "submit") { const result = doSubmit(db, info, project, opts); print(result); return result; }
		if (opts.sub === "approve" || opts.sub === "reject") { const result = await doApproveOrReject(db, info, { ...opts, mode: opts.sub }); print(result); return result; }
		throw new Error(`yano suggester: comando sconosciuto "${opts.sub}".\n${usage()}`);
	} finally { db.close(); }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) runYanoSuggester({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano suggester: ${error.message}`); process.exit(1); });
