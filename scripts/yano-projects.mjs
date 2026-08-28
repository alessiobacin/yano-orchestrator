#!/usr/bin/env node

// Inventario globale read-only dei progetti Yano attivi in Herdr.
// A differenza di `yano <external-role> projects`, questa vista non filtra
// gli agenti esterni: raggruppa tutti gli agenti Pi live per root di progetto
// e conta ogni progetto una sola volta.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectKey, resolveTraceProject } from "./yano-trace-storage.mjs";

const TERMINAL_STATUSES = new Set(["", "unknown", "offline", "done", "completed", "stopped", "paused", "rejected", "blocked"]);
const KNOWN_ROLES = [
	"frontend-reviewer", "frontend-developer", "auto-improver", "deployment-agent", "security-evaluator",
	"architecture-diagrammer", "business-docs-author", "business-docs-reviewer", "market-researcher",
	"website-content-strategist", "speed-benchmarker", "schema-migrator", "docs-sync", "reviewer", "architect",
	"watcher", "debugger", "suggester", "planner", "coder", "specialist",
];
const ROLE_ALIASES = new Map([["docs", "docs-sync"]]);

function canonicalRoot(value) {
	try { return fs.realpathSync(value); } catch { return path.resolve(value || "."); }
}

function roleFromIdentity(value) {
	const text = String(value || "").trim().toLowerCase();
	const direct = KNOWN_ROLES.find((role) => text === role || text.startsWith(`${role}-`) || text.startsWith(`yano-${role}-`));
	if (direct) return direct;
	const compact = text.replace(/[^a-z0-9]/g, "");
	for (const [prefix, role] of ROLE_ALIASES) if (compact.startsWith(prefix)) return role;
	return KNOWN_ROLES.find((role) => compact.startsWith(role.replace(/-/g, ""))) || null;
}

function isLiveStatus(value) {
	const status = String(value || "").trim().toLowerCase();
	return !TERMINAL_STATUSES.has(status);
}

function isYanoProjectRoot(root) {
	return [
		path.join(root, "agents", "roles.yaml"),
		path.join(root, ".pi", "agents", "roles.yaml"),
		path.join(root, ".pi", "extensions", "yano-orchestrator", "config", "project.json"),
	].some((file) => fs.existsSync(file));
}

function herdrSnapshot() {
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 32_000_000 });
	if (result.error || result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout || "");
		return parsed?.result?.snapshot || parsed?.result || parsed;
	} catch { return null; }
}

function snapshotPanes(snapshot) {
	if (!snapshot) return [];
	const agentsByPane = new Map((snapshot.agents || []).map((agent) => [agent.pane_id, agent]));
	const panes = [...(snapshot.panes || [])];
	const known = new Set(panes.map((pane) => pane.pane_id).filter(Boolean));
	for (const agent of snapshot.agents || []) {
		if (!agent.pane_id || !known.has(agent.pane_id)) panes.push(agent);
	}
	const workspaces = new Map((snapshot.workspaces || []).map((workspace) => [workspace.workspace_id, workspace.label]));
	const tabs = new Map((snapshot.tabs || []).map((tab) => [tab.tab_id, tab.label]));
	return panes.map((pane) => {
		const companion = agentsByPane.get(pane.pane_id) || {};
		const merged = { ...companion, ...pane };
		const identities = [
			merged.instance, merged.agent_instance, merged.terminal_title_stripped,
			merged.terminal_title, merged.name, merged.label,
			merged.role,
		].map((value) => String(value || "").trim()).filter(Boolean);
		const instance = identities.find((value) => roleFromIdentity(value)) || identities[0] || null;
		return {
			instance,
			role: roleFromIdentity(merged.role) || roleFromIdentity(instance) || "unknown",
			status: merged.agent_status || merged.status || "unknown",
			agent: merged.agent || null,
			root: merged.cwd || merged.foreground_cwd || null,
			workspace_id: merged.workspace_id || null,
			workspace: workspaces.get(merged.workspace_id) || null,
			tab_id: merged.tab_id || null,
			tab: tabs.get(merged.tab_id) || null,
			pane_id: merged.pane_id || null,
			raw_labels: [...new Set(identities)],
		};
	});
}

export function listYanoProjects({ snapshot = undefined } = {}) {
	const actualSnapshot = snapshot === undefined ? herdrSnapshot() : snapshot;
	if (!actualSnapshot) {
		return {
			generated_at: new Date().toISOString(),
			source: "herdr",
			herdr_reachable: false,
			project_count: null,
			projects: [],
			note: "Herdr non raggiungibile: il numero di progetti attivi non è determinabile.",
		};
	}
	const grouped = new Map();
	for (const pane of snapshotPanes(actualSnapshot)) {
		if (pane.agent !== "pi" || !isLiveStatus(pane.status) || !pane.root) continue;
		const root = canonicalRoot(pane.root);
		if (!isYanoProjectRoot(root)) continue;
		const name = resolveTraceProject(root);
		const key = projectKey(root, name);
		const project = grouped.get(root) || {
			name,
			root,
			project_key: key,
			active: true,
			live_agent_count: 0,
			agents: [],
		};
		if (!project.agents.some((agent) => agent.pane_id && agent.pane_id === pane.pane_id)) {
			project.live_agent_count += 1;
			project.agents.push({
				instance: pane.instance,
				role: pane.role,
				status: pane.status,
				workspace_id: pane.workspace_id,
				workspace: pane.workspace,
				tab_id: pane.tab_id,
				tab: pane.tab,
				pane_id: pane.pane_id,
				raw_labels: pane.raw_labels,
			});
		}
		grouped.set(root, project);
	}
	const projects = [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name));
	return {
		generated_at: new Date().toISOString(),
		source: "herdr",
		herdr_reachable: true,
		project_count: projects.length,
		projects,
		note: "Conta i progetti distinti con almeno un agente Pi Yano live; gli agenti stale/offline e i soli worker registrati sono esclusi.",
	};
}

export function projectsUsage() {
	return [
		"Uso: yano projects [--json]",
		"",
		"  Inventario globale read-only dei progetti Yano con almeno un agente Pi live in Herdr.",
		"  --json    restituisce project_count, projects e herdr_reachable in JSON",
	].join("\n");
}

export function runYanoProjects({ argv = [] } = {}) {
	if (argv.includes("--help") || argv.includes("-h")) { console.log(projectsUsage()); return { ok: true, help: true }; }
	const result = listYanoProjects();
	if (argv.includes("--json")) {
		console.log(JSON.stringify(result, null, 2));
		return result;
	}
	if (!result.herdr_reachable) {
		console.log(`yano projects: ${result.note}`);
		return result;
	}
	console.log(`yano projects: ${result.project_count} progetto/i Yano attivi in Herdr:`);
	for (const project of result.projects) {
		const agents = project.agents.map((agent) => `${agent.instance || "?"} (${agent.role}, ${agent.status})`).join(", ");
		console.log(`  ${project.name} — ${project.live_agent_count} agente/i live — ${project.root}${agents ? ` — ${agents}` : ""}`);
	}
	if (!result.projects.length) console.log("  nessun progetto Yano con agenti Pi live.");
	return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) runYanoProjects({ argv: process.argv.slice(2) });
