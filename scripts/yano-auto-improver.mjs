#!/usr/bin/env node

// Scheduled, read-only project audits. The LLM worker runs in Herdr; this
// module owns only durable scheduling, bounded evidence collection, report
// storage and planner/notification handoff. It never writes to the project.
//
// `yano auto-improve serve` exposes the same registry over a local-only
// REST API (127.0.0.1 by default). The REST handlers call the exact same
// functions as the CLI switch below, so the two surfaces cannot drift apart.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const WORKSPACE_LABEL = "yano-auto-improver";
const MAX_OUTPUT = 12000;
const MAX_TRACE_RECORDS = 120;
const DEFAULT_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000;
const VALID_NOTIFY = new Set(["auto", "none", "telegram", "whatsapp", "email"]);
const API_DEFAULT_PORT = 4178;
const ENDPOINTS = [
	{ method: "GET", path: "/health", description: "liveness" },
	{ method: "GET", path: "/projects", description: "elenca i progetti registrati con il loro id (project_key)" },
	{ method: "POST", path: "/projects", description: "registra/inizializza un progetto — body: { project_root, project?, interval_ms?, notify? } (equivalente a `yano auto-improve init`)" },
	{ method: "GET", path: "/projects/:id", description: "dettaglio progetto" },
	{ method: "GET", path: "/projects/:id/audits", description: "elenca gli audit del progetto (equivalente a `yano auto-improve status`)" },
	{ method: "GET", path: "/projects/:id/reports", description: "elenca i report globali del progetto (equivalente a `yano auto-improve reports`)" },
	{ method: "POST", path: "/projects/:id/run", description: "prepara/avvia un audit — body: { once?, dry_run?, force? } (equivalente a `yano auto-improve run`/`start`)" },
	{ method: "POST", path: "/projects/:id/pause", description: "sospende la pianificazione (equivalente a `yano auto-improve pause`)" },
	{ method: "POST", path: "/projects/:id/resume", description: "programma un audit immediato (equivalente a `yano auto-improve resume`)" },
	{ method: "POST", path: "/projects/:id/stop", description: "disabilita il progetto senza cancellare dati (equivalente a `yano auto-improve stop`)" },
	{ method: "POST", path: "/audits/:auditId/complete", description: "chiude un audit e notifica il planner — body: { report_file, summary_file?, summary? } (equivalente a `yano auto-improve complete`)" },
];

function now() { return new Date().toISOString(); }
function value(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
function has(argv, flag) { return argv.includes(flag); }
function json(valueToParse, fallback) { try { return JSON.parse(valueToParse); } catch { return fallback; } }
function slug(valueToSlug) {
	return String(valueToSlug || "project").toLowerCase().normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}
function projectTabLabel(projectName) { return `auto-improver-${slug(projectName)}`.slice(0, 60); }

function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
	catch (error) { throw new Error(`yano auto-improve: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`); }
}

function parseDuration(raw) {
	if (raw === null || raw === undefined || raw === "") return DEFAULT_INTERVAL_MS;
	if (/^\d+$/.test(String(raw))) return Math.max(60_000, Number(raw));
	const match = String(raw).trim().match(/^([0-9]+(?:\.[0-9]+)?)(m|h|d|w)$/i);
	if (!match) throw new Error(`yano auto-improve: intervallo non valido "${raw}"; usa 30m, 12h, 5d o 2w`);
	const factor = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2].toLowerCase()];
	return Math.max(60_000, Math.round(Number(match[1]) * factor));
}

function validateNotify(raw) {
	const mode = raw || "auto";
	if (mode.split(",").some((item) => !VALID_NOTIFY.has(item.trim()))) throw new Error(`yano auto-improve: --notify deve essere auto, none, telegram, whatsapp, email o una lista separata da virgole`);
	return mode;
}

function dbPath() { return path.join(traceRoot(), "auto-improver", "auto-improver.sqlite"); }
function dataRoot() { return path.join(traceRoot(), "auto-improver"); }
function projectDataRoot(projectKeyValue) { return path.join(dataRoot(), "projects", projectKeyValue); }

function openDatabase() {
	fs.mkdirSync(path.dirname(dbPath()), { recursive: true, mode: 0o700 });
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(dbPath());
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS auto_projects (
			project_key TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			root TEXT NOT NULL UNIQUE,
			interval_ms INTEGER NOT NULL,
			notify TEXT NOT NULL DEFAULT 'auto',
			workspace_id TEXT,
			worker_tab_id TEXT,
			worker_pane_id TEXT,
			worker_instance TEXT,
			worker_status TEXT NOT NULL DEFAULT 'stopped',
			last_started_at TEXT,
			last_completed_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS auto_audits (
			audit_id TEXT PRIMARY KEY,
			project_key TEXT NOT NULL REFERENCES auto_projects(project_key),
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			evidence_path TEXT NOT NULL,
			report_path TEXT,
			summary TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS auto_audits_project_idx ON auto_audits(project_key, started_at DESC);
		CREATE TABLE IF NOT EXISTS auto_recommendations (
			recommendation_id TEXT PRIMARY KEY,
			audit_id TEXT NOT NULL REFERENCES auto_audits(audit_id),
			category TEXT NOT NULL,
			title TEXT NOT NULL,
			priority TEXT NOT NULL,
			confidence TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'proposed',
			evidence_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS auto_events (
			event_id TEXT PRIMARY KEY,
			project_key TEXT NOT NULL,
			audit_id TEXT,
			type TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	return db;
}

function projectInfo(projectRoot, explicitProject = null) {
	const root = path.resolve(projectRoot || process.cwd());
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`yano auto-improve: project root non valida: ${root}`);
	const name = String(explicitProject || resolveTraceProject(root)).trim();
	if (!name) throw new Error("yano auto-improve: nome progetto vuoto");
	return { root, name, key: projectKey(root, name) };
}

function ensureProject(db, info, { intervalMs, notify } = {}) {
	const timestamp = now();
	const existing = db.prepare("SELECT * FROM auto_projects WHERE project_key = ? OR root = ?").get(info.key, info.root);
	if (existing) {
		if (existing.project_key !== info.key) throw new Error(`yano auto-improve: root già registrata con project key ${existing.project_key}`);
		db.prepare("UPDATE auto_projects SET name = ?, interval_ms = COALESCE(?, interval_ms), notify = COALESCE(?, notify), updated_at = ? WHERE project_key = ?")
			.run(info.name, intervalMs || null, notify || null, timestamp, info.key);
		return db.prepare("SELECT * FROM auto_projects WHERE project_key = ?").get(info.key);
	}
	db.prepare("INSERT INTO auto_projects(project_key,name,root,interval_ms,notify,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
		.run(info.key, info.name, info.root, intervalMs || DEFAULT_INTERVAL_MS, notify || "auto", timestamp, timestamp);
	return db.prepare("SELECT * FROM auto_projects WHERE project_key = ?").get(info.key);
}

function getProject(db, info) { return db.prepare("SELECT * FROM auto_projects WHERE project_key = ? OR root = ?").get(info.key, info.root); }
function infoFromRow(row) { return { root: row.root, name: row.name, key: row.project_key }; }
function safeJson(value, depth = 0) {
	if (depth > 4) return "[truncated]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > 1800 ? `${value.slice(0, 1800)}…` : value;
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeJson(item, depth + 1));
	const secret = /token|password|secret|authorization|api[-_]?key|cookie|private[-_]?key|credential/i;
	return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, secret.test(key) ? "[redacted]" : safeJson(item, depth + 1)]));
}

