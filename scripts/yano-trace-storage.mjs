import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const TRACE_MODES = Object.freeze(["off", "events", "standard", "full"]);
export const DEFAULT_TRACE_MODE = "events";

const TRACE_SCHEMA_VERSION = 1;

function packageRoot() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function traceRoot() {
	const configured = process.env.YANO_DATA_DIR || process.env.YANO_TEMP_DIR;
	return path.resolve(configured || path.join(packageRoot(), "temp"));
}

export function slugify(value) {
	return String(value || "progetto")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "progetto";
}

export function resolveTraceProject(cwd, explicitProject = null) {
	if (explicitProject && String(explicitProject).trim()) return String(explicitProject).trim();
	try {
		const config = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "extensions", "multiAgentOrchestrator", "config", "project.json"), "utf8"));
		if (config.project) return String(config.project);
	} catch { /* fall through */ }
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
		if (pkg.name && !String(pkg.name).startsWith("@otomatik/pi-mqtt-")) return String(pkg.name);
	} catch { /* fall through */ }
	return path.basename(path.resolve(cwd)) || "default";
}

function canonicalCwd(cwd) {
	try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); }
}

export function projectKey(cwd, project) {
	const locationHash = crypto.createHash("sha256").update(canonicalCwd(cwd)).digest("hex").slice(0, 12);
	return `${slugify(project)}-${locationHash}`;
}

export function tracePaths({ cwd, project, instance = null } = {}) {
	const resolvedProject = project || resolveTraceProject(cwd || process.cwd());
	const key = projectKey(cwd || process.cwd(), resolvedProject);
	const projectDir = path.join(traceRoot(), "traces", key);
	return {
		root: traceRoot(),
		config: path.join(traceRoot(), "tracing.json"),
		project: resolvedProject,
		projectKey: key,
		projectDir,
		eventsDir: path.join(projectDir, "events"),
		terminalDir: path.join(projectDir, "terminal"),
		snapshotsDir: path.join(projectDir, "snapshots"),
		feedbackLog: path.join(projectDir, "feedback.jsonl"),
		opinionsLog: path.join(projectDir, "opinions.jsonl"),
		summariesLog: path.join(projectDir, "summaries.jsonl"),
		instanceLog: instance ? path.join(projectDir, "events", `${slugify(instance)}.jsonl`) : null,
	};
}

function readRegistry() {
	try {
		const value = JSON.parse(fs.readFileSync(path.join(traceRoot(), "tracing.json"), "utf8"));
		return {
			schema_version: TRACE_SCHEMA_VERSION,
			default_mode: TRACE_MODES.includes(value.default_mode) ? value.default_mode : DEFAULT_TRACE_MODE,
			projects: value.projects && typeof value.projects === "object" ? value.projects : {},
		};
	} catch {
		return { schema_version: TRACE_SCHEMA_VERSION, default_mode: DEFAULT_TRACE_MODE, projects: {} };
	}
}

