import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-suggester-herdr-e2e-"));
const projectRoot = path.join(root, "focusboard");
const dataDir = path.join(root, "yano-temp");
const fakeBin = path.join(root, "bin");
const herdrState = path.join(root, "herdr-state.json");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "focusboard" }, null, 2));
fs.writeFileSync(path.join(projectRoot, "README.md"), "focusboard\n");
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
if (args[0] === "api" && args[1] === "snapshot") result = { result: { snapshot: { workspaces: state.workspaces, tabs: state.tabs, panes: state.panes } } };
else if (args[0] === "workspace" && args[1] === "create") { const workspace = { workspace_id: "w-suggest", label: at("--label") }; state.workspaces.push(workspace); result = { result: { workspace } }; }
else if (args[0] === "tab" && args[1] === "create") { const tab = { tab_id: "t-focusboard", workspace_id: at("--workspace"), label: at("--label"), cwd: at("--cwd") }; state.tabs.push(tab); state.panes.push({ pane_id: "p-focusboard", tab_id: tab.tab_id }); }
else if (args[0] === "pane" && args[1] === "run") result = { result: { pane_id: args[2], command: args[3] } };
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
chmodSync(fakeHerdr, 0o755);

const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`, FAKE_HERDR_STATE: herdrState, YANO_DATA_DIR: dataDir, PI_ORCH_BROKER_URL: "mqtt://127.0.0.1:1" };
const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = path.join(packageRoot, "bin", "yano.mjs");
function runCli(args) { const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, env, encoding: "utf8", maxBuffer: 20_000_000 }); assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`); return JSON.parse(result.stdout); }
const before = ["package.json", "README.md"].map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, file))).digest("hex")]);

try {
	runCli(["suggester", "init", "--project-root", projectRoot, "--notify", "none"]);
	const emptyOnce = runCli(["suggester", "start", "--project-root", projectRoot, "--once", "--dry-run"]);
	assert.equal(emptyOnce.once, true);
	assert.equal(emptyOnce.skipped, true);
	const submitted = runCli(["suggester", "submit", "--project-root", projectRoot, "--once", "--title", "Dark mode", "--description", "Aggiungere tema scuro", "--source", "user", "--priority", "low"]);
	assert.equal(submitted.read_only, true);
	assert.equal(submitted.once, true);
	assert.equal(submitted.dispatched.launched.workspace_id, "w-suggest");
	assert.match(submitted.dispatched.launched.command, /--role suggester/);
	const state = JSON.parse(fs.readFileSync(herdrState, "utf8"));
	assert.deepEqual(state.workspaces, [{ workspace_id: "w-suggest", label: "yano-suggester" }]);
	assert.equal(state.tabs[0].label, "suggester-focusboard");
	const paneRun = state.calls.find((args) => args[0] === "pane" && args[1] === "run");
	assert.ok(paneRun);
	assert.match(paneRun[3], /yano start/);
	assert.match(paneRun[3], /--role suggester/);
	const completed = runCli(["suggester", "complete", "--project-root", projectRoot, "--suggestion-id", submitted.suggestion_id, "--report-file", submitted.dispatched.launched.report_path, "--category", "improvement", "--summary", "Tema scuro", "--value", "Migliora accessibilità", "--complexity", "low", "--risk", "low", "--confidence", "high"]);
	assert.equal(completed.status, "awaiting_approval");
	const approved = runCli(["suggester", "approve", "--project-root", projectRoot, "--suggestion-id", submitted.suggestion_id, "--actor", "superadmin", "--yes"]);
	assert.equal(approved.status, "accepted");
	assert.equal(approved.planner.delivered, 0);
	for (const [file, digest] of before) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, file))).digest("hex"), digest, `${file} modificato`);
	console.log("smoke-test-yano-suggester-herdr: ok");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