function command(command, args, cwd, timeout = 10_000) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT });
	return {
		command: [command, ...args].join(" "),
		exit_code: result.status,
		timed_out: result.error?.code === "ETIMEDOUT",
		stdout: String(result.stdout || "").slice(0, MAX_OUTPUT),
		stderr: String(result.stderr || result.error?.message || "").slice(0, MAX_OUTPUT),
	};
}

function readProjectManifest(root) {
	const candidates = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "composer.json"];
	return candidates.filter((file) => fs.existsSync(path.join(root, file))).map((file) => {
		const full = path.join(root, file);
		let text = "";
		try { text = fs.readFileSync(full, "utf8").slice(0, 20_000); } catch { text = "[unreadable]"; }
		if (file === "package.json") {
			const parsed = json(text, {});
			return { file, name: parsed.name || null, scripts: safeJson(parsed.scripts || {}), dependencies: Object.keys(parsed.dependencies || {}).slice(0, 100), devDependencies: Object.keys(parsed.devDependencies || {}).slice(0, 100) };
		}
		return { file, preview: text.replace(/(token|password|secret|key)\s*[:=].*/ig, "$1=[redacted]").slice(0, 5000) };
	});
}

// package.json scripts are useful, but they are not the only reliable signal
// that a project has tests or a build. Keep this discovery bounded and
// metadata-only: the specialist still performs the detailed read-only audit.
function discoverProjectSurfaces(root) {
	const surfaces = { test_files: [], build_files: [], lint_configs: [], ci_workflows: [], mcp_configs: [], plugin_manifests: [], integration_markers: [] };
	const queue = [{ dir: root, relative: "", depth: 0 }];
	const ignored = new Set([".git", ".worktrees", "node_modules", "coverage", ".cache"]);
	const maxFiles = 5000;
	while (queue.length && surfaces.test_files.length + surfaces.build_files.length + surfaces.lint_configs.length < maxFiles) {
		const current = queue.shift();
		let entries = [];
		try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const relative = path.join(current.relative, entry.name);
			if (entry.isDirectory()) {
				if (!ignored.has(entry.name) && current.depth < 5) queue.push({ dir: path.join(current.dir, entry.name), relative, depth: current.depth + 1 });
				continue;
			}
			const normalized = relative.split(path.sep).join("/");
			if (/(^|\/)(?:test|tests|__tests__)(\/|$)/i.test(normalized) || /(^|\/)(?:test|benchmark)[^/]*\.(?:sh|mjs|cjs|js|ts)$/i.test(normalized) || /\.(?:test|spec)\.[^.]+$/i.test(entry.name)) {
				if (surfaces.test_files.length < 80) surfaces.test_files.push(normalized);
			}
			if (/(^|\/)build\//i.test(normalized) || /^(?:Makefile|makefile|gulpfile(?:\.[^.]+)?|Gruntfile(?:\.[^.]+)?)$/i.test(entry.name)) {
				if (surfaces.build_files.length < 40) surfaces.build_files.push(normalized);
			}
			if (/^(?:\.eslintrc(?:\.[^.]+)?|eslint\.config\.[^.]+|biome\.jsonc?|oxlint\.jsonc?|ruff\.toml|\.flake8|mypy\.ini)$/i.test(entry.name)) {
				if (surfaces.lint_configs.length < 40) surfaces.lint_configs.push(normalized);
			}
			if (/^\.github\/workflows\/.+\.(?:yml|yaml)$/i.test(normalized) && surfaces.ci_workflows.length < 40) surfaces.ci_workflows.push(normalized);
			if (/(^|\/)(?:\.mcp\.json|mcp\.json|mcp\.ya?ml)$/i.test(normalized) && surfaces.mcp_configs.length < 40) surfaces.mcp_configs.push(normalized);
			if (/(^|\/)(?:plugin\.json|\.claude-plugin\/|\.codex-plugin\/)/i.test(normalized) && surfaces.plugin_manifests.length < 40) surfaces.plugin_manifests.push(normalized);
			if (/(^|\/)(?:plugins?|connectors?|integrations?|adapters?|providers?|tools?)\//i.test(normalized) && surfaces.integration_markers.length < 80) surfaces.integration_markers.push(normalized);
		}
	}
	return {
		...surfaces,
		test_files: surfaces.test_files.sort(),
		build_files: surfaces.build_files.sort(),
		lint_configs: surfaces.lint_configs.sort(),
		ci_workflows: surfaces.ci_workflows.sort(),
		mcp_configs: surfaces.mcp_configs.sort(),
		plugin_manifests: surfaces.plugin_manifests.sort(),
		integration_markers: surfaces.integration_markers.sort(),
	};
}

function collectEvidence(info, row, auditId) {
	const since = row.last_completed_at ? new Date(row.last_completed_at) : null;
	const trace = readTraceRecords({ cwd: info.root, project: info.name, since, limit: MAX_TRACE_RECORDS });
	const overview = buildTraceOverview({ cwd: info.root, project: info.name, since, limit: MAX_TRACE_RECORDS });
	const failures = trace.filter((record) => record.ok === false || /fail|error|reject|stall|timeout|blocked/i.test(String(record.type || ""))).slice(-40).map(safeJson);
	const feedback = trace.filter((record) => record.record_type === "feedback" || record.type === "feedback").slice(-20).map(safeJson);
	const packageManifest = readProjectManifest(info.root);
	const git = {
		branch: command("git", ["branch", "--show-current"], info.root),
		status: command("git", ["status", "--short"], info.root),
		recent_commits: command("git", ["log", "-n", "12", "--date=iso", "--format=%h %ad %s"], info.root),
	};
	const scripts = packageManifest.find((item) => item.file === "package.json")?.scripts || {};
	const surfaces = discoverProjectSurfaces(info.root);
	const hasTestScript = Boolean(scripts.test || scripts["test:e2e"] || scripts.e2e);
	const hasBuildScript = Boolean(scripts.build);
	const hasLintScript = Boolean(scripts.lint);
	const retrieval = planTraceRetrieval({ cwd: info.root, project: info.name, query: "regressioni errori feedback performance feature mancante test documentazione", limit: 12, budget: 6000 });
	const evidence = {
		read_only: true,
		audit_id: auditId,
		project: info,
		window: { since: since?.toISOString() || null, until: now() },
		collected_at: now(),
		manifest: packageManifest,
		git: safeJson(git),
		trace: { count: trace.length, records: trace.slice(-60).map(safeJson), failures, feedback, overview: safeJson(overview) },
		semantic_retrieval: safeJson(retrieval),
		available_checks: {
			npm_scripts: Object.keys(scripts),
			has_tests: hasTestScript || surfaces.test_files.length > 0,
			has_test_script: hasTestScript,
			has_lint: hasLintScript || surfaces.lint_configs.length > 0,
			has_lint_script: hasLintScript,
			has_build: hasBuildScript || surfaces.build_files.length > 0,
			has_build_script: hasBuildScript,
			project_surfaces: surfaces,
		},
		comparison_audit: {
			required: true,
			mode: "360-degree-gap-analysis",
			dimensions: ["capability", "features", "quality", "performance", "security", "privacy", "documentation", "ux", "llm-agent-ux", "tools", "api", "mcp", "connectors", "plugins", "deployment", "tests", "maturity", "license"],
			source_policy: "Use public first-party repository, documentation and package-registry sources; record URL and fetched evidence for every material comparison.",
			discovery_tools: ["auto_improve_web_search", "auto_improve_web_fetch"],
			queries_to_start: [`${info.name} alternatives`, `${info.name} similar software`, `${info.name} API plugin connector`],
		},
		budgets: { max_trace_records: MAX_TRACE_RECORDS, max_command_output: MAX_OUTPUT, commands_are_observational: true },
	};
	const dir = projectDataRoot(info.key);
	fs.mkdirSync(path.join(dir, "evidence"), { recursive: true, mode: 0o700 });
	const evidencePath = path.join(dir, "evidence", `${auditId}.json`);
	fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
	return { evidence, evidencePath };
}

