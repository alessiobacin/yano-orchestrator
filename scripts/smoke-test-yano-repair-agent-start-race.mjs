#!/usr/bin/env node

// Regression for the same transient `agent_kind_mismatch` race covered by
// smoke-test-herdr-agent-start-race.mjs, but hit through yano-repair.mjs's
// own restart path (launchAgentInPane), which used to spawn `herdr agent
// start` once with no recovery at all. Herdr can start Pi successfully and
// still answer the synchronous handshake with a mismatch while its lifecycle
// hook is still publishing the stable `agent: pi` identity — repair must
// accept that only after verifying the same pane became a live Pi agent,
// exactly like the launcher does.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-repair-race-"));
const projectRoot = path.join(root, "repair-race");
const fakeBin = path.join(root, "bin");
const statePath = path.join(root, "herdr-state.json");
const dataDir = path.join(root, "temp");
fs.mkdirSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "repair-race" }) + "\n");
fs.writeFileSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: "repair-race" }) + "\n");
const initial = {
	agents: [
		{ agent: "pi", name: "planner-01", agent_status: "idle", cwd: projectRoot, pane_id: "p-planner", tab_id: "t-planner", workspace_id: "w-project", terminal_title_stripped: "planner-01" },
	],
	tabs: [
		{ tab_id: "t-planner", label: "planner-01", workspace_id: "w-project" },
	],
	workspaces: [
		{ workspace_id: "w-project", label: "repair-race" },
	],
};
initial.panes = [
	{ pane_id: "p-planner", tab_id: "t-planner", workspace_id: "w-project", cwd: projectRoot, agent: "pi", name: "planner-01", agent_status: "idle", terminal_title_stripped: "planner-01" },
];
fs.writeFileSync(statePath, JSON.stringify(initial));
// Restarting Planner alone (no Architect/Watcher panes declared) drives
// launchAgentInPane through exactly one `agent start` call, which is all
// this race needs to reproduce.
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	"const fs=require('node:fs');",
	"const stateFile=" + JSON.stringify(statePath) + ";",
	"const cwd=" + JSON.stringify(projectRoot) + ";",
	"const startedFile=" + JSON.stringify(path.join(root, "started")) + ";",
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
	// First `agent start` call: pretend Herdr already registered the pane as
	// a live pi agent (so the recovery poll below finds it), but still answer
	// the synchronous handshake with the transient false-negative mismatch.
	"if(args[0]==='agent'&&args[1]==='start'){",
	"  const herdrName=args[2];const instance=args[args.indexOf('--instance')+1]||herdrName;const pane=args[args.indexOf('--pane')+1];",
	"  if(!s.panes)s.panes=s.agents.map(a=>({...a}));const old=s.panes.find(p=>p.pane_id===pane)||{tab_id:null,workspace_id:'w-project'};",
	"  s.agents=s.agents.filter(a=>a.pane_id!==pane);s.agents.push({agent:'pi',name:herdrName,agent_status:'idle',cwd,pane_id:pane,tab_id:old.tab_id,workspace_id:old.workspace_id,terminal_title_stripped:instance});write(s);",
	"  process.stderr.write(JSON.stringify({error:{code:'agent_kind_mismatch',message:'expected pi, detected '+instance}}));process.exit(17);",
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

try {
	assert.ok(result.snapshot, "repair should still snapshot before the race");
	const planner = result.restarted.find((item) => item.instance === "planner-01");
	assert.ok(planner, "planner-01 should appear in the restart report");
	assert.equal(planner.ok, true, `repair should recover from a transient agent_kind_mismatch instead of failing the restart: ${JSON.stringify(planner)}`);
	console.log("smoke-test-yano-repair-agent-start-race: ok (repair recovered from a transient herdr mismatch, same as the launcher)");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
