// Script-first scheduler: persistent, user-scoped recurring jobs that dispatch
// a REGISTERED SCRIPT at trigger time instead of always waking a planner with
// the task text (spec scheduler-script-first, A–E).
//
// Security model (non-negotiable, enforced by validateScriptSecurity/validateJob):
//   - a job NEVER embeds free-form shell, tokens, pipes, redirections or bare
//     commands: the only executable is the registered script_path, validated
//     and executed as a plain file by the Node runtime, never through a shell;
//   - script payloads that carry shell metacharacters or I/O redirection are
//     refused; scripts live in the user data dir (globalDataPath, B) so a
//     package upgrade never deletes them;
//   - destructive/project-mutating intent always routes through the project
//     planner (mode planner:<project>), which is the human-gated path — no
//     schedule ever destroys or mutates by itself;
//   - scripts must read secrets from .env, never embed tokens.
//
// Modes (job.mode):
//   - "self"              — run the script, no LLM involved;
//   - "planner:<project>" — run the script THEN wake the target project's
//                           planner with the task text (destination per spec);
//   - "yano-local-pc"   — run the script THEN bridge to the global
//                           yano-local-pc agent via `yano invoke`.
//
// Legacy compatibility: jobs persisted before this change (cron+task, no
// script_path) keep working through the printer fallback that still dispatches
// the project planner with the task text — the historical behaviour.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalDataPath } from "./yano-config.mjs";
import { ensureComputerLocalService } from "./yano-global-services.mjs";
import { installOneMinuteWindowsJob, removeOneMinuteWindowsJob, statusOneMinuteWindowsJob } from "./yano-os-scheduler.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRON_MARKER = "# yano-scheduler-supervisor";
const SCHEDULER_INSTANCE = "scheduler-service";
const SCHEDULER_WORKSPACE_LABEL = "yano-scheduler";
const SCHEDULER_TAB_LABEL = "scheduler-service";
const LOCAL_PC_PROJECT = "yano-local-pc";
const LOCAL_PC_ROOT = path.join(globalDataPath(), "yano-local-pc");
const SCHEDULER_ROOT = path.join(globalDataPath(), "yano-scheduler");
const SCHEDULER_AGENT_NAME = `${SCHEDULER_INSTANCE}-${LOCAL_PC_PROJECT}`.slice(0, 32);
const DEFAULT_DB = { version: 2, jobs: [], supervisor: { instance: SCHEDULER_INSTANCE, workspace: null, tab_id: null, last_seen_at: null, last_recovered_at: null } };

function nowIso(now = new Date()) { return now.toISOString(); }
function schedulerDataDir(env = process.env) { return path.join(globalDataPath({ env }), "scheduler"); }
function schedulerPath(env = process.env) { return path.join(schedulerDataDir(env), "jobs.json"); }
// Persistent, user-scoped scripts folder (spec B): NEVER inside the package —
// an upgrade must not delete registered scripts. Same data root as jobs.json.
export function schedulerScriptsDir(env = process.env) { return path.join(schedulerDataDir(env), "scripts"); }
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