function initialRecommendations(evidence) {
	const result = [];
	const checks = evidence.available_checks;
	if (!checks.has_tests) result.push({ category: "quality", title: "Aggiungere una suite di test riproducibile", priority: "high", confidence: "high", evidence: ["nessun test o script test rilevato nei marker di progetto"] });
	else if (!checks.has_test_script) result.push({ category: "quality", title: "Esporre un comando test standard", priority: "medium", confidence: "high", evidence: [`test rilevati senza script standard: ${(checks.project_surfaces?.test_files || []).slice(0, 5).join(", ")}`] });
	if (!checks.has_lint) result.push({ category: "quality", title: "Aggiungere linting automatizzato", priority: "medium", confidence: "medium", evidence: ["nessuno script o config lint rilevato"] });
	if (!checks.has_build && evidence.manifest.some((item) => item.file === "package.json")) result.push({ category: "delivery", title: "Definire una build verificabile", priority: "medium", confidence: "medium", evidence: ["nessun marker o script build rilevato"] });
	else if (checks.has_build && !checks.has_build_script) result.push({ category: "delivery", title: "Esporre un comando build standard", priority: "low", confidence: "medium", evidence: [`marker build rilevati senza script: ${(checks.project_surfaces?.build_files || []).slice(0, 5).join(", ")}`] });
	if (evidence.trace.failures.length) result.push({ category: "reliability", title: "Analizzare i failure signal ricorrenti del trace", priority: "high", confidence: "medium", evidence: evidence.trace.failures.slice(0, 5).map((item) => item.type || "trace failure") });
	if (evidence.trace.feedback.some((item) => /rejected|partial|negative/i.test(String(item.status || "")))) result.push({ category: "product", title: "Rivedere i round respinti dall'utente", priority: "high", confidence: "medium", evidence: ["feedback con esito rejected/partial"] });
	return result;
}

function writeReportSkeleton(info, auditId, evidence, recommendations) {
	const dir = projectDataRoot(info.key);
	fs.mkdirSync(path.join(dir, "reports"), { recursive: true, mode: 0o700 });
	const projectReports = path.join(info.root, "docs", "reports");
	fs.mkdirSync(projectReports, { recursive: true, mode: 0o700 });
	const reportPath = path.join(projectReports, `auto-improvement-${italianReportStamp()}.md`);
	const lines = [
		`# Auto-improve audit ${auditId}`,
		"",
		"> Audit preliminare read-only. Il report finale deve essere completato dall'agente e consegnato al planner.",
		"",
		`- Progetto: ${info.name}`,
		`- Root: ${info.root}`,
		`- Audit: ${auditId}`,
		`- Evidence: ${path.join(dir, "evidence", `${auditId}.json`)}`,
		"- Modifiche al progetto: nessuna",
		"",
		"## Raccomandazioni preliminari",
		"",
		...(recommendations.length ? recommendations.map((item, index) => `${index + 1}. **[${item.priority}] ${item.title}** — ${item.category}; confidenza ${item.confidence}. Evidenza: ${item.evidence.join("; ")}`) : ["Nessuna raccomandazione deterministica preliminare; completare l'analisi LLM."]),
		"",
		"## Evidenze da analizzare",
		"",
		`- Trace osservati nella finestra: ${evidence.trace.count}`,
		`- Failure signal candidati: ${evidence.trace.failures.length}`,
		`- Feedback osservati: ${evidence.trace.feedback.length}`,
		`- Test/build/lint rilevati: ${[evidence.available_checks.has_tests && "test", evidence.available_checks.has_build && "build", evidence.available_checks.has_lint && "lint"].filter(Boolean).join(", ") || "nessuno"}`,
		`- Script standard: ${[evidence.available_checks.has_test_script && "test", evidence.available_checks.has_build_script && "build", evidence.available_checks.has_lint_script && "lint"].filter(Boolean).join(", ") || "nessuno rilevato"}`,
		"",
		"## Audit 360° obbligatorio",
		"",
		"Non limitarti alla qualità del codice. Ricostruisci la capability principale del progetto e confrontala con almeno tre alternative comparabili, usando fonti ufficiali HTTPS verificate. Copri feature, performance, sicurezza/privacy, UX, UX per LLM/agent, tool/API, MCP, connettori, plugin/estensioni, deployment, test, maturità e licenza.",
		"",
		"Il report finale deve contenere una matrice `attuale vs alternativa`, URL delle fonti consultate, gap verificati e proposte concrete classificate come bug, miglioramento tecnico, feature prodotto, tool, connettore, plugin o UX. Ogni proposta deve indicare valore, complessità, rischio, confidenza e `requires_human_decision`. Se la ricerca online fallisce, riportare query, fonti non raggiungibili e limite senza inventare risultati.",
		"",
		"## Handoff planner",
		"",
		"L'agente deve completare questo report, indicare confidenza e decisione umana richiesta, poi inviare il risultato al planner. Nessuna modifica è autorizzata.",
		"",
	];
	fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, { mode: 0o600 });
	return reportPath;
}

function italianReportStamp(date = new Date()) {
	const two = (value) => String(value).padStart(2, "0");
	return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${two(date.getHours())}_${two(date.getMinutes())}`;
}

function shellQuote(valueToQuote) {
	return process.platform === "win32" ? `"${String(valueToQuote).replaceAll('"', '\\"')}"` : `'${String(valueToQuote).replaceAll("'", `\\'"'"'`)}'`;
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}

