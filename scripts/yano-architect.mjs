#!/usr/bin/env node

// Global playbook/role architect. It owns proposals and capability readiness,
// never the reference project's source code. Generated artifacts are staged in
// YANO_DATA_DIR until a validated proposal is explicitly promoted.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import YAML from "yaml";
import { loadPlaybook } from "./playbook-loader.mjs";
import { projectKey, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ARCHITECT_WORKSPACE = "yano-architect";
const WATCHER_WORKSPACE = "yano-watcher";
const VALID_STATUSES = new Set(["draft", "provisioning", "ready_ephemeral", "validation_failed", "promotion_candidate", "persistent", "revision_required", "blocked"]);

function now() { return new Date().toISOString(); }
function value(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; }
function has(argv, flag) { return argv.includes(flag); }
function parseJson(valueToParse, fallback = null) { try { return JSON.parse(valueToParse); } catch { return fallback; } }
function slug(valueToSlug) { return String(valueToSlug || "proposal").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "proposal"; }
function safeShell(valueToQuote) { return process.platform === "win32" ? `"${String(valueToQuote).replaceAll('"', '\\"')}"` : `'${String(valueToQuote).replaceAll("'", `\\'"'"'`)}'`; }
function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
	catch (error) { throw new Error(`yano architect: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`); }
}

function dataRoot() { return path.join(traceRoot(), "architect"); }
function proposalsRoot() { return path.join(dataRoot(), "proposals"); }
function catalogRoot() { return path.join(traceRoot(), "catalog"); }
function dbPath() { return path.join(dataRoot(), "architect.sqlite"); }

function openDatabase() {
	fs.mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
	const { DatabaseSync } = requireSqlite();
	const db = new DatabaseSync(dbPath());
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS architect_proposals (
			proposal_id TEXT PRIMARY KEY,
			project_key TEXT NOT NULL,
			project_root TEXT NOT NULL,
			project_name TEXT NOT NULL,
			task TEXT NOT NULL,
			status TEXT NOT NULL,
			version TEXT NOT NULL,
			base_playbook TEXT NOT NULL,
			playbook_id TEXT NOT NULL,
			role_id TEXT NOT NULL,
			ephemeral_dir TEXT NOT NULL,
			playbook_path TEXT NOT NULL,
			manifest_path TEXT NOT NULL,
			workspace_id TEXT,
			tab_id TEXT,
			pane_id TEXT,
			architect_instance TEXT,
			watcher_workspace_id TEXT,
			watcher_tab_id TEXT,
			watcher_pane_id TEXT,
			validation_run_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS architect_proposals_project_idx ON architect_proposals(project_key, updated_at DESC);
		CREATE TABLE IF NOT EXISTS architect_capabilities (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			proposal_id TEXT NOT NULL REFERENCES architect_proposals(proposal_id),
			kind TEXT NOT NULL,
			name TEXT NOT NULL,
			status TEXT NOT NULL,
			source TEXT,
			version TEXT,
			detail TEXT,
			install_command TEXT,
			checked_at TEXT NOT NULL,
			UNIQUE(proposal_id, kind, name)
		);
		CREATE TABLE IF NOT EXISTS architect_validations (
			validation_id TEXT PRIMARY KEY,
			proposal_id TEXT NOT NULL REFERENCES architect_proposals(proposal_id),
			run_id TEXT NOT NULL,
			project_key TEXT NOT NULL,
			result TEXT NOT NULL,
			details TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS architect_feedback (
			feedback_id TEXT PRIMARY KEY,
			proposal_id TEXT NOT NULL REFERENCES architect_proposals(proposal_id),
			status TEXT NOT NULL,
			text TEXT NOT NULL,
			actor TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS architect_events (
			event_id TEXT PRIMARY KEY,
			proposal_id TEXT NOT NULL,
			type TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
	try { db.exec("ALTER TABLE architect_proposals RENAME COLUMN ephermal_dir TO ephemeral_dir"); } catch { /* fresh schema or already migrated */ }
	return db;
}

function projectInfo(projectRoot, explicitProject = null) {
	const root = path.resolve(projectRoot || process.cwd());
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`yano architect: project root non valida: ${root}`);
	const name = String(explicitProject || resolveTraceProject(root)).trim();
	if (!name) throw new Error("yano architect: nome progetto vuoto");
	return { root, name, key: projectKey(root, name) };
}

function roleConfig() {
	try { return YAML.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "agents", "roles.yaml"), "utf8"))?.roles || {}; }
	catch { return {}; }
}

function candidateForTask(task) {
	const text = String(task).toLowerCase();
	if (/deploy|release|staging|production|docker|rollout/.test(text)) return { playbook: "deployment-delivery", roles: ["deployment-agent"], reason: "deployment intent" };
	if (/document|documenti|documentale|authoring|knowledge|strategic|strategia|strategico|vendita|sales|seo|marketing|acquisizione clienti|contenuti|copywriting|business docs/.test(text)) return { playbook: "documentation-release", roles: ["docs-sync"], reason: "documentation/business-authoring intent" };
	if (/frontend|front-end|ui|ux|browser|responsive|redesign|design system|dashboard|sito|applicazione/.test(text)) return { playbook: "frontend-browser", roles: ["frontend-developer", "frontend-reviewer"], reason: "frontend/browser intent" };
	if (/test|qa|tdd|regression|fuzz|mutation/.test(text)) return { playbook: "qa-hardening", roles: ["tdd-agent", "reviewer"], reason: "quality/testing intent" };
	if (/refactor|refactoring|architettura|modular|cleanup|manutenibil/.test(text)) return { playbook: "backend-change", roles: ["refactoring-specialist", "reviewer"], reason: "refactoring/backend intent" };
	return { playbook: "backend-change", roles: ["coder", "reviewer"], reason: "general implementation fallback" };
}

function aggregateCapabilities(roles, configs) {
	const result = { skills: new Set(["yano-planner-trace-analysis"]), cli: new Set(["git"]), mcp: new Set() };
	for (const role of roles) {
		const cfg = configs[role];
		if (!cfg) continue;
		for (const skill of cfg.skills || []) result.skills.add(skill);
		for (const cli of cfg.cli || []) result.cli.add(cli);
		for (const mcp of cfg.mcp || []) result.mcp.add(mcp);
	}
	return Object.fromEntries(Object.entries(result).map(([key, set]) => [key, [...set].sort()]));
}

function generatedPlaybook({ playbookId, task, candidate, roles }) {
	return {
		schema_version: 1,
		id: playbookId,
		label: `Generated task flow: ${candidate.playbook}`,
		description: `Ephemeral task-specific contract generated for: ${task}`,
		enforcement: { status: "partial", note: `Derived from ${candidate.playbook}; only the approved task scope is active.` },
		states: [
			{ id: "received", owner: "planner", terminal: false },
			{ id: "provisioning", owner: "architect", terminal: false },
			{ id: "implementing", owner: roles[0] || "coder", terminal: false },
			{ id: "review", owner: roles[1] || "reviewer", terminal: false },
			{ id: "awaiting_user_feedback", owner: "planner_and_human", terminal: false },
			{ id: "completed", owner: "planner", terminal: true },
			{ id: "blocked", owner: "planner_and_human", terminal: true },
		],
		transitions: [
			{ id: "provision", from: "received", to: "provisioning", actor: "architect", requires: ["proposal_created", "capability_readiness_verified"] },
			{ id: "start_implementation", from: "provisioning", to: "implementing", actor: "planner", requires: ["capability_readiness_verified", "phase_one_unlocked"] },
			{ id: "submit_review", from: "implementing", to: "review", actor: roles[0] || "coder", requires: ["tests_run", "report_updated"] },
			{ id: "request_feedback", from: "review", to: "awaiting_user_feedback", actor: "planner", requires: ["reviewer_approved", "watcher_round_healthy"] },
			{ id: "complete", from: "awaiting_user_feedback", to: "completed", actor: "planner", requires: ["positive_user_feedback"] },
			{ id: "revise", from: ["review", "awaiting_user_feedback"], to: "blocked", actor: "planner", requires: ["revision_requested"] },
		],
		failure_routes: [
			{ condition: "capability_missing", action: "keep_ephemeral_and_block", terminal: false },
			{ condition: "watcher_finding", action: "keep_ephemeral_and_request_revision", terminal: false },
			{ condition: "negative_user_feedback", action: "return_to_architect", terminal: false },
		],
		invariants: [
			"generated_playbook_is_ephemeral_until_explicit_promotion",
			"all_required_capabilities_are_verified_before_operation",
			"watcher_observes_validation_without_modifying_the_project",
			"planner_owns_user_feedback_and_promotion_decision",
			"no_production_side_effect_without_explicit_approval",
		],
	};
}

function proposalPaths(proposalId) {
	const dir = path.join(proposalsRoot(), proposalId);
	return { dir, playbook: path.join(dir, "playbook.yaml"), manifest: path.join(dir, "manifest.json"), readiness: path.join(dir, "readiness.json") };
}

function writeProposalFiles(proposal, capabilities, candidate) {
	const paths = proposalPaths(proposal.proposal_id);
	fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	const document = generatedPlaybook({ playbookId: proposal.playbook_id, task: proposal.task, candidate, roles: proposal.roles });
	fs.writeFileSync(paths.playbook, YAML.stringify(document), { mode: 0o600 });
	loadPlaybook(paths.playbook);
	const manifest = {
		schema_version: 1,
		proposal_id: proposal.proposal_id,
		status: "ephemeral",
		project: { name: proposal.project_name, root: proposal.project_root, key: proposal.project_key },
		task: proposal.task,
		base_playbook: proposal.base_playbook,
		playbook_id: proposal.playbook_id,
		role_id: proposal.role_id,
		roles: proposal.roles,
		capabilities,
		promotion_policy: { min_successful_runs: 1, min_projects: 1, require_clean_watcher: true, require_user_feedback: true, require_planner_approval: true },
		created_at: proposal.created_at,
	};
	fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	fs.writeFileSync(paths.readiness, `${JSON.stringify({ ready: false, operational: false, status: proposal.status || "draft", checks: [], checked_at: null }, null, 2)}\n`, { mode: 0o600 });
	return paths;
}

function writeReadiness(proposal, { ready, operational, status, checks }) {
	const readinessPath = proposalPaths(proposal.proposal_id).readiness;
	fs.mkdirSync(path.dirname(readinessPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(readinessPath, `${JSON.stringify({ ready: !!ready, operational: !!operational, status, checks, checked_at: now() }, null, 2)}\n`, { mode: 0o600 });
}

function recordEvent(db, proposalId, type, payload = {}) {
	db.prepare("INSERT INTO architect_events(event_id,proposal_id,type,payload_json,created_at) VALUES(?,?,?,?,?)").run(`architect-event-${crypto.randomUUID()}`, proposalId, type, JSON.stringify(payload), now());
}

function loadProposal(db, proposalId) {
	if (!proposalId) throw new Error("yano architect: --proposal-id è obbligatorio");
	const proposal = db.prepare("SELECT * FROM architect_proposals WHERE proposal_id = ?").get(proposalId);
	if (!proposal) throw new Error(`yano architect: proposta non trovata: ${proposalId}`);
	return proposal;
}

function skillCandidates(name) {
	return [
		path.join(PACKAGE_ROOT, "skills-vendor", "yano", name, "SKILL.md"),
		path.join(PACKAGE_ROOT, "skills-vendor", "mattpocock", name, "SKILL.md"),
		path.join(PACKAGE_ROOT, "skills-vendor", "awesome-copilot", name, "SKILL.md"),
		path.join(catalogRoot(), "skills", name, "SKILL.md"),
		path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
		path.join(os.homedir(), ".codex", "skills", name, "SKILL.md"),
	];
}

function verifyCli(name) {
	const commandName = name === "node" ? process.execPath : name;
	if (!/^[A-Za-z0-9_.-]+$/.test(commandName) && commandName !== process.execPath) return { status: "blocked", detail: "CLI name non allowlisted" };
	const result = commandName === process.execPath ? spawnSync(commandName, ["--version"], { encoding: "utf8" }) : spawnSync("sh", ["-lc", `command -v ${commandName} && ${commandName} --version`], { encoding: "utf8" });
	const output = `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n");
	return result.status === 0 ? { status: "ready", source: output[0] || commandName, version: output.at(-1) || "unknown" } : { status: "missing", detail: `CLI ${name} non disponibile`, install_command: `Installare ${name} secondo la documentazione ufficiale e ripetere yano architect verify` };
}

function verifySkill(name) {
	const file = skillCandidates(name).find((candidate) => fs.existsSync(candidate));
	if (!file) return { status: "missing", detail: `SKILL.md non trovata per ${name}`, install_command: `Aggiungere/installare la skill ${name} nel catalogo globale Yano e ripetere yano architect verify` };
	try { const text = fs.readFileSync(file, "utf8"); if (!text.trim()) throw new Error("file vuoto"); return { status: "ready", source: file, version: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) }; }
	catch (error) { return { status: "blocked", source: file, detail: error.message }; }
}

function verifyMcp(name, projectRoot) {
	const files = [path.join(projectRoot, ".mcp.json"), path.join(projectRoot, "mcp.json"), path.join(PACKAGE_ROOT, ".mcp.json"), path.join(PACKAGE_ROOT, "mcp.json")];
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		const parsed = parseJson(fs.readFileSync(file, "utf8"), {});
		const servers = parsed.mcpServers || parsed.servers || parsed;
		if (servers && typeof servers === "object" && servers[name]) return { status: "pending", source: file, detail: "server dichiarato; handshake MCP richiesto prima dell'avvio operativo", install_command: `Verificare handshake MCP ${name} con yano deps/mcp e ripetere yano architect verify` };
	}
	return { status: "missing", detail: `MCP ${name} non dichiarato`, install_command: `Dichiarare il server MCP ${name} nel progetto o nel catalogo globale e ripetere yano architect verify` };
}

function checkCapabilities(proposal, db = null) {
	const capabilities = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {} ).capabilities || {};
	const checks = [];
	for (const name of capabilities.skills || []) checks.push({ kind: "skill", name, ...verifySkill(name) });
	for (const name of capabilities.cli || []) checks.push({ kind: "cli", name, ...verifyCli(name) });
	for (const name of capabilities.mcp || []) {
		const recorded = db?.prepare("SELECT status,source,detail,checked_at FROM architect_capabilities WHERE proposal_id=? AND kind='mcp' AND name=?").get(proposal.proposal_id, name);
		if (recorded?.status === "ready" && String(recorded.detail || "").startsWith("verified by ")) checks.push({ kind: "mcp", name, status: "ready", source: recorded.source, detail: recorded.detail, checked_at: recorded.checked_at });
		else checks.push({ kind: "mcp", name, ...verifyMcp(name, proposal.project_root) });
	}
	return checks;
}

function persistChecks(db, proposalId, checks) {
	const timestamp = now();
	for (const check of checks) db.prepare("INSERT INTO architect_capabilities(proposal_id,kind,name,status,source,version,detail,install_command,checked_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(proposal_id,kind,name) DO UPDATE SET status=excluded.status,source=excluded.source,version=excluded.version,detail=excluded.detail,install_command=excluded.install_command,checked_at=excluded.checked_at").run(proposalId, check.kind, check.name, check.status, check.source || null, check.version || null, check.detail || null, check.install_command || null, timestamp);
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	try { const parsed = JSON.parse(result.stdout); return parsed?.result?.snapshot || parsed?.result || parsed; } catch { return null; }
}

function ensureWorkspace(label, cwd, dryRun = false) {
	const snapshot = herdrSnapshot();
	let workspace = snapshot?.workspaces?.find((item) => item.label === label);
	if (workspace) return { workspace, created: false };
	if (dryRun) return { workspace: { workspace_id: null, label }, created: false, dry_run: true };
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", cwd, "--label", label, "--focus"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano architect: impossibile creare workspace Herdr ${label}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	try { const parsed = JSON.parse(result.stdout); workspace = parsed?.result?.workspace || parsed?.workspace; } catch { /* refresh */ }
	workspace ||= herdrSnapshot()?.workspaces?.find((item) => item.label === label);
	if (!workspace?.workspace_id) throw new Error(`yano architect: workspace Herdr ${label} creato senza workspace_id`);
	return { workspace, created: true };
}

function herdrAgentName(instance) {
	const normalized = slug(instance);
	if (normalized.length <= 32) return normalized;
	const suffix = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 6);
	return `${normalized.slice(0, 25)}-${suffix}`.slice(0, 32);
}

function printableCommand(args) {
	return args.map((arg) => /\s|['"]/.test(String(arg)) ? safeShell(arg) : String(arg)).join(" ");
}

function splitPiStartup(piArgs) {
	const index = piArgs.indexOf("--continue");
	if (index < 0) return { startupArgs: piArgs, initialPrompt: null };
	return { startupArgs: [...piArgs.slice(0, index), ...piArgs.slice(index + 2)], initialPrompt: piArgs[index + 1] || null };
}

function composePiArgs({ cwd, instance, role, project, prompt }) {
	const launcher = path.join(PACKAGE_ROOT, "scripts", "launch-planner.mjs");
	const result = spawnSync(process.execPath, [launcher, "--instance", instance, "--role", role, "--project", project, "--continue", prompt, "--print-only", "--json"], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, YANO_DATA_DIR: process.env.YANO_DATA_DIR || traceRoot() },
		maxBuffer: 2_000_000,
	});
	if (result.status !== 0) throw new Error(`yano architect: composizione del comando Pi fallita per ${role}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	const line = String(result.stdout || "").trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
	let parsed;
	try { parsed = JSON.parse(line || ""); } catch { parsed = null; }
	if (!parsed?.args || !Array.isArray(parsed.args)) throw new Error(`yano architect: launch-planner non ha restituito argomenti Pi validi per ${role}`);
	return parsed.args;
}

function activeHerdrAgent(snapshot, instance, agentName) {
	return (snapshot?.agents || []).find((item) => {
		if (["done", "unknown", "offline"].includes(item.agent_status)) return false;
		return [item.name, item.terminal_title_stripped, item.terminal_title]
			.some((candidate) => candidate === instance || candidate === agentName);
	});
}

function activeHerdrAgentOnPane(snapshot, paneId) {
	return (snapshot?.agents || []).find((item) => item.pane_id === paneId && !["done", "unknown", "offline"].includes(item.agent_status));
}

function ensureHerdrTabLabel(tabId, label) {
	if (!tabId || !label) return;
	const snapshot = herdrSnapshot();
	const tab = snapshot?.tabs?.find((item) => item.tab_id === tabId);
	if (!tab || tab.label === label) return;
	const renamed = spawnSync("herdr", ["tab", "rename", tabId, label], { encoding: "utf8" });
	if (renamed.status !== 0) throw new Error(`yano architect: impossibile rinominare la tab Herdr ${tabId} in ${label}${renamed.stderr ? `: ${renamed.stderr.trim()}` : ""}`);
}

function launchAgentTab({ label, cwd, workspaceId, instance, role, project, prompt, dryRun }) {
	const piArgs = composePiArgs({ cwd, instance, role, project, prompt });
	const { startupArgs, initialPrompt } = splitPiStartup(piArgs);
	const command = printableCommand(["pi", ...piArgs]);
	const agentName = herdrAgentName(instance);
	if (dryRun) return { workspace_id: workspaceId, tab_id: null, pane_id: null, label, command, instance, agent_kind: "pi", herdr_agent_name: agentName, dry_run: true };
	const refreshed = herdrSnapshot();
	const alreadyRunning = activeHerdrAgent(refreshed, instance, agentName);
	if (alreadyRunning) {
		ensureHerdrTabLabel(alreadyRunning.tab_id, label);
		return {
			workspace_id: alreadyRunning.workspace_id || workspaceId,
			tab_id: alreadyRunning.tab_id || null,
			pane_id: alreadyRunning.pane_id || null,
			label,
			command,
			instance,
			agent_kind: alreadyRunning.agent || "pi",
			herdr_agent_name: alreadyRunning.name || alreadyRunning.terminal_title_stripped || agentName,
			agent_status: alreadyRunning.agent_status,
			already_running: true,
			dry_run: false,
		};
	}
	let tab = refreshed?.tabs?.find((item) => item.workspace_id === workspaceId && item.label === label);
	let pane = tab && refreshed?.panes?.find((item) => item.tab_id === tab.tab_id);
	if (pane?.cwd && !fs.existsSync(pane.cwd)) {
		tab = null;
		pane = null;
	}
	// Workspace creation can leave a default shell tab behind. Reuse that blank
	// pane before creating another tab; a visible Herdr panel is not disposable
	// state and should become the requested real Pi agent when it is available.
	if (!tab) {
		pane = refreshed?.panes?.find((candidate) => {
			const ownerTab = refreshed?.tabs?.find((item) => item.tab_id === candidate.tab_id && item.workspace_id === workspaceId);
			return ownerTab && (!candidate.cwd || fs.existsSync(candidate.cwd)) && !activeHerdrAgentOnPane(refreshed, candidate.pane_id);
		});
		tab = pane && refreshed?.tabs?.find((item) => item.tab_id === pane.tab_id && item.workspace_id === workspaceId);
	}
	if (!tab) {
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error(`yano architect: tab Herdr ${label} non creata${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		const next = herdrSnapshot();
		tab = next?.tabs?.find((item) => item.workspace_id === workspaceId && item.label === label);
		pane = tab && next?.panes?.find((item) => item.tab_id === tab.tab_id);
	}
	if (!tab || !pane) throw new Error(`yano architect: tab/pane non trovati per ${label}`);
	ensureHerdrTabLabel(tab.tab_id, label);
	const occupied = herdrSnapshot()?.agents?.find((item) => item.pane_id === pane.pane_id && !["done", "unknown", "offline"].includes(item.agent_status));
	if (occupied) throw new Error(`yano architect: pane ${pane.pane_id} già occupato dall'agente ${occupied.name || occupied.terminal_title_stripped || "sconosciuto"}`);
	// `--kind pi` selects the executable. Herdr appends the arguments after
	// `--`; passing `pi` there would launch the invalid command `pi pi ...`.
	// Keep the initial prompt out of the shell command as well: Herdr must type
	// a bounded startup command, then submit the potentially long prompt through
	// its agent protocol once Pi has been detected as ready.
	const started = spawnSync("herdr", ["agent", "start", agentName, "--kind", "pi", "--pane", pane.pane_id, "--timeout", "120000", "--", ...startupArgs], { cwd, encoding: "utf8", maxBuffer: 2_000_000 });
	if (started.status !== 0) throw new Error(`yano architect: agente Herdr ${agentName} non avviato${started.stderr ? `: ${started.stderr.trim()}` : (started.stdout ? `: ${started.stdout.trim()}` : "")}`);
	if (initialPrompt) {
		const prompted = spawnSync("herdr", ["agent", "prompt", agentName, initialPrompt, "--timeout", "120000"], { cwd, encoding: "utf8", maxBuffer: 2_000_000 });
		if (prompted.status !== 0) throw new Error(`yano architect: prompt iniziale non consegnato all'agente Herdr ${agentName}${prompted.stderr ? `: ${prompted.stderr.trim()}` : (prompted.stdout ? `: ${prompted.stdout.trim()}` : "")}`);
	}
	return { workspace_id: workspaceId, tab_id: tab.tab_id, pane_id: pane.pane_id, label, command, instance, agent_kind: "pi", herdr_agent_name: agentName, started: true, dry_run: false };
}

function launchArchitect(db, proposal, { dryRun = false } = {}) {
	const workspaceRoot = path.join(dataRoot(), "agent-workspaces", ARCHITECT_WORKSPACE);
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const instance = proposal.architect_instance || `architect-${slug(proposal.proposal_id)}`;
	const prompt = `Gestisci la proposta ${proposal.proposal_id} in modo controllato. Leggi ${proposal.manifest_path} e ${proposal.playbook_path}. Verifica/installare solo le capability dichiarate e autorizzate. Non modificare mai il progetto ${proposal.project_root}. Usa yano architect verify --proposal-id ${proposal.proposal_id} dopo il provisioning. Il playbook può diventare operativo solo con readiness completa.`;
	const workspace = ensureWorkspace(ARCHITECT_WORKSPACE, workspaceRoot, dryRun);
	const label = `architect-${slug(proposal.project_name)}`.slice(0, 60);
	const launched = launchAgentTab({ label, cwd: proposal.project_root, workspaceId: workspace.workspace.workspace_id, instance, role: "architect", project: proposal.project_name, prompt, dryRun });
	const timestamp = now();
	db.prepare("UPDATE architect_proposals SET workspace_id=?,tab_id=?,pane_id=?,architect_instance=?,updated_at=? WHERE proposal_id=?").run(launched.workspace_id, launched.tab_id, launched.pane_id, instance, timestamp, proposal.proposal_id);
	return { ...launched, instance, workspace_label: ARCHITECT_WORKSPACE };
}

function launchValidationWatcher(db, proposal, { dryRun = false } = {}) {
	const workspaceRoot = path.join(dataRoot(), "agent-workspaces", WATCHER_WORKSPACE);
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const runId = proposal.validation_run_id || `validation-${proposal.proposal_id}`;
	const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {});
	const playbookChecksum = fs.existsSync(proposal.playbook_path) ? crypto.createHash("sha256").update(fs.readFileSync(proposal.playbook_path)).digest("hex") : "";
	const instance = `yano-watcher-${slug(proposal.project_name)}`;
	const prompt = `Valida il round del playbook ${proposal.proposal_id} per il progetto ${proposal.project_root} in modo esclusivamente read-only. Usa yano watch --once --project-root ${safeShell(proposal.project_root)} --project ${safeShell(proposal.project_name)} --validation-run ${safeShell(runId)} --playbook-proposal ${safeShell(proposal.proposal_id)} --playbook-id ${safeShell(manifest.playbook_id || proposal.playbook_id)} --playbook-checksum ${safeShell(playbookChecksum)}; poi leggi il trace e comunica al planner un esito healthy, finding o blocked con evidenze. Non modificare mai il progetto e non promuovere il playbook. Non usare mai find /, scansioni dell'intero filesystem o comandi senza timeout: limita ogni lettura alla root del progetto e ai percorsi Yano esplicitamente indicati.`;
	const workspace = ensureWorkspace(WATCHER_WORKSPACE, workspaceRoot, dryRun);
	const label = `watcher-${slug(proposal.project_name)}`.slice(0, 60);
	const launched = launchAgentTab({ label, cwd: proposal.project_root, workspaceId: workspace.workspace.workspace_id, instance, role: "watcher", project: proposal.project_name, prompt, dryRun });
	db.prepare("UPDATE architect_proposals SET watcher_workspace_id=?,watcher_tab_id=?,watcher_pane_id=?,validation_run_id=?,updated_at=? WHERE proposal_id=?").run(launched.workspace_id, launched.tab_id, launched.pane_id, runId, now(), proposal.proposal_id);
	return { ...launched, run_id: runId, workspace_label: WATCHER_WORKSPACE };
}

function assess(task, projectRoot, explicitProject) {
	const info = projectInfo(projectRoot, explicitProject);
	const candidate = candidateForTask(task);
	const configs = roleConfig();
	const roles = candidate.roles.filter((role) => configs[role]);
	const capabilities = aggregateCapabilities(roles.length ? roles : ["coder", "reviewer"], configs);
	return { task, project: info, candidate_playbook: candidate.playbook, candidate_reason: candidate.reason, roles, capabilities, needs_new_playbook: true, note: "La proposta generata resta ephemeral finché readiness, validazione watcher e feedback utente non sono positivi." };
}

function createProposal(db, opts) {
	if (!opts.task?.trim()) throw new Error("yano architect: --task è obbligatorio");
	const info = projectInfo(opts.projectRoot, opts.project);
	const assessment = assess(opts.task, opts.projectRoot, opts.project);
	const candidate = candidateForTask(opts.task);
	const timestamp = now();
	const proposalId = `PROP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	const base = slug(candidate.playbook);
	const playbookId = `${base}-${slug(opts.task).slice(0, 24)}`;
	const roleId = `${slug(base)}-specialist`;
	const capabilities = assessment.capabilities;
	const provisional = { proposal_id: proposalId, project_key: info.key, project_root: info.root, project_name: info.name, task: opts.task.trim(), status: "draft", version: "0.1.0", base_playbook: candidate.playbook, playbook_id: playbookId, role_id: roleId, roles: assessment.roles, created_at: timestamp };
	const paths = writeProposalFiles(provisional, capabilities, candidate);
	db.prepare("INSERT INTO architect_proposals(proposal_id,project_key,project_root,project_name,task,status,version,base_playbook,playbook_id,role_id,ephemeral_dir,playbook_path,manifest_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(proposalId, info.key, info.root, info.name, opts.task.trim(), "draft", "0.1.0", candidate.playbook, playbookId, roleId, paths.dir, paths.playbook, paths.manifest, timestamp, timestamp);
	recordEvent(db, proposalId, "proposal_created", { base_playbook: candidate.playbook, roles: assessment.roles, capabilities });
	return { proposal: db.prepare("SELECT * FROM architect_proposals WHERE proposal_id=?").get(proposalId), assessment, paths };
}

function provision(db, proposal, { dryRun = false, once = false, install = false } = {}) {
	const checks = checkCapabilities(proposal, db);
	persistChecks(db, proposal.proposal_id, checks);
	// A declared MCP is only "pending" until an initialize/tools handshake has
	// been recorded. It must not make a playbook operational by declaration
	// alone; this is the capability gate promised to the planner.
	const ready = checks.every((check) => check.status === "ready");
	const status = ready ? "ready_ephemeral" : (install ? "provisioning" : "blocked");
	db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run(status, now(), proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "capability_readiness_checked", { ready, install_requested: install, checks });
	const result = { proposal_id: proposal.proposal_id, status, ready, install_requested: install, checks, operational: ready, no_project_mutation: true };
	if (ready && !once) {
		try {
			result.watcher = launchValidationWatcher(db, { ...proposal, status }, { dryRun });
			result.architect = launchArchitect(db, { ...proposal, status }, { dryRun });
			db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("ready_ephemeral", now(), proposal.proposal_id);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			result.status = "blocked";
			result.ready = false;
			result.operational = false;
			result.launch_error = detail;
			db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("blocked", now(), proposal.proposal_id);
			recordEvent(db, proposal.proposal_id, "external_agent_launch_failed", { error: detail, watcher: result.watcher || null, architect: result.architect || null });
		}
	} else if (!ready && install && !once) {
		try {
			result.architect = launchArchitect(db, { ...proposal, status }, { dryRun });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			result.status = "blocked";
			result.operational = false;
			result.launch_error = detail;
			db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("blocked", now(), proposal.proposal_id);
			recordEvent(db, proposal.proposal_id, "external_agent_launch_failed", { error: detail, architect: result.architect || null });
		}
	}
	writeReadiness(proposal, { ready, operational: result.operational, status: result.status, checks });
	return result;
}

function proposalStatus(db, proposal) {
	const capabilities = db.prepare("SELECT kind,name,status,source,version,detail,install_command,checked_at FROM architect_capabilities WHERE proposal_id=? ORDER BY kind,name").all(proposal.proposal_id);
	const validations = db.prepare("SELECT * FROM architect_validations WHERE proposal_id=? ORDER BY created_at DESC").all(proposal.proposal_id);
	const feedback = db.prepare("SELECT * FROM architect_feedback WHERE proposal_id=? ORDER BY created_at DESC").all(proposal.proposal_id);
	const events = db.prepare("SELECT * FROM architect_events WHERE proposal_id=? ORDER BY created_at DESC LIMIT 50").all(proposal.proposal_id);
	return { proposal, capabilities, validations, feedback, events, db_path: dbPath(), data_root: dataRoot(), catalog_root: catalogRoot() };
}

function recordValidation(db, proposal, opts) {
	if (!opts.runId) throw new Error("yano architect: validation richiede --run-id");
	if (!new Set(["passed", "failed"]).has(opts.result)) throw new Error("yano architect: --result deve essere passed o failed");
	const info = projectInfo(opts.projectRoot || proposal.project_root, opts.project || proposal.project_name);
	const validationId = `VAL-${crypto.randomUUID()}`;
	db.prepare("INSERT INTO architect_validations(validation_id,proposal_id,run_id,project_key,result,details,created_at) VALUES(?,?,?,?,?,?,?)").run(validationId, proposal.proposal_id, opts.runId, info.key, opts.result, opts.details || "", now());
	db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run(opts.result === "passed" ? "promotion_candidate" : "validation_failed", now(), proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "validation_recorded", { validation_id: validationId, run_id: opts.runId, result: opts.result });
	return { validation_id: validationId, proposal_id: proposal.proposal_id, result: opts.result };
}

function recordFeedback(db, proposal, opts) {
	if (!new Set(["positive", "changes_requested", "negative"]).has(opts.status)) throw new Error("yano architect: --status deve essere positive, changes_requested o negative");
	if (!opts.text?.trim()) throw new Error("yano architect: feedback richiede --text");
	const feedbackId = `FDB-${crypto.randomUUID()}`;
	db.prepare("INSERT INTO architect_feedback(feedback_id,proposal_id,status,text,actor,created_at) VALUES(?,?,?,?,?,?)").run(feedbackId, proposal.proposal_id, opts.status, opts.text.trim(), opts.actor || "planner", now());
	const next = opts.status === "positive" ? "promotion_candidate" : "revision_required";
	db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run(next, now(), proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "user_feedback_recorded", { feedback_id: feedbackId, status: opts.status, actor: opts.actor || "planner" });
	return { feedback_id: feedbackId, proposal_id: proposal.proposal_id, status: opts.status, next_state: next };
}

function recordCapability(db, proposal, opts) {
	if (!opts.kind || !opts.name) throw new Error("yano architect: capability richiede --kind e --name");
	if (!new Set(["skill", "cli", "mcp"]).has(opts.kind)) throw new Error("yano architect: --kind deve essere skill, cli o mcp");
	if (opts.status !== "ready") throw new Error("yano architect: per registrare una capability serve --status ready");
	if (!opts.evidence?.trim()) throw new Error("yano architect: capability ready richiede --evidence (prova verificabile e senza segreti)");
	const existing = db.prepare("SELECT id FROM architect_capabilities WHERE proposal_id=? AND kind=? AND name=?").get(proposal.proposal_id, opts.kind, opts.name);
	if (!existing) throw new Error(`yano architect: capability non dichiarata dalla proposta: ${opts.kind}/${opts.name}`);
	const detail = `verified by ${opts.actor || "architect"}: ${opts.evidence.trim()}`;
	db.prepare("UPDATE architect_capabilities SET status='ready',detail=?,source=?,checked_at=? WHERE proposal_id=? AND kind=? AND name=?").run(detail, opts.source || "runtime-handshake", now(), proposal.proposal_id, opts.kind, opts.name);
	recordEvent(db, proposal.proposal_id, "capability_verified", { kind: opts.kind, name: opts.name, actor: opts.actor || "architect", evidence: opts.evidence.trim() });
	return { proposal_id: proposal.proposal_id, kind: opts.kind, name: opts.name, status: "ready" };
}

function promote(db, proposal, opts) {
	if (!opts.yes) throw new Error("yano architect: promote richiede --yes");
	const checks = db.prepare("SELECT status FROM architect_capabilities WHERE proposal_id=?").all(proposal.proposal_id);
	const validations = db.prepare("SELECT * FROM architect_validations WHERE proposal_id=? AND result='passed'").all(proposal.proposal_id);
	const feedback = db.prepare("SELECT * FROM architect_feedback WHERE proposal_id=? AND status='positive'").all(proposal.proposal_id);
	if (!checks.length || checks.some((check) => check.status !== "ready")) throw new Error("yano architect: capability readiness incompleta; esegui provision/verify prima della promozione");
	if (!validations.length) throw new Error("yano architect: serve almeno una validation passed");
	if (!feedback.length) throw new Error("yano architect: serve feedback utente positivo");
	const versionDir = path.join(catalogRoot(), "playbooks", proposal.playbook_id, `v${proposal.version}`);
	const roleDir = path.join(catalogRoot(), "agents", proposal.role_id, `v${proposal.version}`);
	fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(roleDir, { recursive: true, mode: 0o700 });
	fs.copyFileSync(proposal.playbook_path, path.join(versionDir, "playbook.yaml"));
	const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {});
	manifest.status = "persistent";
	manifest.promoted_at = now();
	manifest.validation_ids = validations.map((row) => row.validation_id);
	manifest.feedback_ids = feedback.map((row) => row.feedback_id);
	fs.writeFileSync(path.join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
 fs.writeFileSync(path.join(roleDir, "role.yaml"), YAML.stringify({
		schema_version: 1,
		id: proposal.role_id,
		label: `Generated ${proposal.role_id}`,
		brief: `Specialist generated by Yano Architect for proposal ${proposal.proposal_id}. Follow the assigned playbook and report evidence to the planner.`,
		activation: "lazy",
		playbook: proposal.playbook_id,
		model: { provider: "llmproxy", model: "reasoning-model" },
		skills: manifest.capabilities?.skills || [],
		cli: manifest.capabilities?.cli || [],
		mcp: manifest.capabilities?.mcp || [],
		teams: ["generated"],
		source_proposal: proposal.proposal_id,
		capabilities: manifest.capabilities,
		read_only: false,
	}), { mode: 0o600 });
	fs.writeFileSync(path.join(catalogRoot(), "playbooks", proposal.playbook_id, "current.json"), `${JSON.stringify({ id: proposal.playbook_id, version: proposal.version, path: path.join(versionDir, "playbook.yaml"), promoted_at: now() }, null, 2)}\n`, { mode: 0o600 });
	db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("persistent", now(), proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "proposal_promoted", { version: proposal.version, playbook_path: path.join(versionDir, "playbook.yaml") });
	return { proposal_id: proposal.proposal_id, status: "persistent", playbook_path: path.join(versionDir, "playbook.yaml"), role_path: path.join(roleDir, "role.yaml") };
}

function revise(db, proposal, opts) {
	if (!opts.task?.trim()) throw new Error("yano architect: revise richiede il nuovo --task o feedback incorporato");
	const candidate = candidateForTask(opts.task);
	const capabilities = aggregateCapabilities(candidate.roles, roleConfig());
	const next = { ...proposal, task: opts.task.trim(), base_playbook: candidate.playbook, roles: candidate.roles, version: `0.${Number(String(proposal.version).split(".")[1] || 1) + 1}.0`, playbook_id: `${slug(candidate.playbook)}-${slug(opts.task).slice(0, 24)}`, role_id: `${slug(candidate.playbook)}-specialist` };
	const paths = writeProposalFiles(next, capabilities, candidate);
	db.prepare("UPDATE architect_proposals SET task=?,status=?,version=?,base_playbook=?,playbook_id=?,role_id=?,ephemeral_dir=?,playbook_path=?,manifest_path=?,updated_at=? WHERE proposal_id=?").run(next.task, "revision_required", next.version, next.base_playbook, next.playbook_id, next.role_id, paths.dir, paths.playbook, paths.manifest, now(), proposal.proposal_id);
	db.prepare("DELETE FROM architect_capabilities WHERE proposal_id=?").run(proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "proposal_revised", { version: next.version, task: next.task });
	return db.prepare("SELECT * FROM architect_proposals WHERE proposal_id=?").get(proposal.proposal_id);
}

function usage() {
	return [
		"Uso: yano architect <assess|propose|provision|verify|status|validation|feedback|revise|promote|start>",
		"",
		"  assess --task <testo> --project-root <dir> [--json]              valuta copertura e capability",
		"  propose --task <testo> --project-root <dir> [--json]             crea proposta ephemeral",
		"  provision --proposal-id <id> [--install] [--dry-run] [--once]    prepara e verifica capability",
		"  verify --proposal-id <id> [--json]                              ripete il capability gate",
		"  status --proposal-id <id> [--json]                              mostra proposal, evidenze e readiness",
		"  validation --proposal-id <id> --run-id <id> --result passed|failed",
		"  feedback --proposal-id <id> --status positive|changes_requested|negative --text <testo>",
		"  capability --proposal-id <id> --kind mcp --name <server> --status ready --evidence <prova>",
		"  revise --proposal-id <id> --task <testo>                          genera una nuova revisione ephemeral",
		"  promote --proposal-id <id> --yes                                  pubblica nel catalogo globale",
		"  start --proposal-id <id> [--dry-run] [--once]                     avvia tab Herdr yano-architect",
		"",
		"Il playbook non è operativo con capability mancanti. I dati vivono in temp/architect/ e catalog/.",
	].join("\n");
}

function print(result, machine) { console.log(machine ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2)); }

export async function runYanoArchitect({ argv = [] } = {}) {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { console.log(usage()); return; }
	const opts = {
		sub,
		task: value(argv, "--task"),
		projectRoot: value(argv, "--project-root") || process.cwd(),
		project: value(argv, "--project"),
		proposalId: value(argv, "--proposal-id"),
		runId: value(argv, "--run-id"),
		result: value(argv, "--result"),
		kind: value(argv, "--kind"),
		name: value(argv, "--name"),
		evidence: value(argv, "--evidence"),
		status: value(argv, "--status"),
		text: value(argv, "--text"),
		details: value(argv, "--details") || "",
		actor: value(argv, "--actor") || "planner",
		json: has(argv, "--json"),
		dryRun: has(argv, "--dry-run"),
		once: has(argv, "--once"),
		install: has(argv, "--install"),
		yes: has(argv, "--yes"),
	};
	if (sub === "assess") { const result = assess(opts.task || "", opts.projectRoot, opts.project); print(result, opts.json); return result; }
	const db = openDatabase();
	try {
		if (sub === "propose") { const result = createProposal(db, opts); print(result, opts.json); return result; }
		const proposal = loadProposal(db, opts.proposalId);
		if (sub === "status") { const result = proposalStatus(db, proposal); print(result, opts.json); return result; }
		if (sub === "provision" || sub === "verify") { const result = provision(db, proposal, { dryRun: opts.dryRun, once: opts.once, install: opts.install }); print(result, opts.json); return result; }
		if (sub === "validation") { const result = recordValidation(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "feedback") { const result = recordFeedback(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "capability") { const result = recordCapability(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "revise") { const result = revise(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "promote") { const result = promote(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "start") {
			if (opts.once) { const result = provision(db, proposal, { dryRun: true, once: true, install: false }); const onceResult = { ...result, once: true }; print(onceResult, opts.json); return onceResult; }
			if (proposal.status === "draft") throw new Error("yano architect: esegui prima `yano architect provision --proposal-id ... --install`");
			const result = launchArchitect(db, proposal, { dryRun: opts.dryRun });
			print(result, opts.json); return result;
		}
		throw new Error(`yano architect: comando sconosciuto "${sub}".\n${usage()}`);
	} finally { db.close(); }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) runYanoArchitect({ argv: process.argv.slice(2) }).catch((error) => { console.error(`yano architect: ${error.message}`); process.exit(1); });
