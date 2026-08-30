#!/usr/bin/env node

// Classifies high-confidence orchestration failures and turns them into
// durable, deduplicated tickets for a future yano-debugger.  This module is
// deliberately independent from the project ticket database: a Yano defect
// belongs to the Yano repository, not to the application being watched.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRawTraceRecord } from "./yano-trace-storage.mjs";
import { resolveYanoConfig } from "./yano-config.mjs";
import { notifyBugReported, openDatabase, reportBug } from "./yano-debugger.mjs";

const SECRET_KEY = /token|password|secret|authorization|api[-_]?key|private[-_]?key|cookie/i;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_TOOLS = new Set([
	"agent_send", "agent_list", "ticket_claim", "ticket_complete", "ticket_update",
	"worktree_finalize", "worktree_abandon", "run_status", "run_watchdog_check",
	"plan_advance", "plan_finalize", "workspace_finalize", "response_wakeup",
]);

function safeJson(value, depth = 0) {
	if (depth > 4) return "[truncated]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > 2400 ? `${value.slice(0, 2400)}…` : value;
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeJson(item, depth + 1));
	return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : safeJson(item, depth + 1)]));
}

export function loadEnvFile(rootDir) {
	const result = {};
	if (!rootDir) return result;
	const file = path.join(rootDir, ".env");
	try {
		for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (!match) continue;
			let value = match[2].trim();
			if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
			result[match[1]] = value;
		}
	} catch { /* the caller reports missing configuration */ }
	return result;
}

export function resolveYanoRepository({ packageRoot = PACKAGE_ROOT } = {}) {
	// This setting is intentionally sourced only from the .env belonging to the
	// Yano checkout/package in use. Do not fall back to the watched project's
	// env, process.env, a CLI flag or the current working directory: that could
	// send maintenance tickets to the wrong repository.
	const configured = resolveYanoConfig({ packageRoot }).YANO_ORCHESTRATOR_REPO;
	if (!configured) return null;
	const candidate = path.resolve(packageRoot, configured);
	return fs.existsSync(candidate) ? candidate : null;
}

function isYanoInternalRecord(record) {
	const tool = String(record.tool || record.tool_name || record.operation || "").toLowerCase();
	return record.source === "yano" || record.component === "yano" || INTERNAL_TOOLS.has(tool);
}

function textOf(record) {
	return [record.type, record.reason, record.error, record.message, record.detail, record.expected, record.actual].filter(Boolean).join(" ");
}

function failure({ category, signal, severity, summary, record, evidence }) {
	const detail = {
		category, signal, severity, summary,
		project: record.project || evidence.project || null,
		project_key: record.project_key || evidence.project_key || null,
		run_id: record.run_id || evidence.run_id || null,
		instance: record.instance || record.assigned_instance || null,
		round: record.round ?? null,
		task: record.task_slug || record.task || record.ticket_id || null,
		type: record.type || null,
		tool: record.tool || record.tool_name || record.operation || null,
		expected: record.expected || null,
		actual: record.actual || null,
		record_id: record.id || null,
		record_ts: record.ts || null,
		payload: safeJson(record),
	};
	const fingerprintInput = [category, signal, detail.type, detail.tool, detail.expected, detail.actual, summary].map((item) => String(item || "")).join("|");
	detail.fingerprint = crypto.createHash("sha256").update(fingerprintInput).digest("hex");
	return detail;
}

/**
 * Return only high-confidence Yano defects. Generic npm/git/test failures are
 * intentionally excluded: they belong to the watched application.
 */