function renameHerdrTab(tabId, label) {
	if (!tabId || !label) return;
	const result = spawnSync("herdr", ["tab", "rename", tabId, label], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano auto-improve: impossibile rinominare la tab ${tabId} in ${label}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

function composeWorkerArgs(info, instance, readOnlyTools) {
	const launcher = path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs");
	// Compose from the observed project root so relative extension paths and
	// project-scoped config resolve exactly as they will in the real pane. The
	// auto-improver can still inspect any repository once it has the minimal
	// Yano launch markers; it never requires the app itself to be scaffolded.
	const composed = spawnSync(process.execPath, [launcher, "--instance", instance, "--role", "auto-improver", "--project", info.name, "--tools", readOnlyTools, "--print-only", "--json"], { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
	if (composed.status !== 0) throw new Error(`yano auto-improve: composizione del worker fallita${composed.stderr ? `: ${composed.stderr.trim()}` : ""}`);
	const line = String(composed.stdout || "").trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
	let args = null;
	try { args = JSON.parse(line || "").args; } catch { /* validated below */ }
	if (!Array.isArray(args)) throw new Error("yano auto-improve: launch-planner non ha restituito argomenti Pi validi");
	return args;
}

function ensureWorkspace(snapshot, dryRun, projectRoot) {
	const existing = snapshot?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (existing) return existing;
	if (dryRun) return { workspace_id: null, label: WORKSPACE_LABEL };
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", projectRoot || path.join(dataRoot(), "agent-workspaces"), "--label", WORKSPACE_LABEL, "--focus"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano auto-improve: impossibile creare workspace Herdr${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	let workspace = null;
	try { const parsed = JSON.parse(result.stdout); workspace = parsed?.result?.workspace || parsed?.workspace; } catch { /* refresh below */ }
	workspace ||= herdrSnapshot()?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (!workspace?.workspace_id) throw new Error("yano auto-improve: workspace Herdr creato ma senza workspace_id");
	return workspace;
}

function launchWorker(info, row, auditId, evidencePath, reportPath, dryRun = false) {
	const workspaceRoot = path.join(dataRoot(), "agent-workspaces");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const instance = row.worker_instance || `auto-improver-${info.name}`;
	const serviceOnly = !auditId;
	const prompt = serviceOnly
		? `Il servizio auto-improver per ${info.name} è stato ripristinato dopo una perdita di Herdr. Non avviare un audit: l'ultimo audit è completato e il prossimo è pianificato per ${row.next_run_at || "la prossima scadenza"}. Rimani inattivo e read-only; non modificare il progetto. Se ricevi un audit esplicito, usa esclusivamente gli strumenti consentiti e completa soltanto il report globale.`
		: `Esegui l'audit auto-improve ${auditId} in modo esclusivamente read-only e con valutazione a 360 gradi. Leggi evidence pack ${evidencePath} e analizza direttamente ${info.root} senza modificarlo. Oltre a codice, test, performance, sicurezza, documentazione e UX, identifica la missione/capability principale del progetto e confrontala con almeno 3 software o servizi comparabili. Usa auto_improve_web_search per trovare candidati e auto_improve_web_fetch per verificare solo fonti ufficiali HTTPS: repository, documentazione o package registry. Per ogni confronto valuta feature, qualità del retrieval/risultato, esperienza utente, esperienza LLM/agent, tool/API, MCP, connettori, plugin/estensioni, integrazioni, privacy, deployment, performance, test, maturità e licenza. Produci una gap matrix tra progetto attuale e alternative e proposte concrete di feature, correzioni, tool, connettori e plugin mancanti, ciascuna con valore, complessità, rischio, confidenza e requires_human_decision. Distingui sempre evidenza verificata, inferenza e limite non verificabile; non inventare fonti o feature. Se il web non è disponibile, documenta le query e il limite invece di fingere il confronto. Completa il report ${reportPath} usando il tool auto_improve_complete; è l'unica scrittura autorizzata e riguarda esclusivamente il report in docs/reports del progetto. Non usare bash, edit, write, git, build, worktree o comandi equivalenti. Invia il risultato al planner.`;
	// Never resume an old Pi transcript: an auto-improve audit is a fresh,
	// bounded read-only inspection. The Herdr tab/instance may be reused, but
	// `--continue` could resurrect stale implementation context and commands.
	const readOnlyTools = "read,grep,find,ls,auto_improve_web_search,auto_improve_web_fetch,agent_list,agent_get,agent_send,agent_await,auto_improve_complete";
	// A restored idle service must remain an interactive Pi instance. Supplying a
	// one-shot recovery prompt makes Pi complete it and exit, which would create
	// an unnecessary restart loop on the next supervisor pass.
	const commandLine = serviceOnly
		? `yano start --instance ${shellQuote(instance)} --role auto-improver --project ${shellQuote(info.name)} --tools ${shellQuote(readOnlyTools)}`
		: `yano start --instance ${shellQuote(instance)} --role auto-improver --project ${shellQuote(info.name)} --tools ${shellQuote(readOnlyTools)} <audit-prompt-as-argv>`;
	if (dryRun) return { workspace_id: row.workspace_id, tab_id: row.worker_tab_id, pane_id: row.worker_pane_id, instance, command: commandLine, dry_run: true };
	const snapshot = herdrSnapshot();
	if (!snapshot) throw new Error("yano auto-improve: Herdr non raggiungibile; avvia Herdr e riprova");
	const workspace = ensureWorkspace(snapshot, false, info.root);
	const tabLabel = projectTabLabel(info.name);
	let refreshed = herdrSnapshot() || snapshot;
	let tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && (item.label === tabLabel || item.tab_id === row.worker_tab_id || item.label === info.name));
	let pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	if (tab && tab.label !== tabLabel) {
		renameHerdrTab(tab.tab_id, tabLabel);
		refreshed = herdrSnapshot() || refreshed;
		tab = refreshed.tabs?.find((item) => item.tab_id === tab.tab_id);
		pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab) {
		// Herdr creates a numeric starter tab when it creates a workspace. Reuse
		// that empty tab instead of leaving a useless `1` beside the real worker.
		const initialTab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && /^(1|\d+)$/.test(item.label || ""));
		const initialPane = initialTab && refreshed.panes?.find((item) => item.tab_id === initialTab.tab_id);
		const initialBusy = initialPane && !["done", "offline", "unknown", "completed"].includes(String(initialPane.agent_status || "").toLowerCase()) && initialPane.agent_status;
		const initialCwdMatches = initialPane && path.resolve(initialPane.cwd || "") === path.resolve(info.root);
		if (initialTab && initialPane && !initialBusy && initialCwdMatches) {
			renameHerdrTab(initialTab.tab_id, tabLabel);
			refreshed = herdrSnapshot() || refreshed;
			tab = refreshed.tabs?.find((item) => item.tab_id === initialTab.tab_id);
			pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
		} else {
			// A workspace created with an old Yano version may retain its numeric
			// starter tab rooted at the service data directory. Never launch a
			// project audit from that cwd: close the empty tab and recreate it at
			// the observed project's root.
			if (initialTab && initialPane && !initialBusy && !initialCwdMatches) {
				const closed = spawnSync("herdr", ["tab", "close", initialTab.tab_id], { encoding: "utf8" });
				if (closed.status !== 0) throw new Error(`yano auto-improve: impossibile chiudere la tab iniziale ${initialTab.label}${closed.stderr ? `: ${closed.stderr.trim()}` : ""}`);
				refreshed = herdrSnapshot() || refreshed;
			}
			const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", tabLabel, "--no-focus"], { encoding: "utf8" });
			if (created.status !== 0) throw new Error(`yano auto-improve: Herdr non ha creato la tab ${tabLabel}${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
			refreshed = herdrSnapshot() || refreshed;
			tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === tabLabel);
			pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
		}
	}
	if (!tab || !pane) throw new Error(`yano auto-improve: tab/pane non trovati per ${tabLabel}`);
	// Older runs may already have both the correctly named project tab and the
	// numeric starter tab. Remove only an idle/unknown numeric tab whose cwd is
	// not the observed project, preserving any real interactive tab.
	for (const numericTab of (refreshed.tabs || []).filter((item) => item.workspace_id === workspace.workspace_id && item.tab_id !== tab.tab_id && /^(1|\d+)$/.test(item.label || ""))) {
		const numericPane = (refreshed.panes || []).find((item) => item.tab_id === numericTab.tab_id);
		const status = String(numericPane?.agent_status || "").toLowerCase();
		const idle = !status || ["done", "idle", "offline", "unknown", "completed"].includes(status);
		const wrongRoot = path.resolve(numericPane?.cwd || "") !== path.resolve(info.root);
		if (numericPane && idle && wrongRoot) {
			const closed = spawnSync("herdr", ["tab", "close", numericTab.tab_id], { encoding: "utf8" });
			if (closed.status !== 0) throw new Error(`yano auto-improve: impossibile chiudere la tab numerica ${numericTab.label}${closed.stderr ? `: ${closed.stderr.trim()}` : ""}`);
		}
	}
	if (serviceOnly) {
		const stale = herdrSnapshot()?.panes?.find((item) => item.pane_id === pane.pane_id);
		if (stale && ["done", "unknown", "offline", "completed"].includes(String(stale.agent_status || "").toLowerCase())) {
			const closed = spawnSync("herdr", ["tab", "close", tab.tab_id], { encoding: "utf8" });
			if (closed.status !== 0) throw new Error(`yano auto-improve: impossibile chiudere la tab idle conclusa${closed.stderr ? `: ${closed.stderr.trim()}` : ""}`);
			const created = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", tabLabel, "--no-focus"], { encoding: "utf8" });
			if (created.status !== 0) throw new Error(`yano auto-improve: impossibile ricreare la tab idle${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
			refreshed = herdrSnapshot() || refreshed;
			tab = refreshed.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === tabLabel);
			pane = tab && refreshed.panes?.find((item) => item.tab_id === tab.tab_id);
			if (!tab || !pane) throw new Error(`yano auto-improve: tab idle ricreata ma pane non trovato per ${tabLabel}`);
		}
		// Herdr retains a completed agent name, so a recovered idle service needs
		// a fresh, scoped identity even when it reuses the same tab/pane.
		const recoveredInstance = `${slug(instance)}-r-${Date.now().toString(36)}`.slice(0, 32);
		const launcher = path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs");
		const composed = spawnSync(process.execPath, [launcher, "--instance", recoveredInstance, "--role", "auto-improver", "--project", info.name, "--print-only", "--json"], { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
		if (composed.status !== 0) throw new Error(`yano auto-improve: composizione del worker idle fallita${composed.stderr ? `: ${composed.stderr.trim()}` : ""}`);
		const line = String(composed.stdout || "").trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
		let piArgs = null;
		try { piArgs = JSON.parse(line || "").args; } catch { /* validated below */ }
		if (!Array.isArray(piArgs)) throw new Error("yano auto-improve: launch-planner non ha restituito argomenti Pi validi per il worker idle");
		const started = spawnSync("herdr", ["agent", "start", recoveredInstance, "--kind", "pi", "--pane", pane.pane_id, "--", ...piArgs], { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
		if (started.status !== 0) throw new Error(`yano auto-improve: avvio agente idle fallito${started.stderr ? `: ${started.stderr.trim()}` : (started.stdout ? `: ${started.stdout.trim()}` : "")}`);
		return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, instance: recoveredInstance, command: `pi ${piArgs.map(shellQuote).join(" ")}`, dry_run: false };
	}
	const piArgs = serviceOnly ? null : composeWorkerArgs(info, instance, readOnlyTools);
	const agentInstance = `${slug(instance)}-r-${Date.now().toString(36)}`.slice(0, 32);
	const startArgs = serviceOnly
		? null
		: ["agent", "start", agentInstance, "--kind", "pi", "--pane", pane.pane_id, "--", ...piArgs];
	const launched = serviceOnly
		? spawnSync("herdr", ["pane", "run", pane.pane_id, `exec ${commandLine}`], { cwd: info.root, encoding: "utf8" })
		: spawnSync("herdr", startArgs, { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
	if (launched.status !== 0) throw new Error(`yano auto-improve: avvio agente fallito${launched.stderr ? `: ${launched.stderr.trim()}` : ""}`);
	// Do not put the audit prompt in a shell command or in Pi's argv: Herdr
	// shells impose practical line limits and silently truncate long prompts.
	// Deliver it through the agent API after interactive readiness is observed.
	if (!serviceOnly) {
		const prompted = spawnSync("herdr", ["agent", "prompt", agentInstance, prompt], { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
		if (prompted.status !== 0) throw new Error(`yano auto-improve: consegna del prompt audit fallita${prompted.stderr ? `: ${prompted.stderr.trim()}` : ""}`);
	}
	return { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: pane.pane_id, instance: serviceOnly ? instance : agentInstance, command: serviceOnly ? commandLine : `herdr agent start ${agentInstance} --kind pi --pane ${pane.pane_id} -- [Pi args]`, command_args: piArgs, prompt_delivery: serviceOnly ? null : "herdr agent prompt (API payload)", dry_run: false };
}

function createAudit(db, info, row) {
	const auditId = `AUDIT-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	const { evidence, evidencePath } = collectEvidence(info, row, auditId);
	const recommendations = initialRecommendations(evidence);
	const reportPath = writeReportSkeleton(info, auditId, evidence, recommendations);
	const timestamp = now();
	db.prepare("INSERT INTO auto_audits(audit_id,project_key,status,started_at,evidence_path,report_path,summary,created_at) VALUES(?,?,?,?,?,?,?,?)")
		.run(auditId, info.key, "awaiting_agent", timestamp, evidencePath, reportPath, "Audit preliminare read-only creato; in attesa del report dell'agente.", timestamp);
	for (const recommendation of recommendations) db.prepare("INSERT INTO auto_recommendations(recommendation_id,audit_id,category,title,priority,confidence,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
		.run(`REC-${crypto.randomUUID()}`, auditId, recommendation.category, recommendation.title, recommendation.priority, recommendation.confidence, JSON.stringify(recommendation.evidence), timestamp);
	db.prepare("UPDATE auto_projects SET last_started_at = ?, next_run_at = ?, updated_at = ? WHERE project_key = ?")
		.run(timestamp, new Date(Date.now() + row.interval_ms).toISOString(), timestamp, info.key);
	db.prepare("INSERT INTO auto_events(event_id,project_key,audit_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
		.run(`auto-event-${crypto.randomUUID()}`, info.key, auditId, "audit_started", JSON.stringify({ read_only: true, evidence_path: evidencePath, report_path: reportPath }), timestamp);
	return { auditId, evidence, evidencePath, reportPath, recommendations };
}

async function notifyTelegram(message, config) {
	if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_DESTINATION_CHAT_ID) return { ok: false, detail: "telegram_not_configured" };
	const base = (config.YANO_TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, "");
	try {
		const response = await fetch(`${base}/bot${encodeURIComponent(config.TELEGRAM_BOT_TOKEN)}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: config.TELEGRAM_DESTINATION_CHAT_ID, text: message, disable_web_page_preview: true }) });
		const payload = await response.json().catch(() => null);
		return { ok: response.ok && payload?.ok !== false, detail: response.ok ? "sent" : `http_${response.status}` };
	} catch (error) { return { ok: false, detail: `network_${error instanceof Error ? error.message : String(error)}` }; }
}

async function notifyWhatsApp(message, config) {
	const required = ["EVOLUTION_API_URL", "EVOLUTION_API_KEY", "EVOLUTION_INSTANCE_NAME", "DESTINATION_PHONE_NUMBER"];
	if (required.some((key) => !config[key])) return { ok: false, detail: "whatsapp_not_configured" };
	try {
		const response = await fetch(`${String(config.EVOLUTION_API_URL).replace(/\/$/, "")}/message/sendText/${encodeURIComponent(config.EVOLUTION_INSTANCE_NAME)}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: config.EVOLUTION_API_KEY }, body: JSON.stringify({ number: config.DESTINATION_PHONE_NUMBER, text: message }) });
		return { ok: response.ok, detail: response.ok ? "sent" : `http_${response.status}` };
	} catch (error) { return { ok: false, detail: `network_${error instanceof Error ? error.message : String(error)}` }; }
}

async function notifyEmail(message, config) {
	const required = ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "SENDGRID_TO_EMAIL"];
	if (required.some((key) => !config[key])) return { ok: false, detail: "email_not_configured" };
	try {
		const personalizations = String(config.SENDGRID_TO_EMAIL).split(",").map((email) => ({ to: [{ email: email.trim() }] }));
		const response = await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.SENDGRID_API_KEY}` }, body: JSON.stringify({ personalizations, from: { email: config.SENDGRID_FROM_EMAIL }, subject: config.SENDGRID_SUBJECT || "Yano auto-improve report", content: [{ type: "text/plain", value: message }] }) });
		return { ok: response.ok, detail: response.ok ? "sent" : `http_${response.status}` };
	} catch (error) { return { ok: false, detail: `network_${error instanceof Error ? error.message : String(error)}` }; }
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

async function notifyPlanner(info, audit, summary) {
	const broker = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
	const client = mqtt.connect(broker, { reconnectPeriod: 0, connectTimeout: 1500 });
	try {
		await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("planner discovery timeout")), 1800); client.once("connect", () => { clearTimeout(timer); resolve(); }); client.once("error", (error) => { clearTimeout(timer); reject(error); }); });
		const message = { type: "command", assignment_id: `auto-improve-${audit.audit_id}`, sender_instance: "yano-auto-improver", sender_role: "auto-improver", project: info.name, correlation_id: audit.audit_id, display: true, triggerTurn: true, followUp: true, prompt: `[yano-auto-improver] Audit completato per ${info.name}. Leggi il report ${audit.report_path}. Summary: ${summary}. Decidi se procedere direttamente o chiedere una decisione all'utente; l'auto-improver non ha modificato il progetto.` };
		const routed = await routeAgentMessage({ client, projectRoot: info.root, project: info.name, packageRoot: PACKAGE_ROOT, message, targetRole: "planner" });
		return { delivered: routed.route === "watcher" ? 0 : routed.delivered, planners: routed.planners || [], route: routed.route, watcher_bootstrap: routed.watcher_bootstrap || null };
	} catch (error) { return { delivered: 0, planners: [], detail: error instanceof Error ? error.message : String(error) }; }
	finally { client.end(true); }
}

