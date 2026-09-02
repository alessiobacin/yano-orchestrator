#!/usr/bin/env node
// Persistent, user-scoped scheduler for recurring Yano work. Cron only wakes
// this small dispatcher; it never embeds an untracked free-form shell command.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalDataPath } from "./yano-config.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRON_MARKER = "# yano-scheduler-supervisor";
// The workspace remains `yano-scheduler`; the runtime instance uses a neutral
// name because Herdr classifies names beginning with `yano-` as legacy kinds.
const SCHEDULER_INSTANCE = "scheduler-service";
const SCHEDULER_WORKSPACE_LABEL = "yano-scheduler";
// Keep the workspace name canonical, but avoid the legacy `yano-scheduler`
// tab title: Herdr can infer a non-Pi kind from that title during agent start.
const SCHEDULER_TAB_LABEL = "scheduler-service";
const SCHEDULER_AGENT_NAME = `${SCHEDULER_INSTANCE}-${path.basename(PACKAGE_ROOT).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`.slice(0, 32);
const DEFAULT_DB = { version: 1, jobs: [], supervisor: { instance: SCHEDULER_INSTANCE, workspace: null, tab_id: null, last_seen_at: null, last_recovered_at: null } };

function nowIso(now = new Date()) { return now.toISOString(); }
function schedulerPath(env = process.env) { return path.join(globalDataPath({ env }), "scheduler", "jobs.json"); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function fail(message) { throw new Error(`yano schedule: ${message}`); }

function readStore(env) {
	const file = schedulerPath(env);
	if (!existsSync(file)) return { file, store: structuredClone(DEFAULT_DB) };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return { file, store: { ...structuredClone(DEFAULT_DB), ...parsed, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [], supervisor: { ...DEFAULT_DB.supervisor, ...(parsed.supervisor || {}) } } };
	} catch { fail(`registro non leggibile: ${file}`); }
}
function writeStore(file, store) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, file);
}
function value(argv, flag) { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; }
function requireValue(argv, flag) { return value(argv, flag) || fail(`${flag} richiede un valore.`); }
function idPart(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "job"; }

const WEEKDAYS = { domenica: 0, lunedi: 1, "lunedì": 1, martedi: 2, "martedì": 2, mercoledi: 3, "mercoledì": 3, giovedi: 4, "giovedì": 4, venerdi: 5, "venerdì": 5, sabato: 6 };
function timeParts(valueToParse) {
	const match = String(valueToParse).match(/^(\d{1,2})(?::(\d{2}))?$/);
	if (!match) return null;
	const hour = Number(match[1]); const minute = Number(match[2] || 0);
	return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}
// Intentionally small natural-language grammar. It produces a normal cron
// expression that remains visible/editable through the CRUD API; unsupported
// wording fails rather than guessing a destructive schedule.
export function parseNaturalSchedule(text) {
	const normalized = String(text || "").trim();
	const daily = normalized.match(/^ogni\s+giorno\s+alle\s+(.+?)\s+(?:voglio\s+che\s+)?(?:esegui|fai(?:\s+partire)?|avvia|lancia)\s+(.+)$/i);
	if (daily) {
		const times = daily[1].replace(/\balle\s+/gi, "").split(/\s*(?:,|e)\s*/i).map(timeParts);
		if (!times.length || times.some((item) => !item)) return null;
		const minutes = [...new Set(times.map((item) => item.minute))];
		if (minutes.length !== 1) return null; // cron needs one job per minute set
		return { cron: `${minutes[0]} ${[...new Set(times.map((item) => item.hour))].sort((a, b) => a - b).join(",")} * * *`, task: daily[2].trim() };
	}
	const weekly = normalized.match(/^ogni\s+settimana\s+(?:di\s+)?([^\s]+)\s+alle\s+(\d{1,2}(?::\d{2})?)\s+(?:voglio\s+che\s+)?(?:esegui|fai(?:\s+partire)?|avvia|lancia)\s+(.+)$/i);
	if (weekly) {
		const day = WEEKDAYS[weekly[1].toLowerCase()]; const time = timeParts(weekly[2]);
		if (day === undefined || !time) return null;
		return { cron: `${time.minute} ${time.hour} * * ${day}`, task: weekly[3].trim() };
	}
	return null;
}

