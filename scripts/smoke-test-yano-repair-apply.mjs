#!/usr/bin/env node

// E2E applicativo bounded: simula Herdr e un broker assente per verificare
// snapshot, stop, riavvio nella stessa pane e rinomina canonica degli esterni.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-repair-apply-"));
const projectRoot = path.join(root, "repair-apply");
const fakeBin = path.join(root, "bin");
const statePath = path.join(root, "herdr-state.json");
const dataDir = path.join(root, "temp");
fs.mkdirSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "repair-apply" }) + "\n");
fs.writeFileSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: "repair-apply" }) + "\n");
const initial = {
	agents: [
		// Regression: Planner was accidentally left inside yano-watcher. Repair
		// must move it to the project's own workspace instead of reusing cwd-only.
		{ agent: "pi", name: "planner-01", agent_status: "idle", cwd: projectRoot, pane_id: "p-planner", tab_id: "t-planner", workspace_id: "w-watcher", terminal_title_stripped: "planner-01" },
		{ agent: "pi", name: "architect-prop-20260825120256-b6eddd56", agent_status: "idle", cwd: projectRoot, pane_id: "p-architect", tab_id: "t-architect", workspace_id: "w-architect", terminal_title_stripped: "architect-prop-20260825120256-b6eddd56" },
		{ agent: "pi", name: "yano-watcher-repair-old", agent_status: "idle", cwd: projectRoot, pane_id: "p-watcher", tab_id: "t-watcher", workspace_id: "w-watcher", terminal_title_stripped: "yano-watcher-repair-old" },
	],
		tabs: [
		{ tab_id: "t-planner", label: "planner-01", workspace_id: "w-project" },
		{ tab_id: "t-project", label: "empty", workspace_id: "w-project" },
		{ tab_id: "t-architect", label: "architect-repair-old", workspace_id: "w-architect" },
		{ tab_id: "t-watcher", label: "watcher-repair-old", workspace_id: "w-watcher" },
	],
	workspaces: [
		{ workspace_id: "w-project", label: "repair-apply" },
		{ workspace_id: "w-architect", label: "yano-architect" },
		{ workspace_id: "w-watcher", label: "yano-watcher" },
	],
};
initial.panes = [
	{ pane_id: "p-planner", tab_id: "t-planner", workspace_id: "w-watcher", cwd: projectRoot, agent: "pi", name: "planner-01", agent_status: "idle", terminal_title_stripped: "planner-01" },
	{ pane_id: "p-project", tab_id: "t-project", workspace_id: "w-project", cwd: projectRoot, agent: null, name: null, agent_status: "unknown" },
	{ pane_id: "p-architect", tab_id: "t-architect", workspace_id: "w-architect", cwd: projectRoot, agent: "pi", name: "architect-prop-20260825120256-b6eddd56", agent_status: "idle", terminal_title_stripped: "architect-prop-20260825120256-b6eddd56" },
	{ pane_id: "p-watcher", tab_id: "t-watcher", workspace_id: "w-watcher", cwd: projectRoot, agent: "pi", name: "yano-watcher-repair-old", agent_status: "idle", terminal_title_stripped: "yano-watcher-repair-old" },
];
fs.writeFileSync(statePath, JSON.stringify(initial));
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	"const fs=require('node:fs');",
	"const stateFile=" + JSON.stringify(statePath) + ";",
	"const cwd=" + JSON.stringify(projectRoot) + ";",
	"const read=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));",
	"const write=(s)=>fs.writeFileSync(stateFile,JSON.stringify(s));",
	"const args=process.argv.slice(2);",
	"if(args.includes('--version')){console.log('0.0.0-test');process.exit(0);}",
	"const s=read();",
	"if(args[0]==='api'&&args[1]==='snapshot'){",
	"  if(!s.panes)s.panes=s.agents.map(a=>({...a}));",
	"  const active=new Map(s.agents.map(a=>[a.pane_id,a]));",
	"  const panes=s.panes.map(p=>active.has(p.pane_id)?{...p,...active.get(p.pane_id)}:{...p,agent:null,name:null,agent_status:'unknown'});",
	"  console.log(JSON.stringify({result:{snapshot:{...s,panes,focused_pane_id:null,focused_tab_id:null,focused_workspace_id:null}}}));process.exit(0);",
	"}",
	"if(args[0]==='pane'&&args[1]==='send-keys'){",
	"  if(!s.panes)s.panes=s.agents.map(a=>({...a}));",
	"  s.panes=s.panes.map(p=>({...p,agent:null,name:null,agent_status:'unknown'}));s.agents=[];write(s);process.exit(0);",
	"}",
	"if(args[0]==='pane'&&args[1]==='run'){",
	"  const pane=args[2];const cmd=args.slice(3).join(' ');",
	"  const im=cmd.match(/--instance '([^']+)'/);const rm=cmd.match(/--role '([^']+)'/);",
	"  if(im&&rm){if(!s.panes)s.panes=s.agents.map(a=>({...a}));const old=s.panes.find(p=>p.pane_id===pane)||{tab_id:null,workspace_id:'w-project'};s.agents=s.agents.filter(a=>a.pane_id!==pane);s.agents.push({agent:'pi',name:im[1],agent_status:'idle',cwd,pane_id:pane,tab_id:old.tab_id,workspace_id:old.workspace_id,terminal_title_stripped:im[1]});write(s);}process.exit(0);",
	"}",
	"if(args[0]==='agent'&&args[1]==='prompt'){process.exit(0);}",
	"if(args[0]==='tab'&&args[1]==='rename'){const t=s.tabs.find(x=>x.tab_id===args[2]);if(t)t.label=args.slice(3).join(' ');write(s);process.exit(0);}",
	"process.exit(0);",
].join("\n") + "\n", { mode: 0o755 });
fs.chmodSync(path.join(fakeBin, "herdr"), 0o755);
fs.writeFileSync(path.join(fakeBin, "yano"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
fs.chmodSync(path.join(fakeBin, "yano"), 0o755);

process.env.YANO_DATA_DIR = dataDir;
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
const { runRepair } = await import("../scripts/yano-repair.mjs");
const result = await runRepair({ cwd: projectRoot, argv: ["--yes", "--force", "--broker", "mqtt://127.0.0.1:1", "--timeout", "5000"] });

assert.ok(result.snapshot && fs.existsSync(path.join(result.snapshot, "repair.json")), "snapshot repair persistito");
assert.equal(result.restarted.filter((item) => item.ok).length, 3, "Planner, Architect e Watcher riavviati");
assert.deepEqual(result.restarted.filter((item) => item.ok).map((item) => item.instance).sort(), [
	"architect-repair-apply",
	"planner-01",
	"watcher-repair-apply",
].sort());
const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
const planner = finalState.agents.find((agent) => agent.name === "planner-01");
assert.equal(planner.workspace_id, "w-project", "Planner riallineato nel workspace del progetto, non in yano-watcher");
assert.deepEqual(finalState.tabs.filter((tab) => tab.tab_id !== "t-planner").map((tab) => tab.label).sort(), ["architect-repair-apply", "planner-01", "watcher-repair-apply"].sort());
assert.equal(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"), "{\"name\":\"repair-apply\"}\n", "repair non modifica il progetto");
console.log("smoke-test-yano-repair-apply: OK (snapshot, restart all agents, canonical tab names, no project mutation)");