function assertTempPath(file, projectRoot = process.cwd()) {
	const resolved = path.resolve(file);
	const root = path.resolve(dataRoot()) + path.sep;
	const projectReports = path.join(path.resolve(projectRoot), "docs", "reports") + path.sep;
	if (!resolved.startsWith(root) && !resolved.startsWith(projectReports)) throw new Error("yano auto-improve: report fuori dal data-root globale o da docs/reports del progetto");
	return resolved;
}

async function completeAudit(db, opts) {
	const audit = db.prepare("SELECT a.*, p.name, p.root, p.notify FROM auto_audits a JOIN auto_projects p ON p.project_key = a.project_key WHERE a.audit_id = ?").get(opts.auditId);
	if (!audit) throw new Error(`yano auto-improve: audit non trovato: ${opts.auditId}`);
	const reportPath = assertTempPath(opts.reportFile || audit.report_path, audit.root);
	if (!fs.existsSync(reportPath)) throw new Error(`yano auto-improve: report non trovato: ${reportPath}`);
	let summary = opts.summary || "Report auto-improve completato; consultare il report completo.";
	if (opts.summaryFile && fs.existsSync(assertTempPath(opts.summaryFile, audit.root))) {
		const summaryText = fs.readFileSync(assertTempPath(opts.summaryFile, audit.root), "utf8").slice(0, 4000);
		const parsed = json(summaryText, null);
		summary = typeof parsed?.summary === "string" ? parsed.summary : summaryText;
	}
	const timestamp = now();
	db.prepare("UPDATE auto_audits SET status = ?, completed_at = ?, report_path = ?, summary = ? WHERE audit_id = ?").run("completed", timestamp, reportPath, summary, audit.audit_id);
	// A later successful audit proves that earlier interrupted attempts are no
	// longer actionable. Keep them for auditability but never let them revive a
	// stale worker after a restart.
	db.prepare("UPDATE auto_audits SET status = ?, completed_at = COALESCE(completed_at, ?) WHERE project_key = ? AND audit_id <> ? AND status IN ('awaiting_agent','running')")
		.run("superseded", timestamp, audit.project_key, audit.audit_id);
	db.prepare("UPDATE auto_projects SET worker_status = ?, last_completed_at = ?, updated_at = ? WHERE project_key = ?").run("idle", timestamp, timestamp, audit.project_key);
	db.prepare("INSERT INTO auto_events(event_id,project_key,audit_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)").run(`auto-event-${crypto.randomUUID()}`, audit.project_key, audit.audit_id, "audit_completed", JSON.stringify({ report_path: reportPath, summary: summary.slice(0, 1000), read_only: true }), timestamp);
	const info = { root: audit.root, name: audit.name, key: audit.project_key };
	try { appendRawTraceRecord({ cwd: info.root, project: info.name, record: { type: "auto_improve_completed", record_type: "event", source: "yano-auto-improver", instance: "yano-auto-improver", audit_id: audit.audit_id, report_path: reportPath, read_only: true } }); } catch { /* best effort */ }
	const planner = await notifyPlanner(info, { audit_id: audit.audit_id, report_path: reportPath }, summary.slice(0, 1200));
	const notifications = await notifyChannels(`✅ Yano auto-improve completato\nProgetto: ${info.name}\nAudit: ${audit.audit_id}\n${summary.slice(0, 1200)}\nReport: ${reportPath}\nPlanner notificati: ${planner.delivered}`, audit.notify);
	return { audit_id: audit.audit_id, status: "completed", report_path: reportPath, planner, notifications };
}

