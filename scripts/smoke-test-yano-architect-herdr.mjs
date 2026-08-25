import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-architect-herdr-e2e-"));
const projectRoot = path.join(root, "focusboard");
const blockedProjectRoot = path.join(root, "blocked-app");
const dataDir = path.join(root, "yano-temp");
const fakeBin = path.join(root, "bin");
const herdrState = path.join(root, "herdr-state.json");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(blockedProjectRoot, { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "focusboard" }, null, 2));
fs.mkdirSync(path.join(projectRoot, "agents"), { recursive: true });
fs.writeFileSync(path.join(projectRoot, "agents", "roles.yaml"), "roles:\n  planner:\n    activation: always\n");
fs.writeFileSync(path.join(projectRoot, ".mcp.json"), JSON.stringify({ github: { command: "github-mcp" } }, null, 2));
fs.writeFileSync(path.join(blockedProjectRoot, "package.json"), JSON.stringify({ name: "blocked-app" }, null, 2));
fs.writeFileSync(herdrState, JSON.stringify({ workspaces: [], tabs: [], panes: [], agents: [], calls: [] }));
fs.mkdirSync(path.join(dataDir, "catalog", "skills", "tdd-development"), { recursive: true });
fs.writeFileSync(path.join(dataDir, "catalog", "skills", "tdd-development", "SKILL.md"), "---\nname: tdd-development\ndescription: smoke skill\n---\n# smoke\n");

