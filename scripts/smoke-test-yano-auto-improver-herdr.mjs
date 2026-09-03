import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-auto-improver-herdr-e2e-"));
const projectRoot = path.join(root, "focusboard");
const dataDir = path.join(root, "yano-temp");
const fakeBin = path.join(root, "bin");
const herdrState = path.join(root, "herdr-state.json");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "focusboard", scripts: { test: "node test.mjs" } }, null, 2));
fs.writeFileSync(path.join(projectRoot, "README.md"), "focusboard e2e\n");
fs.mkdirSync(path.join(projectRoot, "agents"), { recursive: true });
fs.writeFileSync(path.join(projectRoot, "agents", "roles.yaml"), "roles: {}\n");
fs.writeFileSync(herdrState, JSON.stringify({ workspaces: [], tabs: [], panes: [], calls: [] }));

const fakeHerdr = path.join(fakeBin, "herdr");
writeFileSync(fakeHerdr, `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_HERDR_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push(args);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
let result = {};
if (args[0] === "api" && args[1] === "snapshot") {
  result = { result: { snapshot: { workspaces: state.workspaces, tabs: state.tabs, panes: state.panes } } };
} else if (args[0] === "workspace" && args[1] === "create") {
  const workspace = { workspace_id: "w-auto", label: at("--label") };
  state.workspaces.push(workspace);
  result = { result: { workspace } };
} else if (args[0] === "tab" && args[1] === "create") {
  const tab = { tab_id: "t-focusboard", workspace_id: at("--workspace"), label: at("--label"), cwd: at("--cwd") };
  state.tabs.push(tab);
  state.panes.push({ pane_id: "p-focusboard", tab_id: tab.tab_id });
} else if (args[0] === "tab" && args[1] === "rename") {
  const tab = state.tabs.find((item) => item.tab_id === args[2]);
  if (tab) tab.label = args[3];
} else if (args[0] === "agent" && args[1] === "start") {
  const pane = state.panes.find((item) => item.pane_id === at("--pane"));
  if (pane) pane.agent_status = "idle";
  result = { result: { agent: args[2] } };
} else if (args[0] === "agent" && args[1] === "prompt") {
  result = { result: { accepted: true, agent: args[2], prompt_chars: String(args[3] || "").length } };
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
chmodSync(fakeHerdr, 0o755);

const env = {
	...process.env,
	PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
	FAKE_HERDR_STATE: herdrState,
	YANO_DATA_DIR: dataDir,
	PI_ORCH_BROKER_URL: "mqtt://127.0.0.1:1",
};
const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(packageRoot, "bin", "yano.mjs");

function runCli(args) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, env, encoding: "utf8", maxBuffer: 20_000_000 });
	assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

const before = ["package.json", "README.md"].map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, file))).digest("hex")]);

try {
	const initialized = runCli(["auto-improve", "init", "--project-root", projectRoot, "--interval", "5d", "--notify", "none", "--json"]);
	assert.equal(initialized.read_only, true);
	assert.equal(initialized.project.worker_status, "stopped");

	const started = runCli(["auto-improve", "start", "--project-root", projectRoot, "--once", "--no-daemon", "--json"]);
	assert.equal(started.read_only, true);
	assert.equal(started.once, true);
	assert.equal(started.scheduler.once, true);
	assert.equal(started.launched.dry_run, false);
	assert.equal(started.launched.workspace_id, "w-auto");
	assert.equal(started.launched.tab_id, "t-focusboard");
	assert.equal(started.launched.pane_id, "p-focusboard");
	assert.match(started.launched.command, /\[Pi args\]/);
	assert.ok(Array.isArray(started.launched.command_args));
	assert.equal(started.launched.prompt_delivery, "herdr agent prompt (API payload)");
	assert.ok(fs.existsSync(started.evidencePath));
	assert.ok(fs.existsSync(started.reportPath));
	const evidence = JSON.parse(fs.readFileSync(started.evidencePath, "utf8"));
	assert.equal(evidence.read_only, true);
	assert.equal(evidence.project.root, projectRoot);

	const state = JSON.parse(fs.readFileSync(herdrState, "utf8"));
	assert.deepEqual(state.workspaces, [{ workspace_id: "w-auto", label: "yano-auto-improver" }]);
	assert.equal(state.tabs[0].label, "auto-improver-focusboard");
	assert.equal(state.tabs[0].cwd, projectRoot);
	assert.equal(state.panes[0].pane_id, "p-focusboard");
	const agentStart = state.calls.find((args) => args[0] === "agent" && args[1] === "start");
	assert.ok(agentStart, "Herdr agent start non registrato");
	assert.equal(agentStart[agentStart.indexOf("--pane") + 1], "p-focusboard");
	const piArgs = agentStart.slice(agentStart.indexOf("--") + 1);
	assert.ok(piArgs.includes("--role") && piArgs[piArgs.indexOf("--role") + 1] === "auto-improver");
	const toolsIndex = piArgs.indexOf("--tools");
	assert.ok(toolsIndex >= 0, "allow-list strumenti non presente negli argomenti Pi");
	assert.deepEqual(piArgs[toolsIndex + 1].split(","), ["read", "grep", "find", "ls", "auto_improve_web_search", "auto_improve_web_fetch", "agent_list", "agent_get", "agent_send", "agent_await", "auto_improve_complete"]);
	assert.ok(!piArgs.includes("--continue"));
	assert.ok(!piArgs[toolsIndex + 1].match(/\b(?:bash|edit|write)\b/), "allow-list contiene uno strumento di scrittura o shell");
	const promptCall = state.calls.find((args) => args[0] === "agent" && args[1] === "prompt");
	assert.ok(promptCall && promptCall[3].length > 1000, "il prompt audit deve essere consegnato come payload API completo, non troncato nella shell");

	const running = runCli(["auto-improve", "status", "--project-root", projectRoot, "--json"]);
	assert.equal(running.project.worker_status, "running");
	assert.equal(running.audits[0].status, "awaiting_agent");

	const summaryPath = path.join(dataDir, "auto-improver", "summary.json");
	fs.writeFileSync(summaryPath, JSON.stringify({ summary: "Audit E2E completato senza modifiche." }));
	const completed = runCli(["auto-improve", "complete", "--project-root", projectRoot, "--audit-id", started.auditId, "--report-file", started.reportPath, "--summary-file", summaryPath, "--json"]);
	assert.equal(completed.status, "completed");
	assert.equal(completed.planner.delivered, 0);
	assert.equal(Object.keys(completed.notifications).length, 0);

	const finalStatus = runCli(["auto-improve", "status", "--project-root", projectRoot, "--json"]);
	assert.equal(finalStatus.project.worker_status, "idle");
	assert.equal(finalStatus.audits[0].status, "completed");
	assert.equal(finalStatus.audits[0].summary, "Audit E2E completato senza modifiche.");
	for (const [file, digest] of before) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, file))).digest("hex"), digest, `${file} è stato modificato`);
	console.log("smoke-test-yano-auto-improver-herdr: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
