#!/usr/bin/env node

// Inventory read-only degli agenti Yano che vivono fuori dal workspace del
// progetto. Herdr è la fonte di verità per l'attività runtime; i registri
// globali aggiungono il contesto dei progetti configurati ma offline.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { projectKey, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";

const require = createRequire(import.meta.url);
const ROLES = new Set(["architect", "watcher", "debugger", "auto-improver", "suggester"]);
const TERMINAL_WORKER_STATES = new Set(["", "stopped", "paused", "rejected", "completed", "done", "blocked", "offline"]);

function has(argv, flag) { return argv.includes(flag); }
function value(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
function slug(valueToSlug) {
	return String(valueToSlug || "project").toLowerCase().normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}
function canonicalRoot(root) {
	try { return fs.realpathSync(root); } catch { return path.resolve(root || "."); }
}
function workerIsConfigured(status) { return !TERMINAL_WORKER_STATES.has(String(status || "").toLowerCase()); }
function isLiveStatus(status) { return !new Set(["", "unknown", "offline", "done", "completed", "stopped", "paused", "rejected", "blocked"]).has(String(status || "").toLowerCase()); }

function sqliteClass() {
	try { return process.getBuiltinModule?.("node:sqlite")?.DatabaseSync || require("node:sqlite").DatabaseSync; }
	catch { return null; }
}

function readRows(file, table) {
	const DatabaseSync = sqliteClass();
	if (!DatabaseSync || !file || !fs.existsSync(file)) return [];
	let db = null;
	try {
		db = new DatabaseSync(file, { readOnly: true });
		if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
		return db.prepare(`SELECT * FROM ${table}`).all();
	} catch { return []; }
	finally { try { db?.close(); } catch { /* best effort */ } }
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 4_000_000 });
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		return parsed?.result?.snapshot || parsed?.result || parsed;
	} catch { return null; }
}

function roleFromIdentifier(identifier) {
	const text = String(identifier || "").toLowerCase();
	if (text.includes("architect")) return "architect";
	if (text.includes("yano-watcher") || text.startsWith("watcher")) return "watcher";
	if (text.includes("auto-improver")) return "auto-improver";
	if (text.includes("suggester")) return "suggester";
	if (text.includes("debugger")) return "debugger";
	return null;
}

function paneIdentity(pane, agentsByPane) {
	const companion = pane?.pane_id ? agentsByPane.get(pane.pane_id) : null;
	const raw = [
		pane?.agent_instance,
		pane?.terminal_title_stripped,
		pane?.terminal_title,
		pane?.name,
		pane?.label,
		companion?.agent_instance,
		companion?.terminal_title_stripped,
		companion?.terminal_title,
		companion?.name,
		companion?.label,
	].map((item) => String(item || "").trim()).filter(Boolean);
	const instance = raw.find((item) => roleFromIdentifier(item)) || null;
	return {
		instance,
		role: roleFromIdentifier(instance),
		raw_labels: [...new Set(raw)],
		agent: pane?.agent || companion?.agent || null,
		status: pane?.agent_status || companion?.agent_status || "unknown",
	};
}

function snapshotPanes(snapshot) {
	if (!snapshot) return [];
	const panes = [...(snapshot.panes || [])];
	const known = new Set(panes.map((pane) => pane.pane_id).filter(Boolean));
	// Herdr normally exposes both arrays, but older daemon responses and
	// transient refreshes can expose an agent card before its pane projection.
	// Keep those cards as a fallback so a live external agent is not reported
	// missing merely because the two projections arrived at different times.
	for (const agent of snapshot.agents || []) {
		if (!agent.pane_id || !known.has(agent.pane_id)) panes.push(agent);
	}
	return panes;
}