// Small, deliberately constrained crontab grammar. It covers ordinary daily,
// weekly and monthly schedules without accepting executable syntax.
function matchesField(expression, actual, min, max) {
	for (const part of String(expression).split(",")) {
		const [base, stepRaw] = part.split("/");
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isInteger(step) || step < 1) return false;
		let start = min; let end = max;
		if (base !== "*") {
			const range = base.match(/^(\d+)(?:-(\d+))?$/);
			if (!range) return false;
			start = Number(range[1]); end = range[2] ? Number(range[2]) : start;
			if (start < min || end > max || end < start) return false;
		}
		if (actual >= start && actual <= end && (actual - start) % step === 0) return true;
	}
	return false;
}
export function validCron(expression) {
	const fields = String(expression || "").trim().split(/\s+/);
	if (fields.length !== 5) return false;
	return [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]].every(([min, max], index) => String(fields[index]).split(",").every((part) => {
		const [base, stepRaw] = part.split("/");
		if (stepRaw !== undefined && (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1)) return false;
		if (base === "*") return true;
		const range = base.match(/^(\d+)(?:-(\d+))?$/);
		if (!range) return false;
		const start = Number(range[1]); const end = range[2] ? Number(range[2]) : start;
		return start >= min && end <= max && end >= start;
	}));
}
export function cronMatches(expression, now = new Date()) {
	const fields = String(expression || "").trim().split(/\s+/);
	return fields.length === 5 && matchesField(fields[0], now.getMinutes(), 0, 59)
		&& matchesField(fields[1], now.getHours(), 0, 23)
		&& matchesField(fields[2], now.getDate(), 1, 31)
		&& matchesField(fields[3], now.getMonth() + 1, 1, 12)
		&& matchesField(fields[4], now.getDay(), 0, 6);
}
function minuteSlot(now) { return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`; }

function readCrontab(spawn = spawnSync) {
	const result = spawn("crontab", ["-l"], { encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status === 0) return result.stdout || "";
	if (/no crontab for|can't open crontab/i.test(`${result.stdout || ""}\n${result.stderr || ""}`)) return "";
	fail(`impossibile leggere il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}