export function detectYanoFindings(records, context = {}) {
	const findings = [];
	const seen = new Set();
	const addFinding = (candidate) => {
		// A polling watcher reads a lookback window, so the same source event can
		// be present in every pass. Keep one finding per deterministic fingerprint
		// before ticket creation/routing; otherwise a single old error would cause
		// one Planner message every ten minutes forever.
		if (!candidate?.fingerprint || seen.has(candidate.fingerprint)) return;
		seen.add(candidate.fingerprint);
		findings.push(candidate);
	};
	for (const record of records || []) {
		const type = String(record.type || "");
		const text = textOf(record);
		if (type === "agent_send_no_live_target") {
			addFinding(failure({ category: "delegation", signal: "no_live_target", severity: "high", summary: "Yano ha tentato di inviare un lavoro ma non ha trovato un destinatario vivo.", record, evidence: context }));
			continue;
		}
		if ((type === "notification_dispatch" || type === "whatsapp_notify") && record.reason === "agent_send_timeout") {
			addFinding(failure({ category: "delegation", signal: "delegation_timeout", severity: "high", summary: "Yano ha esaurito il timeout durante la delega a un agente.", record, evidence: context }));
			continue;
		}
		if ((type.includes("scope_mismatch") || type.includes("workspace_scope_mismatch") || type.includes("agent_presence_mismatch")) || record.scope_mismatch === true) {
			addFinding(failure({ category: "isolation", signal: "workspace_scope_mismatch", severity: "critical", summary: "Yano ha osservato una discordanza tra progetto, workspace o presenza degli agenti.", record, evidence: context }));
			continue;
		}
		if ((type.includes("orphan") || type === "agent_missing_after_restore") && (record.source === "yano" || record.component === "yano" || record.expected || record.actual)) {
			addFinding(failure({ category: "lifecycle", signal: "orphaned_agent", severity: "high", summary: "Yano ha rilevato un agente orfano o non ripristinato dal proprio lifecycle.", record, evidence: context }));
			continue;
		}
		if (type === "trace_preflight" && (record.ok === false || record.expected !== record.actual || record.runtime_mismatch === true)) {
			addFinding(failure({ category: "runtime", signal: "trace_preflight_mismatch", severity: "medium", summary: "La preflight di Yano ha rilevato un disallineamento del runtime o della configurazione di tracing.", record, evidence: context }));
			continue;
		}
		if (type === "tool_execution_end" && record.ok === false && isYanoInternalRecord(record)) {
			addFinding(failure({ category: "internal_tool", signal: "tool_failure", severity: "high", summary: "Un tool interno di Yano è terminato con errore.", record, evidence: context }));
			continue;
		}
		if (record.record_type === "feedback" && ["rejected", "partial"].includes(record.status) && /yano|planner|deleg|agent|round|workflow|flusso|watchdog|herdr|skill|tool|mcp/i.test(text)) {
			addFinding(failure({ category: "orchestration", signal: "user_reported_orchestration_gap", severity: "medium", summary: "L’utente ha respinto o giudicato parziale un round indicando un possibile problema di orchestrazione.", record, evidence: context }));
		}
	}
	return findings;
}

function slug(value) {
	return String(value || "yano-fault").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "yano-fault";
}