const fakeHerdr = path.join(fakeBin, "herdr");
writeFileSync(fakeHerdr, `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_HERDR_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push(args);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
let result = {};
if (args[0] === "api" && args[1] === "snapshot") result = { result: { snapshot: { workspaces: state.workspaces, tabs: state.tabs, panes: state.panes, agents: state.agents } } };
else if (args[0] === "workspace" && args[1] === "create") { const workspace = { workspace_id: "w-" + at("--label"), label: at("--label") }; state.workspaces.push(workspace); result = { result: { workspace } }; }
else if (args[0] === "tab" && args[1] === "create") { const label = at("--label"); const workspaceId = at("--workspace"); const tab = { tab_id: "t-" + workspaceId + "-" + label, workspace_id: workspaceId, label, cwd: at("--cwd") }; state.tabs.push(tab); state.panes.push({ pane_id: "p-" + workspaceId + "-" + label, tab_id: tab.tab_id }); }
else if (args[0] === "tab" && args[1] === "rename") { const tab = state.tabs.find((item) => item.tab_id === args[2]); if (tab) tab.label = args.slice(3).join(" "); }
else if (args[0] === "agent" && args[1] === "start") { const agent = { name: args[2], agent: at("--kind"), agent_status: "idle", terminal_title_stripped: args[2], pane_id: at("--pane"), tab_id: state.panes.find((item) => item.pane_id === at("--pane"))?.tab_id, workspace_id: null }; state.agents.push(agent); result = { result: { agent } }; }
else if (args[0] === "pane" && args[1] === "run") result = { result: { pane_id: args[2], command: args[3] } };
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

const before = crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "package.json"))).digest("hex");
try {
	const assessment = runCli(["architect", "assess", "--task", "Implementa una funzione backend", "--project-root", projectRoot, "--json"]);
	assert.equal(assessment.candidate_playbook, "backend-change");
	assert.ok(assessment.capabilities.skills.includes("tdd-development"));

	const created = runCli(["architect", "propose", "--task", "Implementa una funzione backend", "--project-root", projectRoot, "--json"]);
	const proposalId = created.proposal.proposal_id;
	assert.equal(created.proposal.status, "draft");
	assert.ok(fs.existsSync(created.paths.playbook));
	assert.ok(fs.existsSync(created.paths.manifest));

	const gated = runCli(["architect", "provision", "--proposal-id", proposalId, "--once", "--json"]);
	assert.equal(gated.ready, false, JSON.stringify(gated));
	assert.ok(gated.checks.some((check) => check.kind === "mcp" && check.status === "pending"));
	runCli(["architect", "capability", "--proposal-id", proposalId, "--kind", "mcp", "--name", "github", "--status", "ready", "--evidence", "initialize/tools-list smoke handshake", "--json"]);
	const once = runCli(["architect", "provision", "--proposal-id", proposalId, "--once", "--json"]);
	assert.equal(once.ready, true, JSON.stringify(once));
	assert.equal(once.operational, true);
	assert.ok(once.checks.every((check) => check.status === "ready"));

	const provisioned = runCli(["architect", "provision", "--proposal-id", proposalId, "--install", "--json"]);
	assert.equal(provisioned.status, "ready_ephemeral", JSON.stringify(provisioned));
	assert.equal(provisioned.watcher.workspace_label, "yano-watcher");
	assert.equal(provisioned.architect.workspace_label, "yano-architect");
	assert.match(provisioned.architect.command, /--role architect/);
	assert.match(provisioned.watcher.command, /--validation-run/);
	assert.equal(provisioned.watcher.agent_kind, "pi");
	assert.equal(provisioned.watcher.instance, "yano-watcher-focusboard");
	assert.equal(provisioned.watcher.label, "watcher-focusboard");
	assert.equal(provisioned.architect.label, "architect-focusboard");
	assert.ok(provisioned.watcher.herdr_agent_name.length <= 32, "il nome Herdr del watcher deve rispettare il limite di 32 caratteri");
	assert.ok(provisioned.architect.herdr_agent_name.length <= 32, "il nome Herdr dell'architect deve rispettare il limite di 32 caratteri");

	const state = JSON.parse(fs.readFileSync(herdrState, "utf8"));
	assert.deepEqual(state.workspaces.map((item) => item.label).sort(), ["yano-architect", "yano-watcher"]);
	assert.equal(state.tabs.length, 2);
	assert.deepEqual(state.tabs.map((item) => item.label).sort(), ["architect-focusboard", "watcher-focusboard"]);
	assert.ok(state.calls.some((args) => args[0] === "agent" && args[1] === "start" && args.includes("--kind") && args.includes("pi") && args.includes("--role") && args.includes("architect")), "Architect deve essere avviato come agente Herdr reale");
	assert.ok(state.calls.some((args) => args[0] === "agent" && args[1] === "start" && args.includes("--kind") && args.includes("pi") && args.includes("--role") && args.includes("watcher")), "watcher deve essere avviato come agente Herdr reale");
	for (const call of state.calls.filter((args) => args[0] === "agent" && args[1] === "start")) assert.notEqual(call[call.indexOf("--") + 1], "pi", "Herdr seleziona pi tramite --kind: non deve ricevere pi due volte");
	assert.ok(state.calls.some((args) => args[0] === "agent" && args[1] === "prompt" && args[2] === "yano-watcher-focusboard"), "il prompt lungo deve essere inviato dopo lo startup, via protocollo agent");

	const reprovisioned = runCli(["architect", "provision", "--proposal-id", proposalId, "--install", "--json"]);
	assert.equal(reprovisioned.status, "ready_ephemeral");
	assert.equal(reprovisioned.watcher.already_running, true, "un watcher già attivo deve essere riusato");
	assert.equal(reprovisioned.architect.already_running, true, "un architect già attivo deve essere riusato");
	assert.equal(JSON.parse(fs.readFileSync(herdrState, "utf8")).tabs.length, 2, "un reprovision non deve creare tab duplicate");

	const validation = runCli(["architect", "validation", "--proposal-id", proposalId, "--run-id", "RUN-ARCH-001", "--result", "passed", "--details", "watcher round healthy", "--json"]);
	assert.equal(validation.result, "passed");
	const feedback = runCli(["architect", "feedback", "--proposal-id", proposalId, "--status", "positive", "--text", "Esperienza positiva", "--actor", "planner", "--json"]);
	assert.equal(feedback.next_state, "promotion_candidate");
	const promoted = runCli(["architect", "promote", "--proposal-id", proposalId, "--yes", "--json"]);
	assert.equal(promoted.status, "persistent");
	assert.ok(fs.existsSync(promoted.playbook_path));
	assert.ok(fs.existsSync(promoted.role_path));
	const catalog = runCli(["playbook", "list", "--json"]);
	assert.ok(catalog.some((entry) => entry.id === created.proposal.playbook_id && entry.source === "user"));
	const role = runCli(["agent", "show", created.proposal.role_id, "--json"]);
	assert.equal(role.source, "user");
	const launcher = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "launch-planner.mjs"), "--role", created.proposal.role_id, "--instance", "generated-01", "--print-only"], { cwd: projectRoot, env, encoding: "utf8" });
	assert.equal(launcher.status, 0, launcher.stderr);
	assert.match(launcher.stdout, /--role backend-change-specialist/);
	assert.match(launcher.stdout, /runtime-config/);
	assert.match(launcher.stdout, /tdd-development/);

	const blockedCreated = runCli(["architect", "propose", "--task", "Ridisegna l'interfaccia nel browser", "--project-root", blockedProjectRoot, "--json"]);
	const blocked = runCli(["architect", "provision", "--proposal-id", blockedCreated.proposal.proposal_id, "--once", "--json"]);
	assert.equal(blocked.operational, false);
	assert.ok(blocked.checks.some((check) => ["missing", "pending"].includes(check.status)));
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "package.json"))).digest("hex"), before, "architect ha modificato il progetto");
	console.log("smoke-test-yano-architect-herdr: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
