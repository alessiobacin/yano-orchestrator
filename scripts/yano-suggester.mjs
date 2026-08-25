#!/usr/bin/env node

// User-suggestion observer. It owns intake, durable state, bounded evidence,
// approval gates and planner notification. The project under observation is
// never edited by this process or by the yano-suggester worker.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { appendRawTraceRecord, buildTraceOverview, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { planTraceRetrieval } from "./yano-trace-index.mjs";
import { resolveYanoConfig } from "./yano-config.mjs";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_LABEL = "yano-suggester";
const MAX_TEXT = 12_000;
const VALID_CATEGORIES = new Set(["bug", "feature", "improvement", "ux", "out_of_scope", "unsafe"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_SOURCES = new Set(["user", "cli", "system", "debugger", "watcher", "auto-improver"]);
const VALID_NOTIFY = new Set(["auto", "none", "telegram", "whatsapp", "email"]);

function now() { return new Date().toISOString(); }
function value(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
function has(argv, flag) { return argv.includes(flag); }
function json(raw, fallback) { try { return JSON.parse(raw); } catch { return fallback; } }

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
		instructions: "Usa solo queste evidenze e completa il report nella directory globale temp/suggester.",
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
	let refreshed = herdrSnapshot() || snapshot;
	let tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === info.name);
	let pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	if (!tab) {
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", info.name, "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error(`yano suggester: Herdr non ha creato la tab ${info.name}${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === info.name);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab || !pane) throw new Error(`yano suggester: tab/pane non trovati per ${info.name}`);
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
	const live = new Map();
	try {
		await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("planner discovery timeout")), 1800); client.once("connect", () => { clearTimeout(timer); resolve(); }); client.once("error", (error) => { clearTimeout(timer); reject(error); }); });
		await client.subscribeAsync(`pi/${info.name}/agents/+/status`);
		client.on("message", (_topic, payload) => { const card = json(payload.toString(), null); if (card?.role === "planner" && card.instance && card.project === info.name && card.status !== "offline") live.set(card.instance, card); });
		await new Promise((resolve) => setTimeout(resolve, 150));
		const message = { type: "command", assignment_id: `suggestion-${suggestion.suggestion_id}`, sender_instance: "yano-suggester", sender_role: "suggester", project: info.name, correlation_id: suggestion.suggestion_id, display: true, triggerTurn: true, followUp: true, prompt: `[yano-suggester] Suggerimento approvato dal superadmin per ${info.name}. Leggi il report ${analysis.report_path}. Non è stata modificata alcuna parte del progetto. Decidi se chiedere chiarimenti o avviare to-spec → to-tickets.` };
		for (const planner of live.values()) await client.publishAsync(`pi/${info.name}/agents/${planner.instance}/commands`, JSON.stringify(message), { qos: 1 });
		return { delivered: live.size, planners: [...live.keys()] };
	} catch (error) { return { delivered: 0, planners: [], detail: error instanceof Error ? error.message : String(error) }; }
	finally { client.end(true); }
}

function assertTempPath(file) {
	const resolved = path.resolve(file);
	if (!resolved.startsWith(`${path.resolve(dataRoot())}${path.sep}`)) throw new Error("yano suggester: report deve restare nella directory globale temp/suggester");
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
	return { sub: argv[0], projectRoot: value(argv, "--project-root") || process.cwd(), project: value(argv, "--project"), notify: value(argv, "--notify"), title: value(argv, "--title"), description: value(argv, "--description"), source: value(argv, "--source") || "user", userId: value(argv, "--user-id"), priority: value(argv, "--priority") || "medium", route: value(argv, "--route"), appVersion: value(argv, "--app-version"), suggestionId: value(argv, "--suggestion-id"), reportFile: value(argv, "--report-file"), category: value(argv, "--category"), summary: value(argv, "--summary"), value: value(argv, "--value"), complexity: value(argv, "--complexity"), risk: value(argv, "--risk"), confidence: value(argv, "--confidence"), duplicateOf: value(argv, "--duplicate-of"), actor: value(argv, "--actor"), reason: value(argv, "--reason"), json: has(argv, "--json"), dryRun: has(argv, "--dry-run"), once: has(argv, "--once"), queueOnly: has(argv, "--queue-only"), yes: has(argv, "--yes") };
}

function print(result) { console.log(JSON.stringify(result, null, 2)); }
function usage() { return ["Uso: yano suggester <init|start|submit|status|reports|complete|approve|reject|pause|resume|stop>", "", "  init --project-root <dir> [--notify auto]", "  submit --project-root <dir> --title <titolo> --description <testo> [--queue-only] [--once]", "  start --project-root <dir> [--dry-run] [--once]     processa una sola proposta senza scheduler", "  complete --suggestion-id <id> --report-file <temp-file> --category <bug|feature|improvement|ux>", "  approve --suggestion-id <id> --actor <superadmin> --yes", "  reject --suggestion-id <id> --actor <superadmin> --reason <motivo> --yes", "  status|reports|pause|resume|stop --project-root <dir>", "", "Il worker è read-only; il planner viene notificato soltanto dopo approve. I dati vivono in temp/suggester/."] .join("\n"); }

export async function runYanoSuggester({ argv = [] } = {}) {
	const opts = parseOptions(argv);
	if (!opts.sub || opts.sub === "--help" || opts.sub === "-h") { console.log(usage()); return; }
	if (opts.sub === "complete") {
		const db = openDatabase();
		try { const result = await completeSuggestion(db, opts); print(result); return result; } finally { db.close(); }
	}
	const db = openDatabase();
	try {
		const info = projectInfo(opts.projectRoot, opts.project);
		const project = ensureProject(db, info, opts.notify);
		if (opts.sub === "init") { const result = { project, db_path: dbPath(), data_root: projectDataRoot(info.key), read_only: true }; print(result); return result; }
		if (opts.sub === "status") { const suggestions = db.prepare("SELECT * FROM suggestions WHERE project_key = ? ORDER BY created_at DESC LIMIT 50").all(info.key); const analyses = db.prepare("SELECT * FROM suggestion_analyses WHERE suggestion_id IN (SELECT suggestion_id FROM suggestions WHERE project_key = ?) ORDER BY created_at DESC LIMIT 50").all(info.key); const result = { project, suggestions, analyses, db_path: dbPath(), data_root: projectDataRoot(info.key), read_only: true }; print(result); return result; }
		if (opts.sub === "reports") { const reports = db.prepare("SELECT s.suggestion_id,s.status,s.title,s.created_at,a.report_path,a.category,a.summary FROM suggestions s LEFT JOIN suggestion_analyses a ON a.suggestion_id = s.suggestion_id WHERE s.project_key = ? ORDER BY s.created_at DESC").all(info.key); print(reports); return reports; }
		if (opts.sub === "pause" || opts.sub === "stop") { const workerStatus = opts.sub === "pause" ? "paused" : "stopped"; db.prepare("UPDATE suggester_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run(workerStatus, now(), info.key); const result = { project: info.name, worker_status: workerStatus, note: "stato logico; nessun file del progetto o tab Herdr viene cancellato" }; print(result); return result; }
		if (opts.sub === "resume" || opts.sub === "start") { db.prepare("UPDATE suggester_projects SET worker_status = 'idle', updated_at = ? WHERE project_key = ?").run(now(), info.key); const result = { once: opts.once, ...dispatchNext(db, info, { ...project, worker_status: "idle" }, opts.dryRun) }; print(result); return result; }
		if (opts.sub === "submit") {
			if (!opts.title || !opts.description) throw new Error("yano suggester: submit richiede --title e --description");
			if (!VALID_SOURCES.has(opts.source)) throw new Error(`yano suggester: --source deve essere ${[...VALID_SOURCES].join(", ")}`);
			if (!VALID_PRIORITIES.has(opts.priority)) throw new Error(`yano suggester: --priority deve essere ${[...VALID_PRIORITIES].join(", ")}`);
			const title = redact(opts.title).trim(); const description = redact(opts.description).trim(); const fp = fingerprint(title, description, opts.route);
			const duplicate = db.prepare("SELECT suggestion_id,status FROM suggestions WHERE project_key = ? AND fingerprint = ?").get(info.key, fp);
			if (duplicate) { const result = { duplicate: true, suggestion_id: duplicate.suggestion_id, status: duplicate.status, read_only: true }; print(result); return result; }
			const suggestionId = `SUG-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
			const timestamp = now();
			db.prepare("INSERT INTO suggestions(suggestion_id,project_key,title,description,source,user_id,priority,route,app_version,status,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(suggestionId, info.key, title, description, opts.source, redact(opts.userId), opts.priority, redact(opts.route), redact(opts.appVersion), "received", fp, timestamp, timestamp);
			event(db, info, suggestionId, "suggestion_received", { source: opts.source, priority: opts.priority, read_only: true });
			try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "suggestion_received", record_type: "feedback", source: "yano-suggester", suggestion_id: suggestionId, priority: opts.priority, read_only: true } }); } catch { /* best effort */ }
			const dispatched = opts.queueOnly ? { skipped: true, reason: "queue_only" } : dispatchNext(db, info, { ...project, worker_status: project.worker_status === "planned" ? "idle" : project.worker_status }, opts.dryRun);
			const result = { suggestion_id: suggestionId, status: dispatched.suggestion ? "analyzing" : "received", once: opts.once, dispatched, read_only: true, db_path: dbPath() }; print(result); return result;
		}
		if (opts.sub === "approve" || opts.sub === "reject") {
			if (!opts.yes) throw new Error(`yano suggester: ${opts.sub} richiede --yes per confermare il gate umano`);
			if (!opts.actor) throw new Error("yano suggester: serve --actor per auditare l'approvazione");
			const suggestion = db.prepare("SELECT s.*,p.name,p.root,p.notify FROM suggestions s JOIN suggester_projects p ON p.project_key=s.project_key WHERE s.suggestion_id=?").get(opts.suggestionId);
			if (!suggestion) throw new Error(`yano suggester: suggerimento non trovato: ${opts.suggestionId}`);
			if (opts.sub === "approve" && suggestion.status !== "awaiting_approval") throw new Error(`yano suggester: solo una proposta in stato awaiting_approval può essere approvata (stato attuale: ${suggestion.status})`);
			const timestamp = now(); const nextStatus = opts.sub === "approve" ? "accepted" : "rejected";
			db.prepare("UPDATE suggestions SET status=?,approved_by=?,approved_at=?,rejected_reason=?,updated_at=? WHERE suggestion_id=?").run(nextStatus, opts.sub === "approve" ? opts.actor : null, opts.sub === "approve" ? timestamp : null, opts.sub === "reject" ? redact(opts.reason || "rifiutato dal superadmin") : null, timestamp, suggestion.suggestion_id);
			event(db, info, suggestion.suggestion_id, opts.sub === "approve" ? "suggestion_approved" : "suggestion_rejected", { actor: opts.actor, reason: redact(opts.reason), read_only: true });
			if (opts.sub === "reject") { const result = { suggestion_id: suggestion.suggestion_id, status: nextStatus, planner_notified: false, read_only: true }; print(result); return result; }
			const analysis = db.prepare("SELECT * FROM suggestion_analyses WHERE suggestion_id=? ORDER BY created_at DESC LIMIT 1").get(suggestion.suggestion_id);
			const planner = await notifyPlanner({ root: suggestion.root, name: suggestion.name, key: suggestion.project_key }, suggestion, analysis || { report_path: "" });
			const notifications = await notifyChannels(`✅ Yano suggester: proposta approvata\nProgetto: ${suggestion.name}\nSuggerimento: ${suggestion.suggestion_id}\n${suggestion.title}\nPlanner notificati: ${planner.delivered}`, suggestion.notify);
			const result = { suggestion_id: suggestion.suggestion_id, status: nextStatus, planner, notifications, read_only: true }; print(result); return result;
		}
		throw new Error(`yano suggester: comando sconosciuto "${opts.sub}".\n${usage()}`);
	} finally { db.close(); }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) runYanoSuggester({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano suggester: ${error.message}`); process.exit(1); });