function liveRows(snapshot) {
	if (!snapshot) return [];
	const agentsByPane = new Map((snapshot.agents || []).map((agent) => [agent.pane_id, agent]));
	const workspaces = new Map((snapshot.workspaces || []).map((workspace) => [workspace.workspace_id, workspace.label]));
	const rows = [];
	for (const rawPane of snapshotPanes(snapshot)) {
		const pane = { ...(agentsByPane.get(rawPane.pane_id) || {}), ...rawPane };
		const identity = paneIdentity(pane, agentsByPane);
		if (!ROLES.has(identity.role) || identity.agent !== "pi" || !isLiveStatus(identity.status)) continue;
		const root = pane.cwd || pane.foreground_cwd;
		if (!root) continue;
		const resolvedRoot = canonicalRoot(root);
		rows.push({
			role: identity.role,
			root: resolvedRoot,
			name: resolveTraceProject(resolvedRoot),
			project_key: projectKey(resolvedRoot, resolveTraceProject(resolvedRoot)),
			instance: identity.instance,
			status: identity.status,
			active: true,
			source: ["herdr"],
			workspace_id: pane.workspace_id || null,
			workspace: workspaces.get(pane.workspace_id) || null,
			tab_id: pane.tab_id || null,
			pane_id: pane.pane_id || null,
			raw_labels: identity.raw_labels,
		});
	}
	return rows;
}

function registryRows(includeInactive = false) {
	const root = traceRoot();
	const rows = [];
	const registries = [
		{ role: "debugger", source: "debugger", file: path.join(root, "debugger", "debugger.sqlite"), table: "debugger_projects", status: "worker_status", instance: "worker_instance", workspace: "workspace_id", tab: "worker_tab_id", pane: "worker_pane_id" },
		{ role: "auto-improver", source: "auto-improver", file: path.join(root, "auto-improver", "auto-improver.sqlite"), table: "auto_projects", status: "worker_status", instance: "worker_instance", workspace: "workspace_id", tab: "worker_tab_id", pane: "worker_pane_id" },
		{ role: "suggester", source: "suggester", file: path.join(root, "suggester", "suggester.sqlite"), table: "suggester_projects", status: "worker_status", instance: "worker_instance", workspace: "workspace_id", tab: "worker_tab_id", pane: "worker_pane_id" },
	];
	for (const registry of registries) {
		for (const row of readRows(registry.file, registry.table)) {
			if (!row.root || (!includeInactive && !workerIsConfigured(row[registry.status]))) continue;
			const name = String(row.name || path.basename(row.root));
			rows.push({
				role: registry.role, root: canonicalRoot(row.root), name,
				project_key: row.project_key || projectKey(row.root, name),
				instance: row[registry.instance] || `${registry.role}-${slug(name)}`,
				status: row[registry.status] || "registered", active: false,
				source: [registry.source], workspace_id: row[registry.workspace] || null,
				workspace: null, tab_id: row[registry.tab] || null, pane_id: row[registry.pane] || null,
			});
		}
	}

	// Architect e Watcher sono legati al ciclo di vita della proposta globale,
	// quindi non hanno una tabella projects separata. Una proposta è comunque
	// utile per spiegare un worker offline o una proposta bloccata.
	const proposals = readRows(path.join(root, "architect", "architect.sqlite"), "architect_proposals");
	const latest = new Map();
	for (const proposal of proposals) {
		if (!proposal.project_root) continue;
		const key = canonicalRoot(proposal.project_root);
		if (!latest.has(key) || String(proposal.updated_at || "") > String(latest.get(key).updated_at || "")) latest.set(key, proposal);
	}
	for (const proposal of latest.values()) {
		const projectName = String(proposal.project_name || path.basename(proposal.project_root));
		const rootPath = canonicalRoot(proposal.project_root);
		if (proposal.architect_instance && (includeInactive || workerIsConfigured(proposal.status))) rows.push({
			role: "architect", root: rootPath, name: projectName,
			project_key: proposal.project_key || projectKey(rootPath, projectName),
			instance: proposal.architect_instance || `architect-${slug(projectName)}`,
			status: proposal.status || "registered", active: false, source: ["architect-proposal"],
			workspace_id: proposal.workspace_id || null, workspace: "yano-architect",
			tab_id: proposal.tab_id || null, pane_id: proposal.pane_id || null,
			proposal_id: proposal.proposal_id, proposal_status: proposal.status || null,
		});
		if (proposal.watcher_workspace_id && (includeInactive || workerIsConfigured(proposal.status))) rows.push({
			role: "watcher", root: rootPath, name: projectName,
			project_key: proposal.project_key || projectKey(rootPath, projectName),
			instance: `watcher-${slug(projectName)}`,
			status: proposal.status || "registered", active: false, source: ["architect-proposal"],
			workspace_id: proposal.watcher_workspace_id, workspace: "yano-watcher",
			tab_id: proposal.watcher_tab_id || null, pane_id: proposal.watcher_pane_id || null,
			proposal_id: proposal.proposal_id, proposal_status: proposal.status || null,
		});
	}
	return rows;
}

