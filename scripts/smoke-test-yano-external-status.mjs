#!/usr/bin/env node

// E2E bounded dell'inventario dei cinque worker esterni. Verifica che la
// presenza Herdr prevalga sui registri offline e che Architect/Watcher non
// spariscano dalla vista `external_workers` solo perché non hanno una tabella
// projects dedicata.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-external-status-"));
const projectRoot = path.join(root, "sales-companion");
const dataDir = path.join(root, "data");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "sales-companion" }) + "\n");
process.env.YANO_DATA_DIR = dataDir;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
function seed(file, sql, rows) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec(sql);
	for (const row of rows) row();
	db.close();
}

const debuggerDb = path.join(dataDir, "debugger", "debugger.sqlite");
seed(debuggerDb, `CREATE TABLE debugger_projects (project_key TEXT PRIMARY KEY, name TEXT, root TEXT, worker_status TEXT, workspace_id TEXT, worker_tab_id TEXT, worker_pane_id TEXT, worker_instance TEXT);`, [
	() => {
		const db = new DatabaseSync(debuggerDb);
		db.prepare("INSERT INTO debugger_projects VALUES(?,?,?,?,?,?,?,?)").run("workspace-debugger", "sales-companion", projectRoot, "scheduled", "w-debugger", "t-debugger", "p-debugger", "debugger-sales-companion");
		db.close();
	},
]);

const architectDb = path.join(dataDir, "architect", "architect.sqlite");
seed(architectDb, `CREATE TABLE architect_proposals (
	proposal_id TEXT PRIMARY KEY, project_key TEXT, project_root TEXT, project_name TEXT, status TEXT,
	architect_instance TEXT, workspace_id TEXT, tab_id TEXT, pane_id TEXT,
	watcher_workspace_id TEXT, watcher_tab_id TEXT, watcher_pane_id TEXT, updated_at TEXT
);`, [
	() => {
		const db = new DatabaseSync(architectDb);
		db.prepare("INSERT INTO architect_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("PROP-1", "workspace-sales", projectRoot, "sales-companion", "ready_ephemeral", "architect-sales-companion", "w-architect", "t-architect", "p-architect", "w-watcher", "t-watcher", "p-watcher", "2026-08-27T10:00:00.000Z");
		db.close();
	},
]);

const snapshot = {
	workspaces: [
		{ workspace_id: "w-architect", label: "yano-architect" },
		{ workspace_id: "w-watcher", label: "yano-watcher" },
	],
	agents: [
		{ pane_id: "p-architect", tab_id: "t-architect", workspace_id: "w-architect", cwd: projectRoot, agent: "pi", name: "architect-sales-companion", agent_status: "idle" },
		{ pane_id: "p-watcher", tab_id: "t-watcher", workspace_id: "w-watcher", cwd: projectRoot, agent: "pi", name: "watcher-sales-companion", agent_status: "idle" },
	],
	panes: [
		{ pane_id: "p-architect", tab_id: "t-architect", workspace_id: "w-architect", cwd: projectRoot, agent: "pi", name: "architect-sales-companion", agent_status: "idle", terminal_title_stripped: "architect-sales-companion" },
		{ pane_id: "p-watcher", tab_id: "t-watcher", workspace_id: "w-watcher", cwd: projectRoot, agent: "pi", name: "watcher-sales-companion", agent_status: "idle", terminal_title_stripped: "watcher-sales-companion" },
	],
};

const { listExternalProjects } = await import("../scripts/yano-external-status.mjs");
const all = listExternalProjects({ snapshot, includeInactive: true });
assert.deepEqual(all.active_projects.map((row) => `${row.role}:${row.name}`).sort(), [
	"architect:sales-companion",
	"watcher:sales-companion",
].sort());
assert.equal(all.projects.find((row) => row.role === "architect").instance, "architect-sales-companion");
assert.equal(all.projects.find((row) => row.role === "watcher").workspace, "yano-watcher");

const architect = listExternalProjects({ role: "architect", snapshot });
assert.equal(architect.active_projects.length, 1);
assert.equal(architect.active_projects[0].pane_id, "p-architect");
const watcher = listExternalProjects({ role: "watcher", snapshot });
assert.equal(watcher.active_projects[0].tab_id, "t-watcher");

const agentsOnly = { ...snapshot, panes: [] };
const agentsOnlyWatcher = listExternalProjects({ role: "watcher", snapshot: agentsOnly });
assert.equal(agentsOnlyWatcher.active_projects.length, 1, "un card Herdr live senza proiezione pane non deve sparire");

const blockedSnapshot = { ...snapshot, panes: [], agents: [] };
const blockedArchitectDb = new DatabaseSync(architectDb);
blockedArchitectDb.prepare("UPDATE architect_proposals SET status='blocked'").run();
blockedArchitectDb.close();
assert.equal(listExternalProjects({ role: "architect", snapshot: blockedSnapshot }).registered_projects.length, 0, "una proposta blocked non è attiva");
assert.equal(listExternalProjects({ role: "architect", snapshot: blockedSnapshot, includeInactive: true }).registered_projects[0].status, "blocked", "--all deve mostrare anche la proposta blocked");

const debuggerView = listExternalProjects({ role: "debugger", snapshot });
assert.equal(debuggerView.active_projects.length, 0, "un worker solo registrato non è falsamente dichiarato live");
assert.equal(debuggerView.registered_projects.length, 1);
console.log("smoke-test-yano-external-status: OK (Architect/Watcher live, registri offline distinti, scope per ruolo)");