function parseOptions(argv) {
	const notifyRaw = value(argv, "--notify");
	const intervalRaw = value(argv, "--interval") || value(argv, "--interval-ms");
	return { sub: argv[0], projectRoot: value(argv, "--project-root") || process.cwd(), project: value(argv, "--project"), intervalMs: intervalRaw === null ? null : parseDuration(intervalRaw), notify: notifyRaw === null ? null : validateNotify(notifyRaw), auditId: value(argv, "--audit-id"), reportFile: value(argv, "--report-file"), summaryFile: value(argv, "--summary-file"), summary: value(argv, "--summary"), port: value(argv, "--port") ? Number(value(argv, "--port")) : null, host: value(argv, "--host") || null, json: has(argv, "--json"), dryRun: has(argv, "--dry-run"), once: has(argv, "--once"), force: has(argv, "--force"), noDaemon: has(argv, "--no-daemon") };
}

function print(valueToPrint, machine) { console.log(machine ? JSON.stringify(valueToPrint, null, 2) : JSON.stringify(valueToPrint, null, 2)); }
function usage() {
	return [
		"Uso: yano auto-improve <init|start|run|status|reports|pause|resume|stop|complete|serve|supervise> [opzioni]",
		"",
		"  init --project-root <dir> --interval 5d --notify auto   registra il progetto",
		"  start --project-root <dir> [--dry-run]                 crea/riusa tab Herdr e scheduler",
		"  start --project-root <dir> --once                     avvia un solo audit senza scheduler persistente",
		"  run --project-root <dir> [--once]                     prepara un audit immediato; --once non avvia scheduler",
		"  status --project-root <dir> [--json]                  mostra scheduler/audit",
		"  reports --project-root <dir>                           elenca report globali",
		"  pause|resume|stop --project-root <dir>                 cambia stato senza toccare il progetto",
		"  complete --audit-id <id> --report-file <temp-file>     chiude audit e notifica planner",
		"  serve [--port <porta>] [--host <host>] [--json]        avvia l'API REST dell'auto-improver",
		"  supervise [--json]                                     riavvia solo lo scheduler globale, senza creare audit",
		"                                                          (un'unica istanza per tutti i progetti registrati;",
		"                                                          default 127.0.0.1:4178, override con",
		"                                                          YANO_AUTO_IMPROVER_API_PORT / --port; imposta",
		"                                                          YANO_AUTO_IMPROVER_API_TOKEN per richiedere",
		"                                                          'Authorization: Bearer <token>').",
		"",
		"Nessun sottocomando modifica il progetto osservato. I dati vivono in <YANO_DATA_DIR>/auto-improver/.",
	].join("\n");
}

