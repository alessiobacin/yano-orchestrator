// T4: the supervisor must match the planner by ROLE, not by the exact
// `planner-01` name. Since Revisione 66 Herdr registers agents under a
// globally unique name (`planner-<project>-<hash>`) while Pi's --instance
// stays `planner-01`, matching by exact name made ensureRegisteredPlanner()
// miss the live planner and create a duplicate `planner-01` tab.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { isPlannerIdentity, agentIsPlanner, plannerAgentsInWorkspace, plannerLabelForAgent } from "./watcher/planner-health.mjs";
import { ensureRegisteredPlanner } from "./yano-watcher-registry.mjs";
import { assertAgentIdentityAvailable } from "./yano-agent-identity.mjs";

const yanoRequire = createRequire(import.meta.url);

// Fake `herdr`: a live `pi` process on pane p-planner, nothing else.
// Records every close/create/run call — the test asserts none of them fire.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "t4-herdr-bin-"));
const callLog = path.join(fakeBin, "herdr-calls.txt");
fs.writeFileSync(callLog, "");
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	"const fs = require(\"fs\");",
	`const log = ${JSON.stringify(callLog)};`,
	"fs.appendFileSync(log, process.argv.slice(2).join(\" \") + \"\\n\");",
	'if (process.argv[2] === "pane" && process.argv[3] === "process-info") {',
	'  const paneId = process.argv[process.argv.indexOf("--pane") + 1];',
	'  const foreground = paneId === "p-planner" ? [{ argv0: "pi", pid: 4242 }] : [];',
	'  process.stdout.write(JSON.stringify({ result: { process_info: { foreground_processes: foreground } } }));',
	"  process.exit(0);",
	"}",
	'process.stdout.write("{}");',
	"process.exit(1);",
].join("\n"));
fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;

// Minimal initialized project: a real orchestrator.db with one completed run
// so projectRuns().available is true and ensureRegisteredPlanner() proceeds
// to the planner-presence check (no runs → different early path).
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t4-project-"));
const projectName = "t4-demo";
const storage = path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage");
fs.mkdirSync(storage, { recursive: true });
const { DatabaseSync } = yanoRequire("node:sqlite");
{
	const db = new DatabaseSync(path.join(storage, "orchestrator.db"));
	db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT)");
	db.exec("CREATE TABLE events (run_id TEXT, created_at TEXT)");
	db.exec("CREATE TABLE decision_holds (id TEXT, run_id TEXT, status TEXT)");
	db.exec("CREATE TABLE tickets (id TEXT, run_id TEXT, title TEXT, description TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, result_summary TEXT, updated_at TEXT)");
	db.exec("CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT)");
	db.exec("CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT)");
	db.exec("CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT)");
	db.prepare("INSERT INTO runs (id, project, objective, status, finalization_status, updated_at) VALUES ('run-1', ?, 'demo', 'completed', 'finalized', ?)").run(projectName, new Date().toISOString());
	db.close();
}
const row = { root: projectRoot, name: projectName, project_key: "t4-demo" };

// Snapshot with the planner ACTIVE as the unique Herdr agent name,
// role=planner, fresh MQTT heartbeat — the exact Revisione 66 shape the
// bug report describes. The agent row deliberately carries NO `name`
// (production snapshots do not populate it — see yano-watcher-registry
// line ~489): identity comes from the tab label + the Pi role only.
const snapshot = {
	workspaces: [{ workspace_id: "w-1", label: projectName }],
	tabs: [{ tab_id: "t-planner", workspace_id: "w-1", label: "planner-t4-demo-a1b2c3d4" }],
	panes: [{ pane_id: "p-planner", tab_id: "t-planner", workspace_id: "w-1", cwd: projectRoot }],
	agents: [{
		role: "planner",
		instance: "planner-01",
		workspace_id: "w-1",
		tab_id: "t-planner",
		pane_id: "p-planner",
		cwd: projectRoot,
		agent_status: "idle",
		last_heartbeat: new Date().toISOString(),
	}],
};

console.log("=== TEST 1 — role-based identity recognizes the unique planner name ===");
assert.equal(isPlannerIdentity("planner-01"), true);
assert.equal(isPlannerIdentity("planner-t4-demo-a1b2c3d4"), true);
assert.equal(isPlannerIdentity("coder-01"), false);
assert.equal(isPlannerIdentity(""), false);
const hashedAgent = snapshot.agents[0];
assert.equal(agentIsPlanner(hashedAgent), true, "agent with role=planner and no name must count as a planner");
assert.equal(agentIsPlanner({ name: "planner-t4-demo-a1b2c3d4" }), true, "unique herdr agent name must count as a planner");
assert.equal(agentIsPlanner({ name: "coder-01", role: "coder" }), false);
assert.equal(plannerLabelForAgent(snapshot, hashedAgent), true, "unique tab label must prove planner identity even without an agent name");
assert.equal(plannerAgentsInWorkspace(snapshot, "w-1", projectRoot).length, 1);
console.log("   OK — unique name matched by role, exact names still matched");

console.log("\n=== TEST 2 — ensureRegisteredPlanner sees the live planner: NO duplicate ===");
const outcome = ensureRegisteredPlanner(row, snapshot, null);
assert.equal(outcome.recovery, "planner_healthy", `must report planner_healthy (got ${outcome.recovery})`);
const calls = fs.readFileSync(callLog, "utf8");
assert.doesNotMatch(calls, /tab\s+create/, "must not create any tab");
assert.doesNotMatch(calls, /pane\s+run/, "must not launch anything");
assert.doesNotMatch(calls, /tab\s+close/, "must not close anything");
console.log("   OK — planner_healthy, zero herdr mutations");

console.log("\n=== TEST 3 — legacy planner-01 tab still matches (no regression) ===");
const legacy = {
	workspaces: [{ workspace_id: "w-1", label: projectName }],
	tabs: [{ tab_id: "t-legacy", workspace_id: "w-1", label: "planner-01" }],
	panes: [{ pane_id: "p-legacy", tab_id: "t-legacy", workspace_id: "w-1", cwd: projectRoot }],
	agents: [{ name: "planner-01", workspace_id: "w-1", tab_id: "t-legacy", pane_id: "p-legacy", cwd: projectRoot, agent_status: "idle", last_heartbeat: new Date().toISOString() }],
};
const legacyOutcome = ensureRegisteredPlanner(row, legacy, null);
assert.equal(legacyOutcome.recovery, "planner_healthy");
console.log("   OK — legacy naming still recognized");

console.log("\n=== TEST 4 — launcher guard refuses a 2nd planner while the unique one is live ===");
assert.throws(
	() => assertAgentIdentityAvailable({ snapshot: { agents: [{ ...snapshot.agents[0], name: "planner-t4-demo-a1b2c3d4" }] }, root: projectRoot, instance: "planner-01", role: "planner" }),
	/planner già attivo/,
	"must refuse a second planner-01 while planner-<hash> is live",
);
console.log("   OK — duplicate launch blocked by role");

fs.rmSync(fakeBin, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log("\nsmoke-test-planner-role-not-name: ok");