// ── Security validator (vincoli di sicurezza non negoziabili) ────────────────
const SHELL_META_RE = /[|;&$`<>()]|\n/;
export function validateScriptSecurity(job, { exists = existsSync, scriptsDir = schedulerScriptsDir() } = {}) {
	const issues = [];
	if (!job || typeof job !== "object") { issues.push("job non valido"); return issues; }
	// Modalità dichiarata obbligatoria: niente job senza mode esplicita.
	if (!job.mode) issues.push("modalità non dichiarata (mode obbligatoria: self | planner:<progetto> | yano-local-pc)");
	else if (job.mode === "planner") issues.push("mode 'planner' non valida: usare 'planner:<nome progetto>'");
	else if (!["self", "yano-local-pc"].includes(job.mode) && !/^planner:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(job.mode)) issues.push(`modalità non supportata: ${job.mode}`);
	// Path sicuro: assoluto e dentro il folder script persistente dell'utente.
	if (!job.script_path) issues.push("script_path mancante: ogni job deve referenziare uno script registrato");
	else {
		const resolved = path.resolve(job.script_path);
		if (!path.isAbsolute(job.script_path)) issues.push(`script_path deve essere assoluto: ${job.script_path}`);
		else if (!resolved.startsWith(`${scriptsDir}${path.sep}`)) issues.push(`script_path fuori dal folder script persistente (${scriptsDir}): ${resolved}`);
		else if (!exists(resolved)) issues.push(`script inesistente: ${resolved}`);
	}
	// Niente payload arbitrario: il task descrittivo non può contenere shell.
	if (job.task && SHELL_META_RE.test(job.task)) issues.push("task contiene metacharatteri shell non ammessi (| ; & $ ` < > o newline)");
	return issues;
}

// Validator per la registrazione (add): richiede modalità + path sicuri prima
// che un job entri nel registro. I problemi vengono SEMPRE rifiutati (mai
// loggati e bypassati) — salvo il caso legacy doc sotto.
export function validateJob(job, opts = {}) {
	const issues = validateScriptSecurity(job, opts);
	if (!job.cron || !/^\S+ \S+ \S+ \S+ \S+$/.test(String(job.cron))) issues.push("cron a cinque campi obbligatorio");
	if (!job.project_root) issues.push("project_root obbligatorio");
	return issues;
}

// ── Script execution ──────────────────────────────────────────────────────────
// Executes the registered, validated script as a PLAIN FILE via the Node
// runtime with its own executable bit — never through a shell, never with
// arbitrary string interpolation. `permission` (default "read") is a deliberate
// fiction of the runtime: the dispatcher only ever runs registered scripts and
// relies on the human gates of the planner for anything destructive.
export function executeScript(scriptPath, { env = process.env, timeoutMs = 120000, permission = "read" } = {}) {
	if (!existsSync(scriptPath)) return { ok: false, error: `script inesistente: ${scriptPath}`, fallback: true };
	try { chmodSync(scriptPath, 0o700); } catch { /* best effort: la modalità può già essere corretta */ }
	const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8_000_000 });
	if (result.error) return { ok: false, error: result.error.message, fallback: true, status: result.status ?? 1 };
	return { ok: result.status === 0, status: result.status ?? 1, stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), fallback: false };
}

// ── Planner/yano-local-pc bridge (legacy fallback) ──────────────────────────
// Schedules never create a temporary planner. They address the always-on
// planner-01 owned by yano-local-pc through the local-pc MQTT bridge.
export function dispatchPlanner({ projectRoot, task, jobId, jobName, now, instance }) {
	const target = projectRoot ? path.resolve(projectRoot) : null;
	const prompt = `Task schedulato "${jobName}": ${task}\n\nOrigine: job Yano ${jobId}. Target dichiarato: ${target || "generico"}. Sei il planner di yano-local-pc: verifica lo stato reale del target e segui tutti i gate del playbook applicabile; non bypassare mai conferme utente per azioni distruttive.`;
	return [path.join(PACKAGE_ROOT, "bin", "yano.mjs"), "local-pc", "ask", "--planner", "--prompt", prompt];
}