function writeRegistry(registry) {
	fs.mkdirSync(traceRoot(), { recursive: true });
	const file = path.join(traceRoot(), "tracing.json");
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

export function getTraceConfig({ cwd, project } = {}) {
	const paths = tracePaths({ cwd: cwd || process.cwd(), project });
	const registry = readRegistry();
	const entry = registry.projects[paths.projectKey];
	const mode = entry?.mode || registry.default_mode || DEFAULT_TRACE_MODE;
	return {
		mode: TRACE_MODES.includes(mode) ? mode : DEFAULT_TRACE_MODE,
		project: paths.project,
		project_key: paths.projectKey,
		root: paths.root,
		updated_at: entry?.updated_at || null,
	};
}

export function setTraceMode({ cwd, project, mode }) {
	if (!TRACE_MODES.includes(mode)) throw new Error(`modalità tracing non valida "${mode}" (valori: ${TRACE_MODES.join(", ")})`);
	const paths = tracePaths({ cwd: cwd || process.cwd(), project });
	const registry = readRegistry();
	registry.projects[paths.projectKey] = {
		project: paths.project,
		cwd: canonicalCwd(cwd || process.cwd()),
		mode,
		updated_at: new Date().toISOString(),
	};
	writeRegistry(registry);
	return getTraceConfig({ cwd, project });
}

export function ensureTraceProject({ cwd, project, instance = null }) {
	const paths = tracePaths({ cwd: cwd || process.cwd(), project, instance });
	fs.mkdirSync(paths.eventsDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(paths.terminalDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(paths.snapshotsDir, { recursive: true, mode: 0o700 });
	return paths;
}

export function appendTraceRecord({ cwd, project, kind, record }) {
	const paths = ensureTraceProject({ cwd: cwd || process.cwd(), project });
	const logPath = kind === "feedback" ? paths.feedbackLog : kind === "opinion" ? paths.opinionsLog : paths.summariesLog;
	const entry = {
		...record,
		id: record.id || crypto.randomUUID(),
		ts: record.ts || new Date().toISOString(),
		project: paths.project,
		project_key: paths.projectKey,
		record_type: kind,
	};
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	return entry;
}

export function readTraceRecords({ cwd, project, allProjects = false, since = null, limit = 10000 } = {}) {
	const root = traceRoot();
	const projectKeyFilter = allProjects ? null : tracePaths({ cwd: cwd || process.cwd(), project }).projectKey;
	const base = path.join(root, "traces");
	const records = [];
	for (const file of walkJsonl(base)) {
		let lines;
		try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { continue; }
		for (const line of lines) {
			try {
				const item = JSON.parse(line);
				if (projectKeyFilter && item.project_key !== projectKeyFilter) continue;
				if (since && item.ts && new Date(item.ts).getTime() < since.getTime()) continue;
				records.push(item);
			} catch { /* malformed trace lines are handled by review-log; skip them here */ }
		}
	}
	return records.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || ""))).slice(-limit);
}

const FAILURE_SIGNAL_RULES = [
	["no_live_target", (r) => r.type === "agent_send_no_live_target"],
	["delegation_timeout", (r) => r.type === "whatsapp_notify" && r.reason === "agent_send_timeout"],
	["watchdog_stall", (r) => typeof r.type === "string" && r.type.includes("stall")],
	["orphaned_agent", (r) => typeof r.type === "string" && r.type.includes("orphan")],
	["merge_conflict", (r) => r.type === "worktree_finalize" && r.conflict === true],
	["dirty_main_finalize", (r) => r.type === "worktree_finalize" && r.blocked_dirty_main === true],
	["tool_failure", (r) => r.type === "tool_execution_end" && r.ok === false],
	["user_rejected_round", (r) => r.record_type === "feedback" && ["rejected", "partial"].includes(r.status)],
];

const FEEDBACK_PATTERN_RULES = [
	["requirements_missed", /requisit|richiest|specifica|non era quello|mancava/i],
	["wrong_implementation", /errore|sbagliat|bug|non funziona|regression|rotto/i],
	["verification_gap", /test|verific|review|controll|non provat/i],
	["orchestration_gap", /planner|deleg|agent|round|workflow|flusso|coordin/i],
	["missing_capability", /skill|competenz|specialist|agente|ruolo|tool|cli|mcp/i],
	["ux_or_output_gap", /interfaccia|ui|ux|output|document|report|spiegaz/i],
];

