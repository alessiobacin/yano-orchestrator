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
import { loadPlaybook, validatePlaybook } from "./playbook-loader.mjs";
import { configSpec, resolveYanoConfig } from "./yano-config.mjs";
import { projectKey, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ARCHITECT_WORKSPACE = "yano-architect";
const WATCHER_WORKSPACE = "yano-watcher";
const VALID_STATUSES = new Set(["draft", "awaiting_user_input", "provisioning", "ready_ephemeral", "validation_failed", "promotion_candidate", "persistent", "revision_required", "blocked"]);

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
		CREATE TABLE IF NOT EXISTS architect_interviews (
			interview_id TEXT PRIMARY KEY,
			proposal_id TEXT NOT NULL REFERENCES architect_proposals(proposal_id),
			status TEXT NOT NULL,
			questions_json TEXT NOT NULL,
			answers_json TEXT,
			actor TEXT NOT NULL,
			created_at TEXT NOT NULL,
			answered_at TEXT
		);
		CREATE INDEX IF NOT EXISTS architect_interviews_proposal_idx ON architect_interviews(proposal_id, created_at DESC);
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

function knowledgeTeam() {
	return {
		strategy: "planner-selectable",
		default_variant: "full-team",
		roles: [
			{ id: "market-researcher", purpose: "Research market, audience, competitors and evidence without writing final deliverables.", outputs: ["market-research-report", "source-register"], write_scope: ["temp/knowledge/market-research"], capabilities: ["research", "documentation-lookup"] },
			{ id: "seo-strategist", purpose: "Define search intent, keyword opportunities, information architecture and SEO recommendations.", outputs: ["seo-strategy", "keyword-map"], write_scope: ["temp/knowledge/seo"], capabilities: ["research", "documentation-lookup", "copywriting"] },
			{ id: "website-content-strategist", purpose: "Translate research into website positioning, messaging, page structure and content briefs.", outputs: ["website-content-blueprint"], write_scope: ["temp/knowledge/website"], capabilities: ["copywriting", "documentation-writer"] },
			{ id: "business-docs-author", purpose: "Synthesize approved research and strategy into the requested structured Markdown documents.", outputs: ["business-document-set"], write_scope: ["docs"], capabilities: ["documentation-writer", "documentation-lookup", "copywriting"] },
			{ id: "business-docs-reviewer", purpose: "Check factual traceability, consistency, duplication, template compliance and completeness.", outputs: ["documentation-review"], write_scope: ["temp/knowledge/review"], capabilities: ["documentation-writer", "documentation-lookup"] },
		],
		variants: [
			{ id: "single-author", roles: ["business-docs-author"], parallel_groups: [["business-docs-author"]], reason: "One small, well-scoped document with known inputs." },
			{ id: "research-and-author", roles: ["market-researcher", "seo-strategist", "business-docs-author"], parallel_groups: [["market-researcher", "seo-strategist"], ["business-docs-author"]], reason: "Medium task requiring independent market and SEO research before synthesis." },
			{ id: "full-team", roles: ["market-researcher", "seo-strategist", "website-content-strategist", "business-docs-author", "business-docs-reviewer"], parallel_groups: [["market-researcher", "seo-strategist"], ["website-content-strategist"], ["business-docs-author"], ["business-docs-reviewer"]], reason: "Strategic multi-document task with independent research, synthesis and review." },
		],
	};
}

function customTeam() {
	return {
		strategy: "planner-selectable",
		default_variant: "full-team",
		roles: [
			{ id: "specialist-researcher", purpose: "Collect and structure domain evidence for the new reusable capability.", outputs: ["research-report"], write_scope: ["temp/knowledge/research"], capabilities: [] },
			{ id: "specialist-author", purpose: "Produce the reusable domain deliverables from approved evidence.", outputs: ["domain-deliverables"], write_scope: ["docs"], capabilities: [] },
			{ id: "specialist-reviewer", purpose: "Review completeness, consistency and reusability of the generated deliverables.", outputs: ["review-report"], write_scope: ["temp/knowledge/review"], capabilities: [] },
		],
		variants: [
			{ id: "single-author", roles: ["specialist-author"], parallel_groups: [["specialist-author"]], reason: "Small new capability with known inputs." },
			{ id: "full-team", roles: ["specialist-researcher", "specialist-author", "specialist-reviewer"], parallel_groups: [["specialist-researcher"], ["specialist-author"], ["specialist-reviewer"]], reason: "New reusable capability requiring research, authoring and review." },
		],
	};
}

function catalogPlaybooks() {
	const files = [];
	const builtinRoot = path.join(PACKAGE_ROOT, "playbooks");
	if (fs.existsSync(builtinRoot)) for (const file of fs.readdirSync(builtinRoot).filter((entry) => entry.endsWith(".yaml"))) files.push({ source: "builtin", path: path.join(builtinRoot, file) });
	const persistentRoot = path.join(catalogRoot(), "playbooks");
	if (fs.existsSync(persistentRoot)) {
		for (const id of fs.readdirSync(persistentRoot)) {
			const currentPath = path.join(persistentRoot, id, "current.json");
			const pointer = fs.existsSync(currentPath) ? parseJson(fs.readFileSync(currentPath, "utf8"), {}) : {};
			if (pointer.status === "removed") continue;
			const filePath = pointer.path || path.join(persistentRoot, id, `v${pointer.version || "0.1.0"}`, "playbook.yaml");
			if (fs.existsSync(filePath)) files.push({ source: "persistent", path: filePath });
		}
	}
	const result = [];
	for (const entry of files) {
		try {
			const playbook = loadPlaybook(entry.path);
			if (!result.some((item) => item.id === playbook.id)) result.push({ id: playbook.id, label: playbook.label, source: entry.source, path: entry.path, document: playbook });
		} catch { /* invalid catalog entries are ignored by the read-only discovery pass */ }
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

function taskTokens(text) {
	return new Set(String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function catalogCandidates(task, candidate = candidateForTask(task)) {
	const entries = catalogPlaybooks();
	const tokens = taskTokens(task);
	const alternatives = new Set(candidate.catalog_alternatives || []);
	const scored = entries.map((entry) => {
		const intents = entry.document.catalog?.intents || [];
		const intentTokens = new Set(intents.flatMap((intent) => [...taskTokens(intent)]));
		const overlap = [...intentTokens].filter((token) => tokens.has(token)).length;
		let score = overlap * 10;
		if (entry.id === candidate.playbook) score += 100;
		if (alternatives.has(entry.id)) score += 40;
		if (score === 0 && (tokens.has(entry.id) || tokens.has(slug(entry.label)))) score = 20;
		return { id: entry.id, label: entry.label, source: entry.source, path: entry.path, score, requirements: entry.document.requirements || {}, reasons: [entry.id === candidate.playbook ? "candidate_for_task" : null, alternatives.has(entry.id) ? "declared_related_playbook" : null, overlap ? `intent_overlap:${overlap}` : null].filter(Boolean) };
	}).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return scored;
}

function catalogDecision(candidate, task = "") {
	const entries = catalogPlaybooks();
	const exact = entries.find((entry) => entry.id === candidate.playbook) || null;
	const related = (candidate.catalog_alternatives || []).map((id) => entries.find((entry) => entry.id === id)).filter(Boolean);
	const candidates = catalogCandidates(task, candidate);
	return {
		action: exact ? "reuse" : "create",
		exact_match: exact ? { id: exact.id, label: exact.label, source: exact.source, path: exact.path } : null,
		related_matches: related.map((entry) => ({ id: entry.id, label: entry.label, source: entry.source, path: entry.path })),
		candidates,
		recommended: candidates[0] || null,
		selection_required: candidates.length > 1,
		catalog_size: entries.length,
	};
}

function candidateForTask(task) {
	const text = String(task).toLowerCase();
	if (/deploy|release|staging|production|docker|rollout/.test(text)) return { playbook: "deployment-delivery", roles: ["deployment-agent"], reason: "deployment intent" };
	if (/nuovo playbook|crea(?:re)? un playbook|nuova competenza|agente specializzato/.test(text)) return { playbook: "custom-specialization", roles: ["specialist-researcher", "specialist-author", "specialist-reviewer"], primaryRole: "specialist-author", team: customTeam(), capabilities: { skills: [], cli: ["git"], mcp: [] }, reason: "new reusable specialization requested", requires_user_interview: true };
	if (/market research|ricerca di mercato|documenti strategici|documenti business|business documentation|knowledge authoring|authoring|seo|marketing strategy|strategia di marketing|acquisizione clienti|sales strategy/.test(text)) return { playbook: "knowledge-authoring", roles: knowledgeTeam().roles.map((role) => role.id), primaryRole: "business-docs-author", team: knowledgeTeam(), catalog_alternatives: ["documentation-release"], reason: "generic knowledge/business-authoring intent", requires_user_interview: true };
	if (/pulisci (la )?repo|pulizia (della )?repository|ripulisci la repo|riorganizza (i file|la repo)|riordina la repo|reorganize the repo(sitory)?|clean (this|the) repo(sitory)?|clean up (the )?repo(sitory)?|file (che )?non servono più|unused files|rimuovi i file inutilizzati|dangling reference|riferiment[oi] (rott[oi]|non più esistent[ei])|broken reference|documentazione mancante|missing documentation|documentazione (non è |è )?aggiornata|crea (la )?documentazione mancante|repo(sitory)? hygiene/.test(text)) return { playbook: "clean-repo", roles: ["repo-curator", "docs-sync", "reviewer"], reason: "repository cleanup/reorganization/documentation-completeness intent" };
	// Specific intents must win over generic words such as "test",
	// "documentation", or "repository" (which contains the Italian token
	// "sito" when matched without word boundaries).
	if (/\bdebat|dibattit|second opinion|seconda opinione|confronta (le )?prospettive|pro e contro|pros and cons|quale approccio.{0,20}meglio|which approach.{0,20}better|multi-?model discussion|discussione multi-?modello/.test(text)) return { playbook: "debate", roles: ["debater"], reason: "structured multi-model debate intent" };
	if (/get-the-best-from|confronta (questa )?repo(sitory)? con|confronta il progetto con|compare this (repo|project) with|cosa possiamo importare da|cosa possiamo prendere da (un altro progetto|un'altra repo)|benchmark against another repo(sitory)?|confronto con un'altra repo|cosa fa meglio (questo altro progetto|l'altro progetto)|analizza (questo )?repository github e confronta|learn from another repository|ispirati a (questo|un altro) progetto (su )?github/.test(text)) return { playbook: "get-the-best-from", roles: ["repo-benchmarker"], reason: "comparative repository benchmarking intent" };
	if (/refactor|refactoring|architettura|modular|cleanup|manutenibil/.test(text)) return { playbook: "refactor", roles: ["refactoring-specialist", "reviewer"], reason: "pure refactoring intent — no behavior change" };
	if (/document|documenti|documentale|changelog|readme|release notes|architecture documentation/.test(text)) return { playbook: "documentation-release", roles: ["docs-sync"], primaryRole: "docs-sync", reason: "documentation/release intent" };
	if (/(^|[^a-z])(frontend|front-end|ui|ux|browser|responsive|redesign|design system|dashboard|sito|applicazione)([^a-z]|$)/.test(text)) return { playbook: "frontend-browser", roles: ["frontend-developer", "frontend-reviewer"], reason: "frontend/browser intent" };
	if (/controllo qualit|quality gate|self-?check|audit (completo|funzionale)|verifica funzionale|command.?(matrix|audit)|tutti i comandi funzion|tutte le funzionalit|funziona(no)? come dovrebbe|capability audit|full regression audit|command and feature inventory/.test(text)) return { playbook: "qa-full-audit", roles: ["qa-inventory-analyst", "qa-functional-verifier"], primaryRole: "qa-inventory-analyst", catalog_alternatives: ["qa-hardening"], reason: "functional quality gate / full command-and-requirement self-check intent" };
	if (/test|qa|tdd|regression|fuzz|mutation/.test(text)) return { playbook: "qa-hardening", roles: ["tdd-agent", "reviewer"], catalog_alternatives: ["qa-full-audit"], reason: "quality/testing intent" };
	// Fallback: nothing more specific matched. A clear delivery/action verb
	// (implementa, crea, scrivi codice, correggi, ...) still means real work
	// is being requested even though no more specific regex fired, so it
	// keeps the previous "assume coding work" behavior. Genuinely open text
	// (a question, an opinion request, a comparison, a discussion) has no
	// such verb and now defaults to the lightweight conversation playbook
	// instead of silently starting a worktree/team delivery cycle.
	if (/\b(implementa(?:re)?|crea(?:re)?|costrui(?:sci|re)|sviluppa(?:re)?|scrivi(?:ere)?|aggiungi(?:ere)?|correggi(?:ere)?|corregger[ei]|fix(?:a|are)?|risolvi(?:ere)?|elimina(?:re)?|rimuovi(?:ere)?|aggiorna(?:re)?|integra(?:re)?|migra(?:re)?|ottimizza(?:re)?|implement|build|add|create|write)\b/.test(text)) return { playbook: "backend-change", roles: ["coder", "reviewer"], reason: "general implementation fallback" };
	return { playbook: "conversation", roles: [], reason: "no clear delivery/execution intent detected — default to open discussion" };
}

function aggregateCapabilities(roles, configs, declared = {}) {
	const result = { skills: new Set(["yano-planner-trace-analysis"]), cli: new Set(["git"]), mcp: new Set() };
	for (const role of roles) {
		const cfg = configs[role];
		if (!cfg) continue;
		for (const skill of cfg.skills || []) result.skills.add(skill);
		for (const cli of cfg.cli || []) result.cli.add(cli);
		for (const mcp of cfg.mcp || []) result.mcp.add(mcp);
	}
	for (const skill of declared.skills || []) result.skills.add(skill);
	for (const cli of declared.cli || []) result.cli.add(cli);
	for (const mcp of declared.mcp || []) result.mcp.add(mcp);
	return Object.fromEntries(Object.entries(result).map(([key, set]) => [key, [...set].sort()]));
}

function generatedPlaybook({ playbookId, task, candidate, roles, catalog }) {
	return {
		schema_version: 1,
		id: playbookId,
		label: candidate.team ? `Reusable specialization: ${candidate.playbook}` : `Generated task flow: ${candidate.playbook}`,
		description: candidate.team ? `Global reusable playbook for ${candidate.reason}. The project "${task}" is only the originating use case.` : `Ephemeral task-specific contract generated for: ${task}`,
		...(candidate.team ? { catalog: { scope: "global", reusable: true, intents: [candidate.reason], parameters: ["project_name", "project_root", "domain", "audience", "language", "deliverables"] }, team: candidate.team } : {}),
		...(candidate.requirements ? { requirements: candidate.requirements } : {}),
		enforcement: { status: "partial", note: `Derived from ${candidate.playbook}; only the approved task scope is active.` },
		states: [
			{ id: "received", owner: "planner", terminal: false },
			{ id: "provisioning", owner: "architect", terminal: false },
			{ id: "implementing", owner: candidate.primaryRole || roles[0] || "coder", terminal: false },
			{ id: "review", owner: roles[1] || "reviewer", terminal: false },
			{ id: "awaiting_user_feedback", owner: "planner_and_human", terminal: false },
			{ id: "completed", owner: "planner", terminal: true },
			{ id: "blocked", owner: "planner_and_human", terminal: true },
		],
		transitions: [
			{ id: "provision", from: "received", to: "provisioning", actor: "architect", requires: ["proposal_created", "capability_readiness_verified"] },
			{ id: "start_implementation", from: "provisioning", to: "implementing", actor: "planner", requires: ["capability_readiness_verified", "phase_one_unlocked"] },
			{ id: "submit_review", from: "implementing", to: "review", actor: candidate.primaryRole || roles[0] || "coder", requires: ["tests_run", "report_updated"] },
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
			...(candidate.team ? ["catalog_scope_is_global_and_project_agnostic", "planner_selects_one_declared_team_variant", "project_context_is_parameterized_not_embedded"] : []),
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

function writeProposalFiles(proposal, capabilities, candidate, catalog) {
	const paths = proposalPaths(proposal.proposal_id);
	fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	const document = generatedPlaybook({ playbookId: proposal.playbook_id, task: proposal.task, candidate, roles: proposal.roles, catalog });
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
		requirements: document.requirements || {},
		catalog_decision: catalog,
		team: candidate.team || null,
		requires_user_interview: !!candidate.requires_user_interview,
		promotion_policy: { min_successful_runs: 1, min_projects: 1, require_clean_watcher: true, require_user_feedback: true, require_planner_approval: true },
		created_at: proposal.created_at,
	};
	fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	fs.writeFileSync(paths.readiness, `${JSON.stringify({ ready: false, operational: false, status: proposal.status || "draft", checks: [], checked_at: null }, null, 2)}\n`, { mode: 0o600 });
	return paths;
}

function importConflicts(playbook) {
	const conflicts = [];
	for (const entry of catalogPlaybooks()) {
		if (entry.id === playbook.id) conflicts.push({ kind: "same-id", existing: entry.id, source: entry.source, detail: "un playbook con lo stesso id è già nel catalogo" });
		const incomingIntents = new Set((playbook.catalog?.intents || []).map((intent) => slug(intent)));
		const existingIntents = new Set((entry.document.catalog?.intents || []).map((intent) => slug(intent)));
		const overlap = [...incomingIntents].filter((intent) => existingIntents.has(intent));
		if (overlap.length) conflicts.push({ kind: "overlapping-intent", existing: entry.id, source: entry.source, intents: overlap, detail: "gli intent del playbook sono parzialmente sovrapposti" });
	}
	return conflicts;
}

function importedCapabilities(bundle) {
	const result = { skills: new Set(["yano-planner-trace-analysis"]), cli: new Set(["git"]), mcp: new Set() };
	for (const role of bundle.roles || []) {
		for (const key of ["skills", "cli", "mcp"]) for (const value of role[key] || []) result[key].add(value);
	}
	for (const item of bundle.playbook.requirements?.cli || []) result.cli.add(requirementName(item));
	for (const item of bundle.playbook.requirements?.mcp || []) result.mcp.add(requirementName(item));
	return Object.fromEntries(Object.entries(result).map(([key, set]) => [key, [...set].filter(Boolean).sort()]));
}

function readImportBundle(filePath) {
	const origin = path.resolve(filePath || "");
	if (!fs.existsSync(origin)) throw new Error(`yano architect import: bundle non trovato: ${origin}`);
	let bundle;
	try { bundle = JSON.parse(fs.readFileSync(origin, "utf8")); } catch (error) { throw new Error(`yano architect import: JSON non valido: ${error.message}`); }
	if (bundle?.format !== "yano-playbook-bundle" || bundle?.bundle_version !== 1) throw new Error("yano architect import: formato non riconosciuto; usa un bundle esportato da yano playbook export");
	validatePlaybook(bundle.playbook, origin);
	if (!Array.isArray(bundle.roles)) throw new Error("yano architect import: il bundle deve contenere roles[]");
	for (const role of bundle.roles) if (!role || typeof role.id !== "string" || !role.id.trim()) throw new Error("yano architect import: ogni ruolo deve avere un id");
	return { ...bundle, origin: origin };
}

function writeImportedProposalFiles(proposal, bundle, conflicts) {
	const paths = proposalPaths(proposal.proposal_id);
	fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(paths.playbook, YAML.stringify(bundle.playbook), { mode: 0o600 });
	const roleIds = bundle.roles.map((role) => role.id);
	const manifest = {
		schema_version: 1,
		proposal_id: proposal.proposal_id,
		status: "imported_pending_review",
		project: { name: proposal.project_name, root: proposal.project_root, key: proposal.project_key },
		task: proposal.task,
		base_playbook: bundle.playbook.id,
		playbook_id: bundle.playbook.id,
		role_id: roleIds[0] || `${slug(bundle.playbook.id)}-specialist`,
		roles: roleIds,
		role_manifests: bundle.roles,
		capabilities: importedCapabilities(bundle),
		requirements: bundle.playbook.requirements || {},
		import: { origin: bundle.origin, conflicts, imported_at: now() },
		promotion_policy: { min_successful_runs: 1, min_projects: 1, require_clean_watcher: true, require_user_feedback: true, require_planner_approval: true },
		created_at: proposal.created_at,
	};
	loadPlaybook(paths.playbook);
	fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	fs.writeFileSync(paths.readiness, `${JSON.stringify({ ready: false, operational: false, status: proposal.status, checks: [], checked_at: null }, null, 2)}\n`, { mode: 0o600 });
	return { ...paths, manifest_document: manifest };
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

function interviewQuestions(candidate, catalog) {
	const questions = [
		{ id: "reuse_scope", prompt: "Confermi che il playbook deve essere globale, riutilizzabile e indipendente dal progetto che ha originato la richiesta?", options: ["yes", "no"] },
		{ id: "team_mode", prompt: "Preferisci un agente singolo o un team specializzato? Se team, il Planner potrà selezionare una variante per ogni task.", options: ["single", "multi", "planner-decides"] },
		{ id: "quality_tradeoff", prompt: "Quale priorità deve guidare il playbook?", options: ["speed-and-cost", "balanced", "maximum-depth"] },
	];
	if (catalog?.exact_match) questions.unshift({ id: "catalog_action", prompt: `Esiste già il playbook ${catalog.exact_match.id}. Vuoi riusarlo/estenderlo invece di creare un duplicato?`, options: ["reuse", "new-version"] });
	return questions;
}

function createInterview(db, proposalId, candidate, catalog, actor = "architect") {
	const existing = db.prepare("SELECT * FROM architect_interviews WHERE proposal_id=? AND status='open' ORDER BY created_at DESC LIMIT 1").get(proposalId);
	if (existing) return { interview_id: existing.interview_id, status: existing.status, questions: parseJson(existing.questions_json, []) };
	const interviewId = `INT-${crypto.randomUUID()}`;
	const questions = interviewQuestions(candidate, catalog);
	db.prepare("INSERT INTO architect_interviews(interview_id,proposal_id,status,questions_json,answers_json,actor,created_at,answered_at) VALUES(?,?,?,?,?,?,?,?)").run(interviewId, proposalId, "open", JSON.stringify(questions), null, actor, now(), null);
	recordEvent(db, proposalId, "architect_user_interview_opened", { interview_id: interviewId, questions });
	return { interview_id: interviewId, status: "open", questions };
}

function currentInterview(db, proposalId) {
	const row = db.prepare("SELECT * FROM architect_interviews WHERE proposal_id=? ORDER BY created_at DESC LIMIT 1").get(proposalId);
	return row ? { ...row, questions: parseJson(row.questions_json, []), answers: parseJson(row.answers_json, null) } : null;
}

function answerInterview(db, proposal, opts) {
	const interview = db.prepare("SELECT * FROM architect_interviews WHERE proposal_id=? AND status='open' ORDER BY created_at DESC LIMIT 1").get(proposal.proposal_id);
	if (!interview) throw new Error("yano architect: nessuna intervista aperta per questa proposta");
	if (!new Set(["approved", "changes_requested"]).has(opts.status)) throw new Error("yano architect: --status deve essere approved o changes_requested");
	if (!opts.text?.trim() && !opts.answers) throw new Error("yano architect: answer richiede --text oppure --answers JSON");
	const answers = opts.answers ? parseJson(opts.answers, { text: opts.answers }) : { text: opts.text.trim() };
	db.prepare("UPDATE architect_interviews SET status=?,answers_json=?,answered_at=? WHERE interview_id=?").run(opts.status === "approved" ? "answered" : "changes_requested", JSON.stringify(answers), now(), interview.interview_id);
	const next = opts.status === "approved" ? "draft" : "revision_required";
	db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run(next, now(), proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "architect_user_interview_answered", { interview_id: interview.interview_id, status: opts.status, actor: opts.actor || "user" });
	return { proposal_id: proposal.proposal_id, interview_id: interview.interview_id, status: opts.status, next_state: next, answers };
}

function selectTeam(db, proposal, opts) {
	if (proposal.status === "awaiting_user_input") throw new Error("yano architect: il team non è selezionabile finché l’intervista utente è aperta");
	const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {});
	const playbook = loadPlaybook(proposal.playbook_path);
	const team = playbook.team || manifest.team;
	if (!team?.variants?.length) throw new Error(`yano architect: il playbook ${proposal.playbook_id} non dichiara varianti di team`);
	const variant = team.variants.find((item) => item.id === (opts.variant || team.default_variant));
	if (!variant) throw new Error(`yano architect: variante team non trovata: ${opts.variant || team.default_variant}`);
	recordEvent(db, proposal.proposal_id, "team_variant_selected", { variant: variant.id, roles: variant.roles, parallel_groups: variant.parallel_groups || [] });
	return { proposal_id: proposal.proposal_id, playbook_id: playbook.id, strategy: team.strategy, variant: variant.id, roles: variant.roles, parallel_groups: variant.parallel_groups || [], reason: variant.reason || null };
}

function skillCandidates(name) {
	return [
		// Shared skills shipped at the package root are part of Yano itself;
		// they are not expected to be copied into the user's skill catalog.
		path.join(PACKAGE_ROOT, name, "SKILL.md"),
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

function requirementName(item) { return typeof item === "string" ? item : item?.name; }
function credentialName(item) { return typeof item === "string" ? item : item?.key; }

function verifyCredential(item) {
	const name = credentialName(item);
	const spec = configSpec(name);
	const configured = resolveYanoConfig({ packageRoot: PACKAGE_ROOT })[name];
	if (configured && String(configured).trim() && !/^<(your|set|insert)|changeme|replace[-_ ]?me$/i.test(String(configured).trim())) {
		return { status: "ready", source: "yano-global-config-or-environment", detail: spec?.secret ? "valorizzata (segreto non esposto)" : "valorizzata" };
	}
	return {
		status: "missing",
		detail: `${name} non è valorizzata nella configurazione globale di Yano`,
		install_command: spec?.secret ? `yano config set ${name} --stdin` : `yano config set ${name} <valore>`,
		configure_at: "yano config path",
	};
}

function checkCapabilities(proposal, db = null) {
	const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {});
	const capabilities = manifest.capabilities || {};
	const requirements = manifest.requirements || {};
	const checks = [];
	const seen = new Set();
	const add = (check) => { const key = `${check.kind}:${check.name}`; if (!seen.has(key)) { seen.add(key); checks.push(check); } };
	for (const name of capabilities.skills || []) add({ kind: "skill", name, ...verifySkill(name) });
	for (const name of capabilities.cli || []) add({ kind: "cli", name, ...verifyCli(name) });
	for (const item of requirements.cli || []) add({ kind: "cli", name: requirementName(item), ...verifyCli(requirementName(item)) });
	for (const item of [...(capabilities.mcp || []), ...(requirements.mcp || [])]) {
		const name = requirementName(item);
		const recorded = db?.prepare("SELECT status,source,detail,checked_at FROM architect_capabilities WHERE proposal_id=? AND kind='mcp' AND name=?").get(proposal.proposal_id, name);
		if (recorded?.status === "ready" && String(recorded.detail || "").startsWith("verified by ")) add({ kind: "mcp", name, status: "ready", source: recorded.source, detail: recorded.detail, checked_at: recorded.checked_at });
		else add({ kind: "mcp", name, ...verifyMcp(name, proposal.project_root) });
		for (const credential of item && typeof item === "object" ? (item.credentials || []) : []) add({ kind: "credential", name: credentialName(credential), ...verifyCredential(credential) });
	}
	for (const credential of requirements.credentials || []) add({ kind: "credential", name: credentialName(credential), ...verifyCredential(credential) });
	return checks;
}

function persistChecks(db, proposalId, checks) {
	const timestamp = now();
	for (const check of checks) db.prepare("INSERT INTO architect_capabilities(proposal_id,kind,name,status,source,version,detail,install_command,checked_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(proposal_id,kind,name) DO UPDATE SET status=excluded.status,source=excluded.source,version=excluded.version,detail=excluded.detail,install_command=excluded.install_command,checked_at=excluded.checked_at").run(proposalId, check.kind, check.name, check.status, check.source || null, check.version || null, check.detail || null, check.install_command || null, timestamp);
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 32_000_000 });
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

// The Herdr workspace identifies the worker class; the Pi/Herdr instance
// identifies the project-specific worker. Keep this identity deterministic so
// a proposal id (which is ephemeral) can never leak into a visible tab name.
function canonicalExternalInstance(role, projectName) {
	const prefix = role === "architect" ? "architect" : role === "watcher" ? "watcher" : role;
	return `${prefix}-${slug(projectName)}`;
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
	const matches = (item) => {
		if (["done", "unknown", "offline"].includes(item.agent_status)) return false;
		return [item.name, item.terminal_title_stripped, item.terminal_title]
			.some((candidate) => candidate === instance || candidate === agentName);
	};
	const registered = (snapshot?.agents || []).find(matches);
	if (registered) return registered;
	// Some Herdr snapshots expose the live Pi identity only on the pane
	// (terminal title/agent), not in the top-level agents array. Use that
	// identity too, otherwise a retry can create a duplicate external tab.
	return (snapshot?.panes || []).find((item) => item.agent === "pi" && matches(item));
}

function activeHerdrAgentOnPane(snapshot, paneId) {
	const pane = (snapshot?.panes || []).find((item) => item.pane_id === paneId);
	if (pane?.agent && !["done", "unknown", "offline"].includes(pane.agent_status)) return pane;
	return (snapshot?.agents || []).find((item) => item.pane_id === paneId && !["done", "unknown", "offline"].includes(item.agent_status));
}

function samePath(left, right) {
	if (!left || !right) return false;
	try { return fs.realpathSync(left) === fs.realpathSync(right); }
	catch { return path.resolve(left) === path.resolve(right); }
}

function externalRoleFromIdentity(identity) {
	const text = String(identity || "").toLowerCase();
	if (text.includes("architect")) return "architect";
	if (text.includes("yano-watcher") || text.startsWith("watcher")) return "watcher";
	return null;
}

function activeLegacyExternalAgent(snapshot, { role, instance, agentName, cwd, workspaceId }) {
	const panesById = new Map((snapshot?.panes || []).map((pane) => [pane.pane_id, pane]));
	const candidates = [
		...(snapshot?.agents || []).map((agent) => ({ ...panesById.get(agent.pane_id), ...agent })),
		...(snapshot?.panes || []),
	];
	return candidates.find((candidate) => {
		if (candidate.agent !== "pi" || ["done", "unknown", "offline"].includes(candidate.agent_status)) return false;
		if (workspaceId && candidate.workspace_id && candidate.workspace_id !== workspaceId) return false;
		// A top-level Herdr agent card without cwd is not enough evidence for a
		// cross-project legacy match; require the pane/process scope as well.
		if (cwd && (!candidate.cwd || !samePath(candidate.cwd, cwd))) return false;
		const identities = [candidate.name, candidate.terminal_title_stripped, candidate.terminal_title, candidate.agent_instance, candidate.label].filter(Boolean).map(String);
		const isExpected = identities.some((identity) => identity === instance || identity === agentName);
		return !isExpected && identities.some((identity) => externalRoleFromIdentity(identity) === role);
	});
}

function closeLegacyExternalTabs({ role, projectRoot, workspaceId, canonicalTabId, dryRun }) {
	const snapshot = herdrSnapshot();
	if (!snapshot || !workspaceId) return { closed: [], candidates: [], skipped: "herdr_unavailable" };
	const agentsByPane = new Map((snapshot.agents || []).map((agent) => [agent.pane_id, agent]));
	const tabs = (snapshot.tabs || []).filter((tab) => tab.workspace_id === workspaceId && tab.tab_id !== canonicalTabId);
	const candidates = tabs.filter((tab) => {
		// Herdr may expose identity/status on `agents` and cwd/labels on `panes`.
		// Merge both views before deciding whether a tab is safe to close.
		const panes = (snapshot.panes || [])
			.filter((pane) => pane.tab_id === tab.tab_id)
			.map((pane) => ({ ...pane, ...(agentsByPane.get(pane.pane_id) || {}) }));
		if (!panes.some((pane) => pane.cwd && samePath(pane.cwd, projectRoot))) return false;
		const identities = [tab.label, ...panes.flatMap((pane) => [pane.name, pane.label, pane.terminal_title_stripped, pane.terminal_title, pane.agent_instance])]
			.filter(Boolean).map(String);
		if (!identities.some((identity) => externalRoleFromIdentity(identity) === role)) return false;
		// Never close a tab that still has a live agent. Repair can restart it
		// first, after which the next provisioning pass may clean it up.
		return !panes.some((pane) => pane.agent === "pi" && !["done", "unknown", "offline"].includes(pane.agent_status));
	});
	if (dryRun) return { closed: [], candidates: candidates.map((tab) => tab.tab_id), dry_run: true };
	const closed = [];
	for (const tab of candidates) {
		const result = spawnSync("herdr", ["tab", "close", tab.tab_id], { encoding: "utf8" });
		if (result.status === 0) closed.push(tab.tab_id);
	}
	return { closed, candidates: candidates.map((tab) => tab.tab_id), dry_run: false };
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
	// A previous release may still have a live project-scoped Architect or
	// Watcher under its old instance. Never create a second worker in that
	// case: repair performs the controlled stop/restart and applies the
	// canonical identity without interrupting work implicitly here.
	const legacy = ["architect", "watcher"].includes(role)
		? activeLegacyExternalAgent(refreshed, { role, instance, agentName, cwd, workspaceId })
		: null;
	if (legacy) {
		const oldName = legacy.name || legacy.terminal_title_stripped || legacy.terminal_title || "istanza legacy";
		throw new Error(`yano architect: ${role} legacy ${oldName} già attivo per questo progetto; nessun duplicato creato. Esegui "yano repair --yes" per riallinearlo a ${instance}.`);
	}
	let tab = refreshed?.tabs?.find((item) => item.workspace_id === workspaceId && item.label === label);
	let pane = tab && refreshed?.panes?.find((item) => item.tab_id === tab.tab_id);
	if (pane?.cwd && !fs.existsSync(pane.cwd)) {
		tab = null;
		pane = null;
	}
	// A stale tab label can point to a pane now occupied by another agent
	// (for example Planner accidentally left in yano-watcher). Never reuse
	// that pane: look for a genuinely blank pane or create a new tab.
	if (pane && activeHerdrAgentOnPane(refreshed, pane.pane_id)) {
		tab = null;
		pane = null;
	}
	// A pane without a live agent is not enough evidence that Herdr can accept
	// an agent start. Retained/old panes are reported as `unknown`, `done` or
	// `offline` but can still be unavailable shells (the exact failure seen when
	// provisioning tried to reuse wN:pD after the previous watcher exited).
	// Keep those panes untouched and create a fresh Herdr tab instead.
	if (pane && (!pane.agent || ["unknown", "offline", "done", "completed"].includes(String(pane.agent_status || "").toLowerCase()))) {
		tab = null;
		pane = null;
	}
	if (!tab) {
		const createLabel = `${label}-new-${Date.now().toString(36)}`.slice(0, 60);
		const created = spawnSync("herdr", ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", createLabel, "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) throw new Error(`yano architect: tab Herdr ${label} non creata${created.stderr ? `: ${created.stderr.trim()}` : ""}`);
		const next = herdrSnapshot();
		tab = next?.tabs?.find((item) => item.workspace_id === workspaceId && item.label === createLabel);
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
		// Herdr requires --wait whenever --timeout is supplied. Wait only until
		// the agent becomes active: waiting for the whole LLM turn would make
		// provisioning look hung and could prevent the registry from being
		// updated when the prompt was already accepted.
		const prompted = spawnSync("herdr", ["agent", "prompt", agentName, initialPrompt, "--wait", "--until", "working", "--timeout", "120000"], { cwd, encoding: "utf8", maxBuffer: 2_000_000 });
		if (prompted.status !== 0) throw new Error(`yano architect: prompt iniziale non consegnato all'agente Herdr ${agentName}${prompted.stderr ? `: ${prompted.stderr.trim()}` : (prompted.stdout ? `: ${prompted.stdout.trim()}` : "")}`);
	}
	return { workspace_id: workspaceId, tab_id: tab.tab_id, pane_id: pane.pane_id, label, command, instance, agent_kind: "pi", herdr_agent_name: agentName, started: true, dry_run: false };
}

function launchArchitect(db, proposal, { dryRun = false } = {}) {
	const workspaceRoot = path.join(dataRoot(), "agent-workspaces", ARCHITECT_WORKSPACE);
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	// Do not reuse architect_instance from legacy proposals: old versions used
	// architect-prop-<id>, which made Herdr display the proposal id instead of
	// the required architect-<project> identity.
	const instance = canonicalExternalInstance("architect", proposal.project_name);
	const prompt = `Gestisci la proposta ${proposal.proposal_id} in modo controllato. Leggi ${proposal.manifest_path} e ${proposal.playbook_path}. Verifica/installare solo le capability dichiarate e autorizzate. Non modificare mai il progetto ${proposal.project_root}. Usa yano architect verify --proposal-id ${proposal.proposal_id} dopo il provisioning. Il playbook può diventare operativo solo con readiness completa.`;
	const workspace = ensureWorkspace(ARCHITECT_WORKSPACE, workspaceRoot, dryRun);
	const label = `architect-${slug(proposal.project_name)}`.slice(0, 60);
	const launched = launchAgentTab({ label, cwd: proposal.project_root, workspaceId: workspace.workspace.workspace_id, instance, role: "architect", project: proposal.project_name, prompt, dryRun });
	const cleanup = closeLegacyExternalTabs({ role: "architect", projectRoot: proposal.project_root, workspaceId: launched.workspace_id, canonicalTabId: launched.tab_id, dryRun });
	const timestamp = now();
	db.prepare("UPDATE architect_proposals SET workspace_id=?,tab_id=?,pane_id=?,architect_instance=?,updated_at=? WHERE proposal_id=?").run(launched.workspace_id, launched.tab_id, launched.pane_id, instance, timestamp, proposal.proposal_id);
	return { ...launched, instance, workspace_label: ARCHITECT_WORKSPACE, legacy_tabs: cleanup };
}

function launchValidationWatcher(db, proposal, { dryRun = false } = {}) {
	const workspaceRoot = path.join(dataRoot(), "agent-workspaces", WATCHER_WORKSPACE);
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const runId = proposal.validation_run_id || `validation-${proposal.proposal_id}`;
	const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {});
	const playbookChecksum = fs.existsSync(proposal.playbook_path) ? crypto.createHash("sha256").update(fs.readFileSync(proposal.playbook_path)).digest("hex") : "";
	const instance = canonicalExternalInstance("watcher", proposal.project_name);
	const validationCommand = `yano watch --once --project-root ${safeShell(proposal.project_root)} --project ${safeShell(proposal.project_name)} --validation-run ${safeShell(runId)} --playbook-proposal ${safeShell(proposal.proposal_id)} --playbook-id ${safeShell(manifest.playbook_id || proposal.playbook_id)} --playbook-checksum ${safeShell(playbookChecksum)}`;
	const continuousCommand = `yano watch --project-root ${safeShell(proposal.project_root)} --project ${safeShell(proposal.project_name)} --lookback-ms 3600000 --interval-ms 600000 --away`;
	const prompt = `Valida il round del playbook ${proposal.proposal_id} per il progetto ${proposal.project_root} in modo esclusivamente read-only. Esegui prima una sola scansione bounded con ${validationCommand}, poi avvia e lascia attivo il controllo continuo con ${continuousCommand}: il secondo comando deve restare in esecuzione e controllare il workflow ogni 10 minuti, non terminare dopo la prima scansione. Usa il trace e i segnali MQTT per rilevare ticket stalled, agenti assenti, scope errati, errori dei tool interni e deviazioni osservabili; comunica al planner gli esiti con evidenze. Non modificare mai il progetto, non promuovere il playbook e non eseguire fix. Non usare mai find /, scansioni dell'intero filesystem o comandi senza timeout: limita ogni lettura alla root del progetto e ai percorsi Yano esplicitamente indicati.`;
	const workspace = ensureWorkspace(WATCHER_WORKSPACE, workspaceRoot, dryRun);
	const label = `watcher-${slug(proposal.project_name)}`.slice(0, 60);
	const launched = launchAgentTab({ label, cwd: proposal.project_root, workspaceId: workspace.workspace.workspace_id, instance, role: "watcher", project: proposal.project_name, prompt, dryRun });
	const cleanup = closeLegacyExternalTabs({ role: "watcher", projectRoot: proposal.project_root, workspaceId: launched.workspace_id, canonicalTabId: launched.tab_id, dryRun });
	db.prepare("UPDATE architect_proposals SET watcher_workspace_id=?,watcher_tab_id=?,watcher_pane_id=?,validation_run_id=?,updated_at=? WHERE proposal_id=?").run(launched.workspace_id, launched.tab_id, launched.pane_id, runId, now(), proposal.proposal_id);
	return { ...launched, run_id: runId, workspace_label: WATCHER_WORKSPACE, legacy_tabs: cleanup };
}

function assess(task, projectRoot, explicitProject) {
	const info = projectInfo(projectRoot, explicitProject);
	const candidate = candidateForTask(task);
	const configs = roleConfig();
	const roles = candidate.roles.filter((role) => configs[role]);
	const capabilityRoles = roles.length ? roles : (candidate.team ? [] : ["coder", "reviewer"]);
	const capabilities = aggregateCapabilities(capabilityRoles, configs, candidate.capabilities);
	const catalog = catalogDecision(candidate, task);
	return { task, project: info, candidate_playbook: candidate.playbook, candidate_reason: candidate.reason, roles: candidate.roles, capabilities, requirements: candidate.requirements || {}, team: candidate.team || null, catalog, playbook_selection: { recommended: catalog.recommended, options: catalog.candidates, user_choice_required: catalog.selection_required }, needs_new_playbook: catalog.action === "create", requires_user_interview: catalog.action === "create" && !!candidate.requires_user_interview, note: "Un playbook nuovo è globale ed ephemeral finché intervista, readiness, validazione watcher e feedback utente non sono positivi." };
}

function createProposal(db, opts) {
	if (!opts.task?.trim()) throw new Error("yano architect: --task è obbligatorio");
	const info = projectInfo(opts.projectRoot, opts.project);
	const assessment = assess(opts.task, opts.projectRoot, opts.project);
	const candidate = candidateForTask(opts.task);
	if (assessment.catalog.action === "reuse" && !opts.newPlaybook) {
		return { reused: true, decision: "reuse", playbook: assessment.catalog.exact_match, assessment, no_project_mutation: true, message: `Playbook ${assessment.catalog.exact_match.id} già presente nel catalogo globale: nessuna copia specifica del progetto viene creata.` };
	}
	const timestamp = now();
	const proposalId = `PROP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	const base = slug(candidate.playbook);
	// A team proposal is a reusable catalog candidate, never a project/task slug.
	// Non-team flows remain task-scoped because they are ordinary ephemeral
	// implementation contracts rather than reusable playbooks.
	const playbookId = candidate.team ? base : `${base}-${slug(opts.task).slice(0, 24)}`;
	const roleId = candidate.primaryRole || `${slug(base)}-specialist`;
	const capabilities = assessment.capabilities;
	const status = assessment.catalog.action === "create" || opts.newPlaybook ? "awaiting_user_input" : "draft";
	const provisional = { proposal_id: proposalId, project_key: info.key, project_root: info.root, project_name: info.name, task: opts.task.trim(), status, version: "0.1.0", base_playbook: candidate.playbook, playbook_id: playbookId, role_id: roleId, roles: assessment.roles, created_at: timestamp };
	const paths = writeProposalFiles(provisional, capabilities, candidate, assessment.catalog);
	db.prepare("INSERT INTO architect_proposals(proposal_id,project_key,project_root,project_name,task,status,version,base_playbook,playbook_id,role_id,ephemeral_dir,playbook_path,manifest_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(proposalId, info.key, info.root, info.name, opts.task.trim(), status, "0.1.0", candidate.playbook, playbookId, roleId, paths.dir, paths.playbook, paths.manifest, timestamp, timestamp);
	const interview = status === "awaiting_user_input" ? createInterview(db, proposalId, candidate, assessment.catalog) : null;
	recordEvent(db, proposalId, "proposal_created", { base_playbook: candidate.playbook, roles: assessment.roles, capabilities, catalog: assessment.catalog, requires_user_interview: !!interview });
	return { proposal: db.prepare("SELECT * FROM architect_proposals WHERE proposal_id=?").get(proposalId), assessment, paths, interview };
}

function createImport(db, opts) {
	const bundle = readImportBundle(opts.file);
	const importedId = bundle.playbook.id;
	const projectRoot = dataRoot();
	const projectName = "yano-global";
	const projectKeyValue = projectKey(projectRoot, projectName);
	const proposalId = `IMPORT-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	const timestamp = now();
	const conflicts = importConflicts(bundle.playbook);
	const roleIds = bundle.roles.map((role) => role.id);
	const provisional = { proposal_id: proposalId, project_key: projectKeyValue, project_root: projectRoot, project_name: projectName, task: `Importa playbook globale ${importedId}`, status: "awaiting_user_input", version: String(bundle.playbook.schema_version || 1) === "1" ? "1.0.0" : `1.0.0`, base_playbook: importedId, playbook_id: importedId, role_id: roleIds[0] || `${slug(importedId)}-specialist`, roles: roleIds, created_at: timestamp };
	const paths = writeImportedProposalFiles(provisional, bundle, conflicts);
	db.prepare("INSERT INTO architect_proposals(proposal_id,project_key,project_root,project_name,task,status,version,base_playbook,playbook_id,role_id,ephemeral_dir,playbook_path,manifest_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(proposalId, projectKeyValue, projectRoot, projectName, provisional.task, provisional.status, provisional.version, importedId, importedId, provisional.role_id, paths.dir, paths.playbook, paths.manifest, timestamp, timestamp);
	const proposal = db.prepare("SELECT * FROM architect_proposals WHERE proposal_id=?").get(proposalId);
	const checks = checkCapabilities(proposal, db);
	persistChecks(db, proposalId, checks);
	const sameIdConflict = conflicts.find((item) => item.kind === "same-id");
	const interview = createInterview(db, proposalId, { ...candidateForTask("crea un nuovo playbook"), requires_user_interview: true }, { exact_match: sameIdConflict ? { id: sameIdConflict.existing, label: sameIdConflict.existing, source: sameIdConflict.source } : null, related_matches: conflicts.filter((item) => item.kind === "overlapping-intent") });
	recordEvent(db, proposalId, "playbook_import_staged", { origin: bundle.origin, conflicts, checks });
	const result = { proposal, paths, conflicts, checks, requirements: bundle.playbook.requirements || {}, requires_user_decision: true, architect_required: true, no_reference_project_mutation: true };
	if (!opts.dryRun && !opts.once) {
		try {
			result.architect = launchArchitect(db, proposal, { dryRun: false });
			db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("awaiting_user_input", now(), proposalId);
		} catch (error) {
			result.architect_launch_error = error instanceof Error ? error.message : String(error);
			recordEvent(db, proposalId, "external_agent_launch_failed", { error: result.architect_launch_error });
		}
	}
	result.interview = interview;
	return result;
}

function provision(db, proposal, { dryRun = false, once = false, install = false } = {}) {
	if (proposal.status === "awaiting_user_input") {
		const interview = currentInterview(db, proposal.proposal_id);
		return { proposal_id: proposal.proposal_id, status: "awaiting_user_input", ready: false, operational: false, reason: "awaiting_user_input", interview, no_project_mutation: true };
	}
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
		// Launch the two external roles independently. A stale/busy Watcher
		// pane must not prevent Architect from starting and repairing the
		// proposal. The proposal remains blocked until both launches succeed.
		const launchErrors = [];
		try { result.watcher = launchValidationWatcher(db, { ...proposal, status }, { dryRun }); }
		catch (error) { result.watcher_launch_error = error instanceof Error ? error.message : String(error); launchErrors.push(`watcher: ${result.watcher_launch_error}`); }
		try { result.architect = launchArchitect(db, { ...proposal, status }, { dryRun }); }
		catch (error) { result.architect_launch_error = error instanceof Error ? error.message : String(error); launchErrors.push(`architect: ${result.architect_launch_error}`); }
		const watcherStarted = result.watcher && (result.watcher.started === true || result.watcher.already_running === true);
		const architectStarted = result.architect && (result.architect.started === true || result.architect.already_running === true);
		if (watcherStarted && architectStarted && launchErrors.length === 0) {
			db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("ready_ephemeral", now(), proposal.proposal_id);
		} else {
			result.status = "blocked";
			result.ready = false;
			result.operational = false;
			result.launch_error = launchErrors.join("; ") || "Watcher e Architect non risultano entrambi attivi dopo il provisioning";
			db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("blocked", now(), proposal.proposal_id);
			recordEvent(db, proposal.proposal_id, "external_agent_launch_failed", { error: result.launch_error, watcher: result.watcher || null, architect: result.architect || null });
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
	const interviews = db.prepare("SELECT * FROM architect_interviews WHERE proposal_id=? ORDER BY created_at DESC").all(proposal.proposal_id).map((row) => ({ ...row, questions: parseJson(row.questions_json, []), answers: parseJson(row.answers_json, null) }));
	return { proposal, capabilities, validations, feedback, interviews, events, db_path: dbPath(), data_root: dataRoot(), catalog_root: catalogRoot() };
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
	if (!checks.length || checks.some((check) => check.status !== "ready")) {
		const status = db.prepare("SELECT kind,name,status,detail,install_command FROM architect_capabilities WHERE proposal_id=? AND status!='ready' ORDER BY kind,name").all(proposal.proposal_id);
		const lines = status.map((check) => `- ${check.kind}/${check.name}: ${check.detail || check.status}${check.install_command ? `; soluzione: ${check.install_command}` : ""}`).join("\n");
		throw new Error(`yano architect: il playbook non può essere installato/promosso perché mancano requisiti:\n${lines}\nRipeti yano architect verify dopo averli configurati.`);
	}
	if (!validations.length) throw new Error("yano architect: serve almeno una validation passed");
	if (!feedback.length) throw new Error("yano architect: serve feedback utente positivo");
	const versionDir = path.join(catalogRoot(), "playbooks", proposal.playbook_id, `v${proposal.version}`);
	fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
	fs.copyFileSync(proposal.playbook_path, path.join(versionDir, "playbook.yaml"));
	const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {});
	manifest.status = "persistent";
	manifest.promoted_at = now();
	manifest.validation_ids = validations.map((row) => row.validation_id);
	manifest.feedback_ids = feedback.map((row) => row.feedback_id);
	fs.writeFileSync(path.join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	const roleManifests = Array.isArray(manifest.role_manifests) && manifest.role_manifests.length
		? manifest.role_manifests
		: [{
			id: proposal.role_id,
			label: `Generated ${proposal.role_id}`,
			brief: `Specialist generated by Yano Architect for proposal ${proposal.proposal_id}. Follow the assigned playbook and report evidence to the planner.`,
			activation: "lazy",
			playbook: proposal.playbook_id,
			model: { provider: "llmproxy", model: "llmproxy" },
			skills: manifest.capabilities?.skills || [],
			cli: manifest.capabilities?.cli || [],
			mcp: manifest.capabilities?.mcp || [],
			teams: ["generated"],
			source_proposal: proposal.proposal_id,
			capabilities: manifest.capabilities,
			read_only: false,
		}];
	const rolePaths = [];
	for (const role of roleManifests) {
		const roleId = role.id;
		const roleDir = path.join(catalogRoot(), "agents", roleId, `v${proposal.version}`);
		fs.mkdirSync(roleDir, { recursive: true, mode: 0o700 });
		const roleDocument = { ...role, playbook: proposal.playbook_id, source_proposal: proposal.proposal_id };
		fs.writeFileSync(path.join(roleDir, "role.yaml"), YAML.stringify(roleDocument), { mode: 0o600 });
		rolePaths.push(path.join(roleDir, "role.yaml"));
	}
	fs.writeFileSync(path.join(catalogRoot(), "playbooks", proposal.playbook_id, "current.json"), `${JSON.stringify({ id: proposal.playbook_id, version: proposal.version, path: path.join(versionDir, "playbook.yaml"), promoted_at: now() }, null, 2)}\n`, { mode: 0o600 });
	db.prepare("UPDATE architect_proposals SET status=?,updated_at=? WHERE proposal_id=?").run("persistent", now(), proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "proposal_promoted", { version: proposal.version, playbook_path: path.join(versionDir, "playbook.yaml") });
	return { proposal_id: proposal.proposal_id, status: "persistent", playbook_path: path.join(versionDir, "playbook.yaml"), role_path: rolePaths[0], role_paths: rolePaths };
}

function revise(db, proposal, opts) {
	if (!opts.task?.trim()) throw new Error("yano architect: revise richiede il nuovo --task o feedback incorporato");
	const candidate = candidateForTask(opts.task);
	const configs = roleConfig();
	const capabilities = aggregateCapabilities(candidate.roles.filter((role) => configs[role]), configs, candidate.capabilities);
	const catalog = catalogDecision(candidate, opts.task);
	const nextStatus = candidate.team ? "awaiting_user_input" : "revision_required";
	const next = { ...proposal, task: opts.task.trim(), status: nextStatus, base_playbook: candidate.playbook, roles: candidate.roles, version: `0.${Number(String(proposal.version).split(".")[1] || 1) + 1}.0`, playbook_id: candidate.team ? slug(candidate.playbook) : `${slug(candidate.playbook)}-${slug(opts.task).slice(0, 24)}`, role_id: candidate.primaryRole || `${slug(candidate.playbook)}-specialist` };
	const paths = writeProposalFiles(next, capabilities, candidate, catalog);
	db.prepare("UPDATE architect_proposals SET task=?,status=?,version=?,base_playbook=?,playbook_id=?,role_id=?,ephemeral_dir=?,playbook_path=?,manifest_path=?,updated_at=? WHERE proposal_id=?").run(next.task, next.status, next.version, next.base_playbook, next.playbook_id, next.role_id, paths.dir, paths.playbook, paths.manifest, now(), proposal.proposal_id);
	db.prepare("DELETE FROM architect_capabilities WHERE proposal_id=?").run(proposal.proposal_id);
	recordEvent(db, proposal.proposal_id, "proposal_revised", { version: next.version, task: next.task });
	if (nextStatus === "awaiting_user_input") createInterview(db, proposal.proposal_id, candidate, catalog);
	return db.prepare("SELECT * FROM architect_proposals WHERE proposal_id=?").get(proposal.proposal_id);
}

function usage() {
	return [
		"Uso: yano architect <assess|candidates|propose|import|interview|answer|team|provision|verify|status|validation|feedback|revise|promote|start>",
		"",
		"  assess --task <testo> --project-root <dir> [--json]              valuta copertura e capability",
		"  candidates --task <testo> --project-root <dir> [--json]          elenca alternative e raccomandazione",
		"  propose --task <testo> --project-root <dir> [--new-playbook]    riusa il catalogo o crea una proposta globale",
		"  import --file <bundle.json> [--dry-run|--once]                   importa e avvia Architect per la verifica",
		"  interview --proposal-id <id> [--json]                           apre/mostra domande all utente",
		"  answer --proposal-id <id> --status approved|changes_requested   registra la decisione dell utente",
		"  team --proposal-id <id> --variant <id> [--json]                 seleziona una variante del team",
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
		"Il playbook non è operativo con capability mancanti. I dati vivono in <YANO_DATA_DIR>/architect/ e <YANO_DATA_DIR>/catalog/.",
	].join("\n");
}

function print(result, machine) { console.log(machine ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2)); }

export async function runYanoArchitect({ argv = [] } = {}) {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { console.log(usage()); return; }
	const opts = {
		sub,
		task: value(argv, "--task"),
		file: value(argv, "--file") || (sub === "import" ? argv[1] : null),
		projectRoot: value(argv, "--project-root") || process.cwd(),
		project: value(argv, "--project"),
		proposalId: value(argv, "--proposal-id"),
		variant: value(argv, "--variant"),
		answers: value(argv, "--answers"),
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
		newPlaybook: has(argv, "--new-playbook"),
		yes: has(argv, "--yes"),
	};
	if (sub === "assess") { const result = assess(opts.task || "", opts.projectRoot, opts.project); print(result, opts.json); return result; }
	if (sub === "candidates") { const result = assess(opts.task || "", opts.projectRoot, opts.project); print({ task: result.task, project: result.project, recommended: result.playbook_selection.recommended, candidates: result.playbook_selection.options, user_choice_required: result.playbook_selection.user_choice_required }, opts.json); return result; }
	const db = openDatabase();
	try {
		if (sub === "propose") { const result = createProposal(db, opts); print(result, opts.json); return result; }
		if (sub === "import") { const result = createImport(db, opts); print(result, opts.json); return result; }
		const proposal = loadProposal(db, opts.proposalId);
		if (sub === "status") { const result = proposalStatus(db, proposal); print(result, opts.json); return result; }
		if (sub === "interview") { const manifest = parseJson(fs.readFileSync(proposal.manifest_path, "utf8"), {}); const result = createInterview(db, proposal.proposal_id, candidateForTask(proposal.task), manifest.catalog_decision || {}); print(result, opts.json); return result; }
		if (sub === "answer") { const result = answerInterview(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "team") { const result = selectTeam(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "provision" || sub === "verify") { const result = provision(db, proposal, { dryRun: opts.dryRun, once: opts.once, install: opts.install }); print(result, opts.json); return result; }
		if (sub === "validation") { const result = recordValidation(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "feedback") { const result = recordFeedback(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "capability") { const result = recordCapability(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "revise") { const result = revise(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "promote") { const result = promote(db, proposal, opts); print(result, opts.json); return result; }
		if (sub === "start") {
			if (proposal.status === "awaiting_user_input") throw new Error("yano architect: la proposta è in attesa dell’intervista utente; esegui `yano architect answer --proposal-id ... --status approved --text ...` prima dello start");
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