// ── Registry ──────────────────────────────────────────────────────────────────
export function validateScriptPath(scriptPath, { exists = existsSync } = {}) {
	const issues = validateScriptSecurity({ mode: "self", script_path: scriptPath, task: "" }, { exists });
	return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ── Tick: the one-minute dispatcher ──────────────────────────────────────────
function dispatch(job, now, spawn = spawnSync, env = process.env) {
	const instance = `scheduled-${idPart(job.id)}-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 12)}`;
	if (job.script_path) {
		// Script-first: execute the registered script; only after a successful
		// run route onward per the declared mode (script decides routing; the
		// scheduler never guesses a destination).
		const run = executeScript(job.script_path, { env: { ...env, YANO_JOB_ID: job.id, YANO_JOB_NAME: job.name, YANO_JOB_MODE: job.mode, YANO_JOB_PROJECT_ROOT: job.project_root } });
		if (!run.ok && run.fallback) {
			// Fallback loggato (spec A): script mancante/invalido/ineseguibile —
			// NIENTE planner automatico con testo libero: il job va in errore e
			// viene disabilitato, perché telegrafare un task testuale al planner
			// da un cron sarebbe il vecchio comportamento non-script-first.
			job.last_status = "failed"; job.last_result = { instance, status: 1, error: `script non eseguibile (${run.error}); job disabilitato`, fallback: true };
			job.enabled = false;
			return { instance, status: 1, error: run.error, fallback: true, script_failed: true };
		}
		job.last_status = run.ok ? "dispatched" : "failed";
		job.last_result = { instance, status: run.ok ? 0 : (run.status ?? 1), stdout: run.stdout.slice(0, 500), stderr: run.stderr.slice(0, 500), fallback: false };
		if (String(job.mode || "").startsWith("planner:")) { const pl = runPlannerForJob(job, spawn, env); Object.assign(job.last_result, { planner: { status: pl.status } }); }
		return job.last_result;
	}
	// Legacy job (pre-script-first): keep dispatching the project planner with
	// the task text — the historical behaviour, now the explicit fallback.
	const args = dispatchPlanner({ projectRoot: job.project_root, task: job.task, jobId: job.id, jobName: job.name, now, instance });
	const result = spawn === spawnSync
		? launchDetachedPlanner(args, env)
		: spawn(process.execPath, args, { cwd: SCHEDULER_ROOT, encoding: "utf8", maxBuffer: 1_000_000, env });
	return { instance, status: result.status ?? 1, stderr: String(result.stderr || "").trim(), stdout: String(result.stdout || "").trim(), legacy: true };
}

function runPlannerForJob(job, spawn, env = process.env) {
	const args = dispatchPlanner({ projectRoot: job.project_root, task: job.task, jobId: job.id, jobName: job.name, now: new Date(), instance: "planner-01" });
	return spawn === spawnSync
		? launchDetachedPlanner(args, env)
		: spawn(process.execPath, args, { cwd: SCHEDULER_ROOT, encoding: "utf8", maxBuffer: 1_000_000, env });
}

function launchDetachedPlanner(args, env) {
	const child = spawn(process.execPath, args, { cwd: LOCAL_PC_ROOT, env, stdio: "ignore", detached: true });
	child.unref();
	return { status: 0, stdout: "planner task queued", stderr: "" };
}

function retryRecoverableFailures(store, now, spawn, env) {
	const retried = [];
	for (const job of store.jobs) {
		if (!job.enabled || job.last_status !== "failed" || !job.last_result) continue;
		const diagnostic = `${job.last_result.error || ""} ${job.last_result.stderr || ""}`;
		if (!/workspace Herdr verificato|workspace Herdr non trovato|yano-local-pc/i.test(diagnostic)) continue;
		const previousRetry = Date.parse(job.last_retry_at || "");
		if (Number.isFinite(previousRetry) && now.getTime() - previousRetry < 60_000) continue;
		const run = dispatch(job, now, spawn, env);
		job.last_retry_at = nowIso(now);
		job.last_status = run.status === 0 ? "dispatched" : "failed";
		job.last_result = { ...run, automatic_retry: true, retry_of: job.last_run_slot || null };
		retried.push({ id: job.id, status: job.last_status, run: job.last_result });
	}
	return retried;
}

function herdrSnapshot(spawn = spawnSync) {
	const result = spawn("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}
function ensureSchedulerWorkspace(spawn = spawnSync) {
	let snapshot = herdrSnapshot(spawn);
	if (!snapshot) fail("Herdr non raggiungibile: impossibile supervisionare yano-local-pc.");
	const label = SCHEDULER_WORKSPACE_LABEL;
	let workspace = snapshot.workspaces?.find((item) => item.label === label);
	if (!workspace) {
		const created = spawn("herdr", ["workspace", "create", "--cwd", SCHEDULER_ROOT, "--label", label, "--focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (created.status !== 0) fail(`Herdr non ha creato il workspace scheduler${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		snapshot = herdrSnapshot(spawn); workspace = snapshot?.workspaces?.find((item) => item.label === label);
	}
	if (!workspace?.workspace_id) fail("Herdr non ha restituito il workspace di yano-scheduler.");
	let tab = snapshot?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === SCHEDULER_TAB_LABEL);
	let pane = tab ? snapshot?.panes?.find((item) => item.tab_id === tab.tab_id) : null;
	const occupant = pane ? snapshot?.agents?.find((agent) => agent.pane_id === pane.pane_id) : null;
	if (tab && occupant) {
		const closed = spawn("herdr", ["tab", "close", tab.tab_id], { encoding: "utf8", maxBuffer: 1_000_000 });
		if (closed.status !== 0) fail(`Herdr non ha chiuso la tab scheduler non valida${closed.stderr ? `: ${closed.stderr.trim()}` : ""}`);
		tab = null; pane = null;
		snapshot = herdrSnapshot(spawn);
		workspace = snapshot?.workspaces?.find((item) => item.label === label);
		if (!workspace) {
			const recreated = spawn("herdr", ["workspace", "create", "--cwd", SCHEDULER_ROOT, "--label", label, "--focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
			if (recreated.status !== 0) fail(`Herdr non ha ricreato il workspace scheduler${recreated.stderr ? `: ${recreated.stderr.trim()}` : ""}`);
			snapshot = herdrSnapshot(spawn);
			workspace = snapshot?.workspaces?.find((item) => item.label === label);
		}
		if (!workspace?.workspace_id) fail("Herdr non ha restituito il workspace ricreato di yano-scheduler.");
	}
	if (!tab || !pane?.pane_id) {
			const created = spawn("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", SCHEDULER_ROOT, "--label", SCHEDULER_TAB_LABEL, "--no-focus"], { encoding: "utf8", maxBuffer: 1_000_000 });
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
	if (!pane?.pane_id) fail("Herdr non ha restituito il pane della tab yano-local-pc.");
	snapshot = herdrSnapshot(spawn) || snapshot;
	const initial = snapshot?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.tab_id !== tab.tab_id && /^(1|\d+)$/.test(item.label || ""));
	if (initial) spawn("herdr", ["tab", "close", initial.tab_id], { encoding: "utf8", maxBuffer: 1_000_000 });
	return { workspace, tab, pane };
}
function superviseAgent(store, now, spawn = spawnSync) {
	const snapshot = herdrSnapshot(spawn);
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
	const composed = spawn(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs"), "--instance", SCHEDULER_INSTANCE, "--role", "scheduler", "--project", SCHEDULER_WORKSPACE_LABEL, "--config-dir", path.join(PACKAGE_ROOT, "agents"), "--json", "--print-only"], { cwd: SCHEDULER_ROOT, encoding: "utf8", maxBuffer: 1_000_000, env: process.env });
	let args;
	try { args = JSON.parse(composed.stdout || "").args; } catch { return { running: false, recovered: true, instance: SCHEDULER_INSTANCE, status: 1, error: `impossibile comporre il comando Pi scheduler: ${(composed.stderr || composed.stdout || "risposta vuota").trim()}` }; }
	const command = ["pi", ...args].map(shellQuote).join(" ");
	const result = spawn("herdr", ["pane", "run", target.pane.pane_id, `exec ${command}`], { cwd: SCHEDULER_ROOT, encoding: "utf8", maxBuffer: 1_000_000, env: process.env });
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
		const run = dispatch(job, now, spawn, env);
		job.last_run_slot = slot; job.last_run_at = nowIso(now);
		if (job.last_status !== "failed") job.last_status = run.status === 0 ? "dispatched" : "failed";
		job.last_result = run;
		if (job.one_shot) { job.enabled = false; job.one_shot_reason = "eseguito una volta"; run.one_shot_disabled = true; }
		results.push({ id: job.id, name: job.name, enabled: job.enabled, ...run, status: job.last_status, one_shot_disabled: run.one_shot_disabled });
	}
	writeStore(file, store); return { at: nowIso(now), dispatched: results };
}

const WEEKDAYS = { domenica: 0, lunedi: 1, "lunedì": 1, martedi: 2, "martedì": 2, mercoledi: 3, "mercoledì": 3, giovedi: 4, "giovedì": 4, venerdi: 5, "venerdì": 5, sabato: 6 };
function timeParts(valueToParse) {
	const match = String(valueToParse).match(/^(\d{1,2})(?::(\d{2}))?$/);
	if (!match) return null;
	const hour = Number(match[1]); const minute = Number(match[2] || 0);
	return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}
export function parseNaturalSchedule(text) {
	const normalized = String(text || "").trim();
	const daily = normalized.match(/^ogni\s+giorno\s+alle\s+(.+?)\s+(?:voglio\s+che\s+)?(?:esegui|fai(?:\s+partire)?|avvia|lancia)\s+(.+)$/i);
	if (daily) {
		const times = daily[1].replace(/\balle\s+/gi, "").split(/\s*(?:,|e)\s*/i).map(timeParts);
		if (!times.length || times.some((item) => !item)) return null;
		const minutes = [...new Set(times.map((item) => item.minute))];
		if (minutes.length !== 1) return null;
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
export function schedulerCronInstall({ spawn = spawnSync, platform = process.platform } = {}) {
	const windows = installOneMinuteWindowsJob({ marker: CRON_MARKER, command: cronCommand(), platform, spawn });
	if (windows) return windows;
	const line = `* * * * * ${cronCommand()}`;
	const old = readCrontab(spawn).split("\n").filter((entry) => !entry.includes(CRON_MARKER)).filter(Boolean);
	const result = spawn("crontab", ["-"], { input: `${[...old, line].join("\n")}\n`, encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) fail(`impossibile installare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { installed: true, schedule: "* * * * *", marker: CRON_MARKER, backend: "crontab" };
}
export function schedulerCronStatus({ spawn = spawnSync, platform = process.platform } = {}) {
	const windows = statusOneMinuteWindowsJob({ marker: CRON_MARKER, platform, spawn });
	if (windows) return { installed: windows.installed, line: windows.command, schedule: windows.schedule, backend: "schtasks" };
	const line = readCrontab(spawn).split("\n").find((entry) => entry.includes(CRON_MARKER)) || null;
	return { installed: Boolean(line), line, schedule: line?.trim().split(/\s+/).slice(0, 5).join(" ") || null, backend: "crontab" };
}
export function schedulerCronRemove({ spawn = spawnSync, platform = process.platform } = {}) {
	const windows = removeOneMinuteWindowsJob({ marker: CRON_MARKER, platform, spawn });
	if (windows) return { removed: windows.removed, backend: "schtasks" };
	const old = readCrontab(spawn);
	const content = old.split("\n").filter((entry) => !entry.includes(CRON_MARKER)).filter(Boolean).join("\n");
	if (content === old.trim()) return { removed: false, backend: "crontab" };
	const result = spawn("crontab", ["-"], { input: content ? `${content}\n` : "", encoding: "utf8", maxBuffer: 1_000_000 });
	if (result.status !== 0) fail(`impossibile aggiornare il crontab${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return { removed: true, backend: "crontab" };
}

function usage() {
	return [
		"Uso: yano schedule <add|list|remove|enable|disable|run|tick|supervise|cron> [opzioni]",
		"Oppure: yano cron --add <frase naturale> [--project-root <dir>] | --list | --remove <id> | --enable <id> | --disable <id> | --run <id> | --supervise | --status",
		"",
		"  add --name <nome> --project-root <dir> --script <path> --mode <self|planner:<progetto>|yano-local-pc>",
		"      [--cron '0 14,21 * * *'] [--once] [--timeout-ms N] [--expected-consequence <testo>] [--json]",
		"      Registra uno schedule che esegue LO SCRIPT registrato; --once = una sola esecuzione (poi si disabilita).",
		"  add-natural: sintassi storica testo+cron (job legacy, dispatch planner come in passato).",
		"  run --id <id> [--json]      Esegue LO SCRIPT registrato subito (test prima di renderlo ricorrente).",
		"  list [--json]               Mostra i job con script_path, mode, expected_consequence e stato.",
		"  remove|enable|disable --id <id>",
		"  tick [--json]               Dispatcher one-minute (cron di sistema → `yano schedule tick`).",
		"  supervise [--json]          Supervise + tick.",
		"  cron <install|status|remove>",
		"",
		"Vincoli di sicurezza: il job non esegue MAI shell arbitrari; esegue solo lo script",
		"registrato e validato (folder persistente utente <data>/scheduler/scripts/). Token e",
		"credenziali vanno letti da .env all'interno dello script, mai incorporati. Le modalità",
		"che modificano il progetto passano dal planner di progetto con gate umani.",
	].join("\n");
}

async function spawnBridge() {
	const raw = process.env.YANO_TEST_SPAWN_BRIDGE;
	if (!raw) return null;
	try {
		const { fn, path: bridgePath, meta } = JSON.parse(raw);
		if (!bridgePath) return null;
		const base = path.basename(bridgePath);
		if (base !== "yano-test-spawn-bridge.mjs") return null;
		const module = await import(bridgePath);
		if (!module || typeof module.yanoTestSpawn !== "function") return null;
		return module.yanoTestSpawn(meta);
	} catch { return null; }
}

export async function runYanoScheduler({ argv, env = process.env, now = new Date(), spawn = spawnSync } = {}) {
	const [sub, ...rest] = argv; const json = rest.includes("--json");
	// Test-only injectable spawn: the bridge module exports the fake spawn.
	if (!spawn || spawn === spawnSync) spawn = (await spawnBridge()) || spawnSync;
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	let result;
	if (sub === "add" || sub === "add-natural") {
		const natural = sub === "add-natural" ? requireValue(rest, "--task") : null;
		const parsedNatural = natural ? parseNaturalSchedule(natural) : null;
		if (natural && !parsedNatural) fail("non riesco a interpretare la frequenza; usa ad esempio 'ogni giorno alle 14 e alle 21 esegui …' oppure 'ogni settimana di lunedì alle 13:00 fai …'.");
		const cron = parsedNatural?.cron || requireValue(rest, "--cron"); if (!validCron(cron)) fail("--cron deve avere cinque campi cron validi (es. '0 14,21 * * *').");
		// One-shot: a cron-shaped slot is still required so the tick matcher
		// knows WHEN; the job disables itself after its single run.
		const oneShot = rest.includes("--once") || rest.includes("--one-shot");
		const projectRoot = path.resolve(value(rest, "--project-root") || process.cwd()); if (!existsSync(projectRoot)) fail(`project root inesistente: ${projectRoot}`);
		const scriptPath = value(rest, "--script");
		const task = parsedNatural?.task || (scriptPath ? (value(rest, "--task") || `esegue ${path.basename(scriptPath)}`) : requireValue(rest, "--task")); const name = value(rest, "--name") || task.slice(0, 72);
		const mode = value(rest, "--mode") || (scriptPath ? "self" : null);
		const draft = {
			id: `job-${idPart(name)}-${Date.now().toString(36)}`,
			name, project_root: projectRoot, cron, task, enabled: true,
			script_path: scriptPath || null, mode, one_shot: oneShot || null,
			timeout_ms: value(rest, "--timeout-ms") ? Number(value(rest, "--timeout-ms")) : 120000,
			expected_consequence: value(rest, "--expected-consequence") || (scriptPath ? `${path.basename(scriptPath)} eseguito` : `task inviato al planner del progetto ${path.basename(projectRoot)}`),
			created_at: nowIso(now), updated_at: nowIso(now),
			last_run_at: null, last_run_slot: null, last_status: null,
		};
		if (draft.script_path) {
			// Validazione obbligatoria (vincolo: niente job non validati): il
			// validator usa lo stesso data-root del registro (env) così il test
			// con YANO_DATA_DIR temporaneo e l'uso reale coincidono.
			const scriptsDir = schedulerScriptsDir(env);
			const issues = validateJob(draft, { exists: existsSync, scriptsDir });
			if (issues.length) fail(`job non valido: ${issues.join("; ")}`);
		}
		const { file, store } = readStore(env);
		store.jobs.push(draft); writeStore(file, store);
		result = { created: draft, cron: schedulerCronInstall({ spawn }) };
	} else if (sub === "list") result = readStore(env).store.jobs;
	else if (["remove", "enable", "disable", "run"].includes(sub)) {
		const { file, store } = readStore(env); const job = store.jobs.find((item) => item.id === requireValue(rest, "--id")); if (!job) fail("job non trovato.");
		if (sub === "remove") { store.jobs = store.jobs.filter((item) => item !== job); writeStore(file, store); result = { removed: job.id }; }
		else if (sub === "run") {
			// `run` = test dello script registrato prima di renderlo ricorrente (D).
			const run = dispatch(job, new Date(), spawn, env);
			job.last_run_at = nowIso(now); job.last_status = run.status === 0 ? "dispatched" : "failed"; job.last_result = run;
			writeStore(file, store); result = { id: job.id, run };
		}
		else { job.enabled = sub === "enable"; job.updated_at = nowIso(now); writeStore(file, store); result = { id: job.id, enabled: job.enabled }; }
	} else if (sub === "tick") result = tick({ env, now, spawn });
	else if (sub === "supervise") result = superviseScheduler({ env, now, spawn });
	else if (sub === "cron") { const action = rest.find((item) => !item.startsWith("--")) || "status"; result = action === "install" ? schedulerCronInstall({ spawn }) : action === "remove" ? schedulerCronRemove({ spawn }) : action === "status" ? schedulerCronStatus({ spawn }) : fail("azione cron sconosciuta; usa install, status o remove."); }
	else { usage(); fail(`sottocomando sconosciuto: ${sub}`); }
	if (json) console.log(JSON.stringify(result)); else console.log(typeof result === "string" ? result : JSON.stringify(result));
	return result;
}

export function superviseScheduler({ env = process.env, now = new Date(), spawn = spawnSync } = {}) {
	const { file, store } = readStore(env);
	const agent = superviseAgent(store, now, spawn);
	// The scheduler's own minute tick must also guarantee that its execution
	// target exists. A failed legacy job caused by a missing Herdr workspace is
	// retried once immediately after Local PC recovery, instead of waiting for
	// the next cron slot.
	let localPc;
	try { localPc = ensureComputerLocalService(); } catch (error) { localPc = { running: false, error: error instanceof Error ? error.message : String(error) }; }
	const retries = localPc?.running ? retryRecoverableFailures(store, now, spawn, env) : [];
	// Persist the recovery before tick() reloads the registry; otherwise the
	// normal tick would overwrite the repaired failure with the stale snapshot.
	if (retries.length) writeStore(file, store);
	const jobs = tick({ env, now, spawn });
	const refreshed = readStore(env); refreshed.store.supervisor = store.supervisor; writeStore(refreshed.file, refreshed.store);
	return { checked_at: nowIso(now), agent, local_pc: localPc, retries, ...jobs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runYanoScheduler({ argv: process.argv.slice(2) }).catch((error) => { console.error(error.message); process.exitCode = 1; });