function startDaemon() {
	const pidPath = path.join(dataRoot(), "scheduler.pid");
	fs.mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
	if (fs.existsSync(pidPath)) {
		const pid = Number(fs.readFileSync(pidPath, "utf8"));
		try { process.kill(pid, 0); return { running: true, pid, reused: true }; } catch { /* stale pid */ }
	}
	const child = spawn(process.execPath, [SCRIPT_PATH, "daemon"], { detached: true, stdio: "ignore", env: process.env });
	child.unref();
	fs.writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
	return { running: true, pid: child.pid, reused: false };
}

async function runAudit(db, info, row, { dryRun = false, force = false } = {}) {
	if (!force && ["awaiting_agent", "running"].includes(row.worker_status)) return { skipped: true, reason: "audit_already_running", project: row };
	const audit = createAudit(db, info, row);
	const launched = launchWorker(info, row, audit.auditId, audit.evidencePath, audit.reportPath, dryRun);
	db.prepare("UPDATE auto_projects SET workspace_id = COALESCE(?, workspace_id), worker_tab_id = COALESCE(?, worker_tab_id), worker_pane_id = COALESCE(?, worker_pane_id), worker_instance = ?, worker_status = ?, updated_at = ? WHERE project_key = ?")
		.run(launched.workspace_id, launched.tab_id, launched.pane_id, launched.instance, dryRun ? "planned" : "running", now(), info.key);
	return { ...audit, launched, project: info, read_only: true };
}