function countBy(records, key) {
	const counts = {};
	for (const record of records) {
		const value = record[key] ?? "unknown";
		counts[value] = (counts[value] || 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

export function buildTraceOverview({ cwd, project, allProjects = false, since = null, limit = 10000 } = {}) {
	const records = readTraceRecords({ cwd, project, allProjects, since, limit });
	const feedback = records.filter((r) => r.record_type === "feedback");
	const opinions = records.filter((r) => r.record_type === "opinion");
	const failureSignals = {};
	for (const [name, matches] of FAILURE_SIGNAL_RULES) failureSignals[name] = records.filter(matches).length;
	const patterns = {};
	for (const record of feedback) {
		for (const [name, matcher] of FEEDBACK_PATTERN_RULES) if (matcher.test(String(record.text || ""))) patterns[name] = (patterns[name] || 0) + 1;
	}
	return {
		generated_at: new Date().toISOString(),
		scope: allProjects ? "all-projects" : "project",
		project: allProjects ? null : (project || tracePaths({ cwd: cwd || process.cwd() }).project),
		projects: Object.keys(countBy(records.filter((r) => r.project), "project")),
		totals: {
			records: records.length,
			feedback: feedback.length,
			opinions: opinions.length,
			rejected: feedback.filter((r) => r.status === "rejected").length,
			partial: feedback.filter((r) => r.status === "partial").length,
			accepted: feedback.filter((r) => r.status === "accepted").length,
		},
		feedback_by_project: countBy(feedback, "project"),
		feedback_by_round: countBy(feedback, "round"),
		failure_signals: Object.fromEntries(Object.entries(failureSignals).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])),
		feedback_patterns: Object.fromEntries(Object.entries(patterns).sort((a, b) => b[1] - a[1])),
		recent_feedback: feedback.slice(-20),
		recent_opinions: opinions.slice(-20),
	};
}

export function traceEnabled(mode, minimum = "events") {
	return TRACE_MODES.indexOf(mode) >= TRACE_MODES.indexOf(minimum) && mode !== "off";
}

export function listTraceProjects() {
	const registry = readRegistry();
	const base = path.join(traceRoot(), "traces");
	const dirs = fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
	return dirs.map((key) => ({
		project_key: key,
		...(registry.projects[key] || {}),
		path: path.join(base, key),
	}));
}

function eventMatches(event, filters) {
	if (filters.run && event.run_id !== filters.run) return false;
	if (filters.instance && event.instance !== filters.instance) return false;
	if (filters.type && event.type !== filters.type) return false;
	if (filters.before && event.ts && new Date(event.ts).getTime() >= filters.before.getTime()) return false;
	return true;
}

export function clearTraceData({ cwd, project, projectKey: explicitKey, run = null, instance = null, type = null, before = null, all = false } = {}) {
	if (all) {
		const root = traceRoot();
		if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
		return { deleted: true, all: true, files: 0, events: 0, root };
	}
	const paths = explicitKey ? { projectKey: explicitKey, projectDir: path.join(traceRoot(), "traces", explicitKey) } : tracePaths({ cwd: cwd || process.cwd(), project });
	if (!fs.existsSync(paths.projectDir)) return { deleted: true, all: false, files: 0, events: 0, project_key: paths.projectKey };

	const hasFilter = !!(run || instance || type || before);
	let files = 0;
	let events = 0;
	for (const file of walkJsonl(paths.projectDir)) {
		const original = fs.readFileSync(file, "utf8");
		const lines = original.split("\n").filter(Boolean);
		if (!hasFilter) {
			fs.rmSync(file, { force: true });
			files++;
			events += lines.length;
			continue;
		}
		const kept = [];
		for (const line of lines) {
			let event;
			try { event = JSON.parse(line); } catch { kept.push(line); continue; }
			if (eventMatches(event, { run, instance, type, before })) events++;
			else kept.push(line);
		}
		if (kept.length === lines.length) continue;
		if (kept.length) fs.writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
		else fs.rmSync(file, { force: true });
		files++;
	}
	removeEmptyDirs(paths.projectDir);
	return { deleted: true, all: false, files, events, project_key: paths.projectKey };
}

function* walkJsonl(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJsonl(file);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield file;
	}
}

function removeEmptyDirs(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
	try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* best effort */ }
}
