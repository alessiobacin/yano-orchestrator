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

export function resolveYanoRepository({ packageRoot = PACKAGE_ROOT, explicit = null } = {}) {
	const configured = explicit || process.env.YANO_ORCHESTRATOR_REPO;
	if (configured && fs.existsSync(path.resolve(configured))) return path.resolve(configured);
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		if (pkg.name === "yano-orchestrator" && fs.existsSync(path.join(packageRoot, ".git"))) return path.resolve(packageRoot);
	} catch { /* fall through */ }
	return null;
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
	for (const record of records || []) {
		const type = String(record.type || "");
		const text = textOf(record);
		if (type === "agent_send_no_live_target") {
			findings.push(failure({ category: "delegation", signal: "no_live_target", severity: "high", summary: "Yano ha tentato di inviare un lavoro ma non ha trovato un destinatario vivo.", record, evidence: context }));
			continue;
		}
		if ((type === "notification_dispatch" || type === "whatsapp_notify") && record.reason === "agent_send_timeout") {
			findings.push(failure({ category: "delegation", signal: "delegation_timeout", severity: "high", summary: "Yano ha esaurito il timeout durante la delega a un agente.", record, evidence: context }));
			continue;
		}
		if ((type.includes("scope_mismatch") || type.includes("workspace_scope_mismatch") || type.includes("agent_presence_mismatch")) || record.scope_mismatch === true) {
			findings.push(failure({ category: "isolation", signal: "workspace_scope_mismatch", severity: "critical", summary: "Yano ha osservato una discordanza tra progetto, workspace o presenza degli agenti.", record, evidence: context }));
			continue;
		}
		if ((type.includes("orphan") || type === "agent_missing_after_restore") && (record.source === "yano" || record.component === "yano" || record.expected || record.actual)) {
			findings.push(failure({ category: "lifecycle", signal: "orphaned_agent", severity: "high", summary: "Yano ha rilevato un agente orfano o non ripristinato dal proprio lifecycle.", record, evidence: context }));
			continue;
		}
		if (type === "trace_preflight" && (record.ok === false || record.expected !== record.actual || record.runtime_mismatch === true)) {
			findings.push(failure({ category: "runtime", signal: "trace_preflight_mismatch", severity: "medium", summary: "La preflight di Yano ha rilevato un disallineamento del runtime o della configurazione di tracing.", record, evidence: context }));
			continue;
		}
		if (type === "tool_execution_end" && record.ok === false && isYanoInternalRecord(record)) {
			findings.push(failure({ category: "internal_tool", signal: "tool_failure", severity: "high", summary: "Un tool interno di Yano è terminato con errore.", record, evidence: context }));
			continue;
		}
		if (record.record_type === "feedback" && ["rejected", "partial"].includes(record.status) && /yano|planner|deleg|agent|round|workflow|flusso|watchdog|herdr|skill|tool|mcp/i.test(text)) {
			findings.push(failure({ category: "orchestration", signal: "user_reported_orchestration_gap", severity: "medium", summary: "L’utente ha respinto o giudicato parziale un round indicando un possibile problema di orchestrazione.", record, evidence: context }));
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
type: yano-watcher-ticket
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

Type: task
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
	// The maintenance checkout is authoritative. Process env is only a
	// fallback for installations that deliberately keep secrets out of .env.
	const token = fileEnv.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
	const chatId = fileEnv.TELEGRAM_DESTINATION_CHAT_ID || env.TELEGRAM_DESTINATION_CHAT_ID;
	if (!token || !chatId) return { ok: false, detail: "telegram_env_missing" };
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
		let telegram = { ok: false, detail: "duplicate_ticket" };
		if (!result.skipped && result.created && notify) telegram = await sendTelegramWatcherNotification({ yanoRepo, message: notificationText(result, sourceProject), env });
		try {
			if (traceContext?.cwd) appendRawTraceRecord({ cwd: traceContext.cwd, project: sourceProject.name, record: {
				type: "yano_watcher_finding", record_type: "event", instance: "yano-watcher", fingerprint: finding.fingerprint,
				signal: finding.signal, category: finding.category, severity: finding.severity, ticket_path: result.path || null,
				ticket_created: result.created === true, telegram: { ok: telegram.ok, detail: telegram.detail }, source_record_id: finding.record_id || null,
			} });
		} catch { /* ticketing must never stop the watcher */ }
		results.push({ ...result, telegram });
	}
	return { findings, results, created: results.filter((item) => item.created).length, notified: results.filter((item) => item.telegram?.ok).length };
}