function mergeRows(snapshot, includeInactive = false) {
	const merged = new Map();
	for (const row of [...registryRows(includeInactive), ...liveRows(snapshot)]) {
		const key = `${row.role}:${canonicalRoot(row.root)}`;
		const existing = merged.get(key);
		if (!existing) { merged.set(key, { ...row, source: [...new Set(row.source || [])] }); continue; }
		const live = row.active || existing.active;
		const preferred = row.active ? row : existing;
		merged.set(key, {
			...existing, ...row, ...preferred,
			active: live,
			source: [...new Set([...(existing.source || []), ...(row.source || [])])],
			name: preferred.name || existing.name,
			project_key: preferred.project_key || existing.project_key,
		});
	}
	return [...merged.values()].sort((a, b) => `${a.name}:${a.role}`.localeCompare(`${b.name}:${b.role}`));
}

export function listExternalProjects({ role = null, includeInactive = false, projectRoot = null, snapshot = undefined } = {}) {
	if (role && !ROLES.has(role)) throw new Error(`ruolo esterno non valido: ${role}`);
	const actualSnapshot = snapshot === undefined ? herdrSnapshot() : snapshot;
	const all = mergeRows(actualSnapshot, includeInactive).filter((row) => !role || row.role === role);
	const normalizedRoot = projectRoot ? canonicalRoot(projectRoot) : null;
	const filtered = normalizedRoot ? all.filter((row) => canonicalRoot(row.root) === normalizedRoot) : all;
	return {
		generated_at: new Date().toISOString(),
		data_root: traceRoot(),
		role: role || "all",
		herdr_reachable: !!actualSnapshot,
		active_projects: filtered.filter((row) => row.active),
		registered_projects: filtered,
		projects: includeInactive ? filtered : filtered.filter((row) => row.active),
	};
}

export function runExternalStatus({ role, argv = [] } = {}) {
	const result = listExternalProjects({ role, includeInactive: has(argv, "--all"), projectRoot: value(argv, "--project-root") });
	if (has(argv, "--json")) {
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	const roleLabel = role || "agenti esterni";
	const projects = result.projects;
	console.log(`yano ${role || "external"} projects: ${projects.length} progetti ${has(argv, "--all") ? "registrati" : "attivi"}`);
	if (!result.herdr_reachable) console.log("  Herdr non raggiungibile: vengono mostrati solo i record registrati, se richiesti con --all.");
	if (!projects.length) {
		console.log(`  nessun progetto ${has(argv, "--all") ? "registrato" : "attivo"} per ${roleLabel}.`);
		return result;
	}
	for (const project of projects) {
		const runtime = project.active ? "active" : "registered/offline";
		const location = [project.instance, project.status || "unknown", runtime].filter(Boolean).join(" · ");
		const herdr = [project.workspace, project.tab_id, project.pane_id].filter(Boolean).join("/");
		console.log(`  ${project.name} — ${location} — ${project.root}${herdr ? ` — ${herdr}` : ""}`);
	}
	return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
	const requestedRole = process.argv.slice(2).find((item) => ROLES.has(item)) || null;
	runExternalStatus({ role: requestedRole, argv: process.argv.slice(2) });
}