async function daemonLoop() {
	const db = openDatabase();
	process.on("SIGTERM", () => { try { db.close(); } finally { process.exit(0); } });
	while (true) {
		const due = db.prepare("SELECT * FROM auto_projects WHERE worker_status NOT IN ('paused','stopped','running','awaiting_agent') AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now());
		for (const row of due) {
			try { await runAudit(db, { root: row.root, name: row.name, key: row.project_key }, row); } catch (error) { db.prepare("UPDATE auto_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run("blocked", now(), row.project_key); console.error(`yano auto-improve scheduler: ${error.message}`); }
		}
		await new Promise((resolve) => setTimeout(resolve, 30_000));
	}
}

// --- shared operations: CLI switch cases and the REST API below both call
// these, so the two surfaces cannot behave differently. ---

function doInit(db, info, opts = {}) {
	const row = ensureProject(db, info, { intervalMs: opts.intervalMs, notify: opts.notify });
	return { project: row, db_path: dbPath(), data_root: projectDataRoot(info.key), read_only: true };
}

function doStatus(db, row) {
	const audits = db.prepare("SELECT * FROM auto_audits WHERE project_key = ? ORDER BY started_at DESC LIMIT 20").all(row.project_key);
	return { project: row, audits, db_path: dbPath(), data_root: projectDataRoot(row.project_key), read_only: true };
}

function doReports(db, row) {
	return db.prepare("SELECT audit_id,status,started_at,completed_at,report_path,summary FROM auto_audits WHERE project_key = ? ORDER BY started_at DESC").all(row.project_key);
}

function doPauseOrStop(db, info, row, mode) {
	const workerStatus = mode === "pause" ? "paused" : "stopped";
	db.prepare("UPDATE auto_projects SET worker_status = ?, updated_at = ? WHERE project_key = ?").run(workerStatus, now(), row.project_key);
	return { project: info.name, worker_status: workerStatus, note: "stato logico; nessuna tab Herdr o file del progetto viene cancellato" };
}

async function doResume(db, info, row, opts = {}) {
	db.prepare("UPDATE auto_projects SET worker_status = ?, next_run_at = ?, updated_at = ? WHERE project_key = ?").run("scheduled", now(), now(), row.project_key);
	return await runAudit(db, info, { ...row, worker_status: "scheduled", next_run_at: now() }, { dryRun: opts.dryRun, force: true });
}

async function doRunOrStart(db, info, row, opts = {}) {
	const result = await runAudit(db, info, { ...row, worker_status: opts.force ? "scheduled" : row.worker_status }, { dryRun: opts.dryRun, force: opts.force || opts.isStart });
	const scheduler = opts.once || opts.dryRun || opts.noDaemon ? { running: false, skipped: true, once: opts.once } : startDaemon();
	return { ...result, once: opts.once, scheduler };
}

function doRestoreIdleWorker(db, info, row, { dryRun = false } = {}) {
	const launched = launchWorker(info, row, null, null, null, dryRun);
	if (!dryRun) db.prepare("UPDATE auto_projects SET workspace_id = ?, worker_tab_id = ?, worker_pane_id = ?, worker_instance = ?, worker_status = 'idle', updated_at = ? WHERE project_key = ?")
		.run(launched.workspace_id, launched.tab_id, launched.pane_id, launched.instance, now(), info.key);
	return { project: info.name, worker_status: "idle", restored: !dryRun, ...launched };
}

function liveWorker(snapshot, instance) {
	return Boolean(instance && snapshot?.agents?.some((agent) => agent.agent === "pi" && agent.name === instance && !["done", "offline", "unknown"].includes(agent.agent_status)));
}

function superviseAutoImprover(db, { dryRun = false } = {}) {
	const rows = db.prepare("SELECT * FROM auto_projects WHERE worker_status NOT IN ('paused','stopped') ORDER BY updated_at DESC").all();
	const snapshot = herdrSnapshot();
	const restored = [];
	for (const row of rows) {
		const laterCompletion = db.prepare("SELECT completed_at FROM auto_audits WHERE project_key = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1").get(row.project_key);
		if (!dryRun && laterCompletion?.completed_at) db.prepare("UPDATE auto_audits SET status = 'superseded', completed_at = COALESCE(completed_at, ?) WHERE project_key = ? AND status IN ('awaiting_agent','running') AND started_at < ?")
			.run(laterCompletion.completed_at, row.project_key, laterCompletion.completed_at);
		if (row.worker_status !== "idle" || liveWorker(snapshot, row.worker_instance)) continue;
		try { restored.push(doRestoreIdleWorker(db, infoFromRow(row), row, { dryRun })); }
		catch (error) { restored.push({ project: row.name, restored: false, error: error instanceof Error ? error.message : String(error) }); }
	}
	return { projects: rows.length, scheduler: rows.length ? startDaemon() : { running: false, skipped: true, reason: "no_enabled_projects" }, restored, db_path: dbPath() };
}

// --- REST API (`yano auto-improve serve`) ---

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

	if (method === "GET" && parts.length === 0) return sendJson(res, 200, { ok: true, service: "yano-auto-improver", endpoints: ENDPOINTS });
	if (method === "GET" && parts[0] === "health") return sendJson(res, 200, { ok: true });

	if (parts[0] === "projects") {
		if (method === "GET" && parts.length === 1) {
			const rows = db.prepare("SELECT * FROM auto_projects ORDER BY created_at DESC").all();
			return sendJson(res, 200, { projects: rows });
		}
		if (method === "POST" && parts.length === 1) {
			const body = await readJsonBody(req);
			if (!body.project_root) return sendJson(res, 400, { error: "project_root è obbligatorio" });
			const info = projectInfo(body.project_root, body.project || null);
			const result = doInit(db, info, { intervalMs: body.interval_ms, notify: body.notify });
			return sendJson(res, 201, result);
		}
		const key = parts[1];
		if (!key) return sendJson(res, 404, { error: "not found" });
		const row = db.prepare("SELECT * FROM auto_projects WHERE project_key = ?").get(key);
		if (!row) return sendJson(res, 404, { error: `progetto non trovato: ${key}` });
		const info = infoFromRow(row);

		if (method === "GET" && parts.length === 2) return sendJson(res, 200, row);

		if (parts[2] === "audits" && method === "GET" && parts.length === 3) return sendJson(res, 200, doStatus(db, row));
		if (parts[2] === "reports" && method === "GET" && parts.length === 3) return sendJson(res, 200, { project: row, reports: doReports(db, row) });
		if (parts[2] === "run" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req).catch(() => ({}));
			const result = await doRunOrStart(db, info, row, { dryRun: Boolean(body.dry_run), force: Boolean(body.force), once: Boolean(body.once) });
			return sendJson(res, 200, result);
		}
		if (parts[2] === "pause" && method === "POST" && parts.length === 3) return sendJson(res, 200, doPauseOrStop(db, info, row, "pause"));
		if (parts[2] === "stop" && method === "POST" && parts.length === 3) return sendJson(res, 200, doPauseOrStop(db, info, row, "stop"));
		if (parts[2] === "resume" && method === "POST" && parts.length === 3) {
			const body = await readJsonBody(req).catch(() => ({}));
			const result = await doResume(db, info, row, { dryRun: Boolean(body.dry_run) });
			return sendJson(res, 200, result);
		}
		return sendJson(res, 404, { error: "not found" });
	}

	if (parts[0] === "audits" && parts[1] && parts[2] === "complete" && method === "POST") {
		const body = await readJsonBody(req);
		const result = await completeAudit(db, { auditId: parts[1], reportFile: body.report_file, summaryFile: body.summary_file, summary: body.summary });
		return sendJson(res, 200, result);
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
	const port = opts.port || Number(process.env.YANO_AUTO_IMPROVER_API_PORT) || API_DEFAULT_PORT;
	const host = opts.host || "127.0.0.1";
	const token = process.env.YANO_AUTO_IMPROVER_API_TOKEN || null;
	const server = http.createServer((req, res) => { handleApiRequest(db, req, res, token); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
	const info = { ok: true, host, port, token_required: Boolean(token), db_path: dbPath(), endpoints: ENDPOINTS };
	print(info, opts.json);
	if (!opts.json) console.log(`yano auto-improve: API in ascolto su http://${host}:${port} — Ctrl+C per fermarla${token ? " (Authorization: Bearer <token> richiesto)" : " (nessun token configurato — YANO_AUTO_IMPROVER_API_TOKEN per proteggerla)"}`);
	await new Promise((resolve) => {
		let closing = false;
		const shutdown = () => { if (closing) return; closing = true; server.close(() => resolve()); };
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}

export async function runYanoAutoImprove({ argv = [] } = {}) {
	const opts = parseOptions(argv);
	if (!opts.sub || opts.sub === "--help" || opts.sub === "-h") { console.log(usage()); return; }
	if (opts.sub === "daemon") { await daemonLoop(); return; }
	const db = openDatabase();
	try {
		if (opts.sub === "supervise") {
			const result = superviseAutoImprover(db, { dryRun: opts.dryRun });
			print(result, opts.json);
			return result;
		}
		if (opts.sub === "serve") {
			await runServe(db, { port: opts.port, host: opts.host, json: opts.json });
			return;
		}
		if (opts.sub === "complete") return await completeAudit(db, opts).then((result) => { print(result, opts.json); return result; });
		const info = projectInfo(opts.projectRoot, opts.project);
		if (opts.sub === "init") { const result = doInit(db, info, { intervalMs: opts.intervalMs, notify: opts.notify }); print(result, opts.json); return result; }
		const row = ensureProject(db, info, { intervalMs: opts.intervalMs, notify: opts.notify });
		if (opts.sub === "status") { const result = doStatus(db, row); print(result, opts.json); return result; }
		if (opts.sub === "reports") { const reports = doReports(db, row); print(reports, opts.json); return reports; }
		if (opts.sub === "pause" || opts.sub === "stop") { const result = doPauseOrStop(db, info, row, opts.sub); print(result, opts.json); return result; }
		if (opts.sub === "resume") { const result = await doResume(db, info, row, { dryRun: opts.dryRun }); print(result, opts.json); return result; }
		if (opts.sub === "run" || opts.sub === "start") {
			const output = await doRunOrStart(db, info, row, { dryRun: opts.dryRun, force: opts.force, once: opts.once, noDaemon: opts.noDaemon, isStart: opts.sub === "start" });
			print(output, opts.json);
			return output;
		}
		throw new Error(`yano auto-improve: comando sconosciuto "${opts.sub}".\n${usage()}`);
	} finally { try { db.close(); } catch { /* ignore */ } }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) runYanoAutoImprove({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano auto-improve: ${error.message}`); process.exit(1); });
