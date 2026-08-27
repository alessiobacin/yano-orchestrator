#!/usr/bin/env node

// E2E bounded dell'inventario globale: due progetti attivi in Herdr vengono
// rilevati senza modificare processi, file applicativi o lo stato MQTT.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-repair-all-"));
const projectA = path.join(root, "alpha");
const projectB = path.join(root, "beta");
const fakeBin = path.join(root, "bin");
const statePath = path.join(root, "herdr-state.json");
const dataDir = path.join(root, "temp");
for (const project of [projectA, projectB]) {
	fs.mkdirSync(path.join(project, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
	fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: path.basename(project) }) + "\n");
	fs.writeFileSync(path.join(project, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: path.basename(project) }) + "\n");
}
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(statePath, JSON.stringify({
	workspaces: [
		{ workspace_id: "w-alpha", label: "alpha" },
		{ workspace_id: "w-beta", label: "beta" },
	],
	panes: [
		{ pane_id: "p-alpha", tab_id: "t-alpha", workspace_id: "w-alpha", cwd: projectA, agent: "pi", name: "planner-01", label: "planner-01", agent_status: "idle" },
		{ pane_id: "p-beta", tab_id: "t-beta", workspace_id: "w-beta", cwd: projectB, agent: "pi", name: "planner-01", label: "planner-01", agent_status: "idle" },
	],
}));
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	"const fs=require('node:fs');",
	"const s=JSON.parse(fs.readFileSync(" + JSON.stringify(statePath) + ",'utf8'));",
	"if(process.argv[2]==='--version'){process.exit(0);}",
	"if(process.argv[2]==='api'&&process.argv[3]==='snapshot'){console.log(JSON.stringify({result:{snapshot:{...s,tabs:s.panes.map(p=>({tab_id:p.tab_id,workspace_id:p.workspace_id,label:p.label}))}}}));process.exit(0);}",
	"process.exit(0);",
].join("\n") + "\n", { mode: 0o755 });
fs.chmodSync(path.join(fakeBin, "herdr"), 0o755);

process.env.YANO_DATA_DIR = dataDir;
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
const { runRepair } = await import("../scripts/yano-repair.mjs");
const result = await runRepair({ cwd: projectA, argv: ["--all-projects", "--dry-run", "--broker", "mqtt://127.0.0.1:1"] });

assert.equal(result.mode, "all-projects");
assert.deepEqual(result.projects.map((project) => project.name).sort(), ["alpha", "beta"]);
assert.equal(result.dry_run, true);
assert.equal(fs.existsSync(path.join(projectA, "package.json")), true);
assert.equal(fs.existsSync(path.join(projectB, "package.json")), true);
console.log("smoke-test-yano-repair-all: OK (multi-project inventory is read-only)");