function parseFrontmatter(content) {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	return Object.fromEntries(match[1].split("\n").map((line) => line.match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map(([, key, value]) => [key.trim(), value.trim()]));
}

function ticketBody(finding, sourceProject, now) {
	const evidence = safeJson(finding.payload);
return `---
type: debugger
kind: task
created_by: yano-watcher
status: open
severity: ${finding.severity}
category: ${finding.category}
signal: ${finding.signal}
fingerprint: ${finding.fingerprint}
detected_at: ${now}
source_project: ${sourceProject.name}
source_project_root: ${sourceProject.root}
source_project_key: ${finding.project_key || "unknown"}
run_id: ${finding.run_id || "unknown"}
round: ${finding.round ?? "unknown"}
task: ${finding.task || "unknown"}
instance: ${finding.instance || "unknown"}
evidence_record_id: ${finding.record_id || "unknown"}
---

# ${finding.summary}

Type: debugger
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: ${finding.fingerprint}

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: \`${finding.signal}\`
- Categoria: \`${finding.category}\`
- Progetto osservato: \`${sourceProject.name}\` (${sourceProject.root})
- Timestamp del record: \`${finding.record_ts || "unknown"}\`
- Record di trace: \`${finding.record_id || "unknown"}\`

\`\`\`json
${JSON.stringify(evidence, null, 2)}
\`\`\`

## Impatto

Verificare se il problema ha lasciato il planner senza destinatario, ha perso l’isolamento del progetto, ha lasciato agenti/workspace in uno stato incoerente o ha impedito la prosecuzione del round.

## Cosa deve verificare l’LLM

1. Ricostruire il round usando il trace del progetto e gli eventi di Yano.
2. Individuare il punto del lifecycle in cui l’aspettativa e lo stato reale divergono.
3. Riprodurre il caso con un test deterministico senza inviare messaggi reali.
4. Correggere il codice e aggiungere una regressione che dimostri il fix.

## Criteri di chiusura

- La causa è identificata e documentata.
- Esiste un test di regressione.
- Il caso non produce più il segnale errato in un nuovo round.
- La notifica e la deduplicazione del watcher restano funzionanti.
`;
}

export function findExistingTicket(ticketsDir, fingerprint) {
	if (!fs.existsSync(ticketsDir)) return null;
	for (const file of fs.readdirSync(ticketsDir)) {
		if (!file.endsWith(".md")) continue;
		try {
			const full = path.join(ticketsDir, file);
			const metadata = parseFrontmatter(fs.readFileSync(full, "utf8"));
			if (metadata.fingerprint === fingerprint) return full;
		} catch { /* best effort; malformed tickets do not block new evidence */ }
	}
	return null;
}

export function createYanoWatcherTicket({ finding, yanoRepo, projectRoot, project, ticketsDir = null, now = new Date() }) {
	if (!yanoRepo) return { created: false, skipped: true, reason: "yano_repo_not_configured" };
	const sourceProject = { name: project || finding.project || path.basename(projectRoot || "project"), root: path.resolve(projectRoot || process.cwd()) };
	const targetDir = ticketsDir ? path.resolve(ticketsDir) : path.join(yanoRepo, ".scratch", "optimize-orchestrator", "issues");
	fs.mkdirSync(targetDir, { recursive: true });
	const existing = findExistingTicket(targetDir, finding.fingerprint);
	if (existing) return { created: false, path: existing, finding };
	const iso = now.toISOString();
	const numbers = fs.readdirSync(targetDir)
		.map((file) => file.match(/^(\d+)-.*\.md$/)?.[1])
		.filter(Boolean)
		.map(Number);
	let number = (numbers.length ? Math.max(...numbers) : 0) + 1;
	let filename = `${String(number).padStart(2, "0")}-yano-watcher-${slug(finding.signal)}.md`;
	while (fs.existsSync(path.join(targetDir, filename))) {
		number += 1;
		filename = `${String(number).padStart(2, "0")}-yano-watcher-${slug(finding.signal)}.md`;
	}
	const target = path.join(targetDir, filename);
	fs.writeFileSync(target, ticketBody(finding, sourceProject, iso), { mode: 0o600, flag: "wx" });
	return { created: true, path: target, finding };
}

export async function sendTelegramWatcherNotification({ yanoRepo, message, env = process.env, apiBaseUrl = null }) {
	const fileEnv = loadEnvFile(yanoRepo);
	// Runtime/global configuration wins. The maintenance checkout .env remains
	// a development fallback for callers using this module directly.
	const token = env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_DESTINATION_CHAT_ID || fileEnv.TELEGRAM_DESTINATION_CHAT_ID;
	if (!token || !chatId) return { ok: false, detail: "telegram_env_missing", missing: [!token && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_DESTINATION_CHAT_ID"].filter(Boolean) };
	if (String(env.YANO_WATCHER_NOTIFY_DRY_RUN || "") === "1") return { ok: true, detail: "dry-run", chat_id: chatId };
	const base = (apiBaseUrl || env.YANO_TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, "");
	try {
		const response = await fetch(`${base}/bot${encodeURIComponent(token)}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
		});
		let payload = null;
		try { payload = await response.json(); } catch { /* handled below */ }
		if (!response.ok || payload?.ok === false) return { ok: false, detail: `telegram_http_${response.status}`, status: response.status };
		return { ok: true, detail: "sent", status: response.status };
	} catch (error) {
		return { ok: false, detail: "telegram_network_error", error: error instanceof Error ? error.message : String(error) };
	}
}

// Additive, non-blocking bridge into the yano-debugger registry: the
// markdown ticket in .scratch/optimize-orchestrator/issues/ remains the
// primary, actively-used mechanism (89+ tickets, planner works through it
// directly) and is never touched or replaced by this. Routing the SAME
// finding into the debugger registry (mode: "yano-maintenance", scoped to
// the yano-orchestrator repo itself) gives it the same lifecycle tracking,
// dedup and auto-wake (notifyBugReported) that every other bug source
// already gets — so a Yano-on-Yano defect is not a second-class citizen
// just because it was found by the watcher instead of qa/a human/the CLI.
// Failures here (no DB, sqlite unavailable, mode guard, etc.) must never
// block or roll back the markdown ticket that was already written.
async function routeYanoWatcherFindingToDebugger(finding, { yanoRepo, sourceProject, ticketPath }) {
	if (!yanoRepo) return { routed: false, reason: "yano_repo_not_configured" };
	let db = null;
	try {
		db = openDatabase();
		const description = [
			`Rilevato dal watcher automatico di Yano (loop di sola lettura, zero token) mentre osservava il progetto "${sourceProject.name}" (${sourceProject.root}).`,
			"",
			`Segnale: ${finding.signal}`,
			`Categoria: ${finding.category}`,
			`Severità: ${finding.severity}`,
			"",
			`Ticket markdown gemello (tracciamento storico in .scratch/optimize-orchestrator/issues/): ${ticketPath || "n/d"}`,
			"",
			"Aperto automaticamente in modalità yano-maintenance perché il watcher ha classificato l'evento come un difetto di Yano stesso, non del progetto osservato.",
		].join("\n");
		const result = reportBug(db, {
			projectRoot: yanoRepo,
			project: null,
			mode: "yano-maintenance",
			title: finding.summary,
			description,
			severity: finding.severity,
			source: "watcher",
			reporter: "yano-watcher",
			expected: finding.expected || "",
			actual: finding.actual || finding.summary,
			steps: [`Vedi il ticket markdown gemello: ${ticketPath || "n/d"}`, `Progetto osservato: ${sourceProject.name} (${sourceProject.root})`],
			environment: {
				source_project: sourceProject.name,
				source_project_root: sourceProject.root,
				markdown_ticket_path: ticketPath || null,
				fingerprint: finding.fingerprint,
				record_id: finding.record_id || null,
				run_id: finding.run_id || null,
				instance: finding.instance || null,
			},
			actor: "yano-watcher",
		});
		await notifyBugReported(db, result);
		return { routed: true, bug_id: result.bug.bug_id, duplicate: result.duplicate };
	} catch (error) {
		return { routed: false, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		try { db?.close(); } catch { /* ignore */ }
	}
}

function notificationText(result, sourceProject) {
	const f = result.finding;
	return `🚨 Yano watcher: rilevata una possibile falla di Yano\nProgetto: ${sourceProject.name}\nSeverità: ${f.severity}\nCategoria: ${f.category}\nSegnale: ${f.signal}\n${f.summary}\nTicket: ${result.path}\nIl ticket è stato scritto nel repository yano-orchestrator per l’analisi di un LLM.`;
}

export async function processYanoWatcherFindings({ records, projectRoot, project, yanoRepo, ticketsDir = null, traceContext = null, notify = true, env = process.env } = {}) {
	const findings = detectYanoFindings(records, { project, project_key: traceContext?.project_key });
	const sourceProject = { name: project || path.basename(path.resolve(projectRoot || process.cwd())), root: path.resolve(projectRoot || process.cwd()) };
	const results = [];
	for (const finding of findings) {
		const result = createYanoWatcherTicket({ finding, yanoRepo, projectRoot: sourceProject.root, project: sourceProject.name, ticketsDir });
		let telegram = { ok: false, detail: notify ? "not_sent" : "planner_route" };
		if (!result.skipped && result.created && notify) telegram = await sendTelegramWatcherNotification({ yanoRepo, message: notificationText(result, sourceProject), env });
		let debuggerRouting = { routed: false, reason: "not_a_new_ticket" };
		if (!result.skipped && result.created) debuggerRouting = await routeYanoWatcherFindingToDebugger(finding, { yanoRepo, sourceProject, ticketPath: result.path });
		try {
			if (traceContext?.cwd) appendRawTraceRecord({ cwd: traceContext.cwd, project: sourceProject.name, record: {
				type: "yano_watcher_finding", record_type: "event", instance: "yano-watcher", fingerprint: finding.fingerprint,
				signal: finding.signal, category: finding.category, severity: finding.severity, ticket_path: result.path || null,
				ticket_created: result.created === true, telegram: { ok: telegram.ok, detail: telegram.detail },
				debugger_routing: debuggerRouting, source_record_id: finding.record_id || null,
			} });
		} catch { /* ticketing must never stop the watcher */ }
		results.push({ ...result, telegram, debuggerRouting });
	}
	return { findings, results, created: results.filter((item) => item.created).length, notified: results.filter((item) => item.telegram?.ok).length };
}