function cronCommand() { return `${shellQuote(process.execPath)} ${shellQuote(path.join(PACKAGE_ROOT, "bin", "yano.mjs"))} cron --supervise --json >/dev/null 2>&1 ${CRON_MARKER}`; }
export function schedulerCronInstall({ spawn = spawnSync } = {}) {
	const line = `* * * * * ${cronCommand()}`;
	const old = readCrontab(spawn).split("\n").filter((entry) => !entry.includes(CRON_MARKER)).filter(Boolean);
	const result = spawn("crontab", ["-"], { input: `${[...old, line].join("\n")}\n`, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) fail(`impossibile installare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: true, schedule: "* * * * *", marker: CRON_MARKER };
}
export function schedulerCronStatus({ spawn = spawnSync } = {}) {
	const line = readCrontab(spawn).split("\n").find((entry) => entry.includes(CRON_MARKER)) || null;
	return { installed: Boolean(line), line, schedule: line?.trim().split(/\s+/).slice(0, 5).join(" ") || null };
}
export function schedulerCronRemove({ spawn = spawnSync } = {}) {
	const old = readCrontab(spawn);
	const content = old.split("\n").filter((entry) => !entry.includes(CRON_MARKER)).filter(Boolean).join("\n");
	if (content === old.trim()) return { removed: false };
	const result = spawn("crontab", ["-"], { input: content ? `${content}\n` : "", encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) fail(`impossibile aggiornare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { removed: true };
}

function dispatch(job, now, spawn = spawnSync) {
	const instance = `scheduled-${idPart(job.id)}-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 12)}`;
	const prompt = `Task schedulato "${job.name}": ${job.task}\n\nOrigine: job Yano ${job.id}. Verifica lo stato reale del progetto e segui tutti i gate del playbook applicabile; non bypassare mai conferme utente per azioni distruttive.`;
	const args = [path.join(PACKAGE_ROOT, "bin", "yano.mjs"), "start", "--herdr", "--instance", instance, "--role", "planner", prompt];
	const result = spawn(process.execPath, args, { cwd: job.project_root, encoding: "utf8", maxBuffer: 1_000_000, env: process.env });
	return { instance, status: result.status ?? 1, stderr: String(result.stderr || "").trim(), stdout: String(result.stdout || "").trim() };
}
function herdrSnapshot(spawn = spawnSync) {
	const result = spawn("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}
function ensureSchedulerWorkspace(spawn = spawnSync) {
	let snapshot = herdrSnapshot(spawn);
	if (!snapshot) fail("Herdr non raggiungibile: impossibile supervisionare yano-scheduler.");
	const label = SCHEDULER_WORKSPACE_LABEL;
	let workspace = snapshot.workspaces?.find((item) => item.label === label);
	if (!workspace) {
		const created = spawn("herdr", ["workspace", "create", "--cwd", PACKAGE_ROOT, "--label", label, "--focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (created.status !== 0) fail(`Herdr non ha creato il workspace scheduler${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		snapshot = herdrSnapshot(spawn); workspace = snapshot?.workspaces?.find((item) => item.label === label);
	}
	if (!workspace?.workspace_id) fail("Herdr non ha restituito il workspace di yano-scheduler.");
	// Never reuse a generic root pane: it may already contain an unrelated or stale
	// agent. The scheduler owns one explicitly labelled tab in its own workspace.
	let tab = snapshot?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === SCHEDULER_TAB_LABEL);
	let pane = tab ? snapshot?.panes?.find((item) => item.tab_id === tab.tab_id) : null;
	const occupant = pane ? snapshot?.agents?.find((agent) => agent.pane_id === pane.pane_id) : null;
	if (tab && occupant) {
		// The owned tab contains a stale/foreign agent. Do not start another agent in
		// the same pane: replace the dedicated scheduler tab instead.
		const closed = spawn("herdr", ["tab", "close", tab.tab_id], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (closed.status !== 0) fail(`Herdr non ha chiuso la tab scheduler non valida${closed.stderr ? `: ${closed.stderr.trim()}` : ""}`);
		tab = null;
		pane = null;
		// Closing the only tab also removes its workspace in Herdr. Refresh state
		// before creating the replacement tab, otherwise its old workspace id fails.
		snapshot = herdrSnapshot(spawn);
		workspace = snapshot?.workspaces?.find((item) => item.label === label);
		if (!workspace) {
			const recreated = spawn("herdr", ["workspace", "create", "--cwd", PACKAGE_ROOT, "--label", label, "--focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
			if (recreated.status !== 0) fail(`Herdr non ha ricreato il workspace scheduler${recreated.stderr ? `: ${recreated.stderr.trim()}` : ""}`);
			snapshot = herdrSnapshot(spawn);
			workspace = snapshot?.workspaces?.find((item) => item.label === label);
		}
		if (!workspace?.workspace_id) fail("Herdr non ha restituito il workspace ricreato di yano-scheduler.");
	}
	if (!tab || !pane?.pane_id) {
		const created = spawn("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", PACKAGE_ROOT, "--label", SCHEDULER_TAB_LABEL, "--no-focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (created.status !== 0) fail(`Herdr non ha creato la tab yano-scheduler${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		try {
			const result = JSON.parse(created.stdout || "");
			tab = result?.root_pane?.tab_id ? { tab_id: result.root_pane.tab_id } : tab;
			pane = result?.root_pane?.pane_id ? result.root_pane : pane;
		} catch { /* Read the authoritative snapshot below. */ }
		if (!pane?.pane_id) {
			snapshot = herdrSnapshot(spawn);
			tab = snapshot?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === SCHEDULER_TAB_LABEL);
			pane = tab ? snapshot?.panes?.find((item) => item.tab_id === tab.tab_id) : null;
		}
	}
	if (!pane?.pane_id) fail("Herdr non ha restituito il pane della tab yano-scheduler.");
	snapshot = herdrSnapshot(spawn) || snapshot;
	const initial = snapshot?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.tab_id !== tab.tab_id && /^(1|\d+)$/.test(item.label || ""));
	if (initial) spawn("herdr", ["tab", "close", initial.tab_id], { encoding: "utf8", maxBuffer: 1_000_000 });
	return { workspace, tab, pane };
}
function superviseAgent(store, now, spawn = spawnSync) {
	const snapshot = herdrSnapshot(spawn);
	// Pi's orchestrator extension exposes the instance (`yano-scheduler`) as the
	// detected agent name, rather than retaining Herdr's requested display name.
	const isLivePi = (agent) => agent && !["done", "offline", "unknown"].includes(String(agent.agent_status || "").toLowerCase()) && (agent.agent === "pi" || agent.agent_session?.agent === "pi");
	const schedulerWorkspace = snapshot?.workspaces?.find((workspace) => workspace.label === SCHEDULER_WORKSPACE_LABEL);
	const schedulerTab = schedulerWorkspace && snapshot?.tabs?.find((tab) => tab.workspace_id === schedulerWorkspace.workspace_id && tab.label === SCHEDULER_TAB_LABEL);
	const schedulerPane = schedulerTab && snapshot?.panes?.find((pane) => pane.tab_id === schedulerTab.tab_id);
	const live = schedulerPane && snapshot?.agents?.find((agent) => agent.pane_id === schedulerPane.pane_id && isLivePi(agent));
	const liveWorkspace = live?.workspace_id ? snapshot?.workspaces?.find((workspace) => workspace.workspace_id === live.workspace_id) : null;
	if (live && liveWorkspace?.label === SCHEDULER_WORKSPACE_LABEL) {
		store.supervisor = { ...store.supervisor, instance: SCHEDULER_INSTANCE, workspace: SCHEDULER_WORKSPACE_LABEL, tab_id: live.tab_id || store.supervisor.tab_id || null, last_seen_at: nowIso(now) };
		return { running: true, recovered: false, instance: SCHEDULER_INSTANCE, workspace: store.supervisor.workspace, tab_id: store.supervisor.tab_id };
	}
	if (live?.tab_id) spawn("herdr", ["tab", "close", live.tab_id], { encoding: "utf8", maxBuffer: 1_000_000 });
	let target;
	try { target = ensureSchedulerWorkspace(spawn); } catch (error) { return { running: false, recovered: true, instance: SCHEDULER_INSTANCE, status: 1, error: error.message }; }
	const composed = spawn(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs"), "--instance", SCHEDULER_INSTANCE, "--role", "scheduler", "--json", "--print-only"], { cwd: PACKAGE_ROOT, encoding: "utf8", maxBuffer: 1_000_000, env: process.env });
	let args;
	try { args = JSON.parse(composed.stdout || "").args; } catch { return { running: false, recovered: true, instance: SCHEDULER_INSTANCE, status: 1, error: `impossibile comporre il comando Pi scheduler: ${(composed.stderr || composed.stdout || "risposta vuota").trim()}` }; }
	// Do not use `herdr agent start` here: Herdr infers the agent kind from the
	// tab label and can classify scheduler-service as a legacy non-Pi kind.
	// Starting Pi explicitly in the owned pane is the same reliable path used by
	// the global watcher/debugger services.
	const command = ["pi", ...args].map(shellQuote).join(" ");
	const result = spawn("herdr", ["pane", "run", target.pane.pane_id, `exec ${command}`], { cwd: PACKAGE_ROOT, encoding: "utf8", maxBuffer: 1_000_000, env: process.env });
	const after = herdrSnapshot(spawn);
	const started = after?.agents?.find((agent) => agent.pane_id === target.pane.pane_id && isLivePi(agent));
	const running = result.status === 0 || Boolean(started);
	store.supervisor = { ...store.supervisor, instance: SCHEDULER_INSTANCE, workspace: SCHEDULER_WORKSPACE_LABEL, tab_id: target.tab?.tab_id || null, last_recovered_at: nowIso(now), last_seen_at: running ? nowIso(now) : store.supervisor.last_seen_at };
	return { running, recovered: true, instance: SCHEDULER_INSTANCE, workspace: SCHEDULER_WORKSPACE_LABEL, tab_id: target.tab?.tab_id || null, status: running ? 0 : (result.status ?? 1), error: running ? null : (String(result.stderr || "").trim().slice(0, 500) || null) };
}
export function tick({ env = process.env, now = new Date(), spawn = spawnSync } = {}) {
	const { file, store } = readStore(env); const slot = minuteSlot(now); const results = [];
	for (const job of store.jobs) {
		if (!job.enabled || !cronMatches(job.cron, now) || job.last_run_slot === slot) continue;
		const run = dispatch(job, now, spawn);
		job.last_run_slot = slot; job.last_run_at = nowIso(now); job.last_status = run.status === 0 ? "dispatched" : "failed";
		job.last_result = { instance: run.instance, status: run.status, stderr: run.stderr.slice(0, 500) };
		results.push({ id: job.id, name: job.name, ...job.last_result, status: job.last_status });
	}
	writeStore(file, store); return { at: nowIso(now), dispatched: results };
}

export function superviseScheduler({ env = process.env, now = new Date(), spawn = spawnSync } = {}) {
	const { file, store } = readStore(env);
	const agent = superviseAgent(store, now, spawn);
	const jobs = tick({ env, now, spawn });
	// tick wrote its own current store; merge the supervisor metadata after it.
	const refreshed = readStore(env); refreshed.store.supervisor = store.supervisor; writeStore(refreshed.file, refreshed.store);
	return { checked_at: nowIso(now), agent, ...jobs };
}

function usage() { console.log("Uso: yano cron --add <richiesta naturale> [--project-root <dir>] | --list | --remove <id> | --enable <id> | --disable <id> | --run <id> | --supervise | --status\nOppure: yano schedule <add|list|remove|enable|disable|run|tick|supervise|cron> [opzioni]"); }
export async function runYanoScheduler({ argv, env = process.env, now = new Date(), spawn = spawnSync } = {}) {
	const [sub, ...rest] = argv; const json = rest.includes("--json");
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	let result;
	if (sub === "add" || sub === "add-natural") {
		const natural = sub === "add-natural" ? requireValue(rest, "--task") : null;
		const parsedNatural = natural ? parseNaturalSchedule(natural) : null;
		if (natural && !parsedNatural) fail("non riesco a interpretare la frequenza; usa ad esempio 'ogni giorno alle 14 e alle 21 esegui …' oppure 'ogni settimana di lunedì alle 13:00 fai …'.");
		const cron = parsedNatural?.cron || requireValue(rest, "--cron"); if (!validCron(cron)) fail("--cron deve avere cinque campi cron validi (es. '0 14,21 * * *').");
		const projectRoot = path.resolve(value(rest, "--project-root") || process.cwd()); if (!existsSync(projectRoot)) fail(`project root inesistente: ${projectRoot}`);
		const task = parsedNatural?.task || requireValue(rest, "--task"); const { file, store } = readStore(env); const name = value(rest, "--name") || task.slice(0, 72);
		const job = { id: `job-${idPart(name)}-${Date.now().toString(36)}`, name, project_root: projectRoot, cron, task, enabled: true, created_at: nowIso(now), updated_at: nowIso(now), last_run_at: null, last_run_slot: null, last_status: null };
		store.jobs.push(job); writeStore(file, store); result = { created: job, cron: schedulerCronInstall({ spawn }) };
	} else if (sub === "list") result = readStore(env).store.jobs;
	else if (["remove", "enable", "disable", "run"].includes(sub)) {
		const { file, store } = readStore(env); const job = store.jobs.find((item) => item.id === requireValue(rest, "--id")); if (!job) fail("job non trovato.");
		if (sub === "remove") { store.jobs = store.jobs.filter((item) => item !== job); writeStore(file, store); result = { removed: job.id }; }
		else if (sub === "run") { const run = dispatch(job, now, spawn); job.last_run_at = nowIso(now); job.last_status = run.status === 0 ? "dispatched" : "failed"; job.last_result = run; writeStore(file, store); result = { id: job.id, ...job.last_result }; }
		else { job.enabled = sub === "enable"; job.updated_at = nowIso(now); writeStore(file, store); result = { id: job.id, enabled: job.enabled }; }
	} else if (sub === "tick") result = tick({ env, now, spawn });
	else if (sub === "supervise") result = superviseScheduler({ env, now, spawn });
	else if (sub === "cron") { const action = rest.find((item) => !item.startsWith("--")) || "status"; result = action === "install" ? schedulerCronInstall({ spawn }) : action === "remove" ? schedulerCronRemove({ spawn }) : action === "status" ? schedulerCronStatus({ spawn }) : fail("azione cron sconosciuta; usa install, status o remove."); }
	else { usage(); fail(`sottocomando sconosciuto: ${sub}`); }
	if (json) console.log(JSON.stringify(result, null, 2)); else console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runYanoScheduler({ argv: process.argv.slice(2) }).catch((error) => { console.error(error.message); process.exitCode = 1; });
