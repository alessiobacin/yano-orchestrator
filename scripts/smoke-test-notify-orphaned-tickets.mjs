// Fase 1 / M1 — caratterizza il contratto osservabile di
// notifyPlannerOfOrphanedTickets(): pubblica un comando
// `watcher_specialist_recovery` sul topic MQTT del planner vivo del
// progetto. Scritto PRIMA del refactor (M1: elimina lo spawn di
// sottoprocesso Node in favore del client `mqtt` già importato in-process,
// come già fa correttamente notifyYanoOrchestratorPlanner due funzioni
// sotto) per fissare il comportamento come baseline di regressione — deve
// passare identico sia con l'implementazione precedente (spawnSync) sia con
// quella nuova (client condiviso o proprio, sempre in-process).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mqtt from "mqtt";
import { notifyPlannerOfOrphanedTickets } from "./yano-watcher-registry.mjs";
import { projectKey } from "./yano-trace-storage.mjs";

const brokerUrl = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
// The implementation derives the MQTT scope itself via projectKey(row.root,
// row.name) — it never reads a `project_key` field off `row` — so the test
// must compute the expected topic the same way rather than assuming one.
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-notify-orphaned-"));
const row = { root: projectRoot, name: "fixture-notify-orphaned" };
const scope = projectKey(row.root, row.name);
const run = { id: "run-orphaned-1" };
const orphaned = [{ ticket: { id: "T-1", assigned_instance: "coder-01" } }];

const plannerPane = { pane_id: "p-planner", workspace_id: "w1", cwd: row.root };
const plannerAgent = { name: "planner-01", workspace_id: "w1", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle", last_heartbeat: new Date().toISOString() };
const snapshot = {
	workspaces: [{ workspace_id: "w1", label: row.name }],
	panes: [plannerPane],
	agents: [plannerAgent],
	tabs: [{ tab_id: "t-planner", workspace_id: "w1", label: "planner-01" }],
};

const subscriber = await mqtt.connectAsync(brokerUrl, { connectTimeout: 3000 });
const topic = `pi/${scope}/agents/planner-01/commands`;
await subscriber.subscribeAsync(topic, { qos: 1 });

const received = new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error(`timed out waiting for a message on ${topic}`)), 5000);
	subscriber.once("message", (_topic, payload) => { clearTimeout(timer); resolve(JSON.parse(payload.toString())); });
});

const result = await notifyPlannerOfOrphanedTickets(row, snapshot, run, orphaned);
assert.equal(result.notified, true, "must report success when a healthy live planner is found");
assert.equal(result.planner_instance, "planner-01");
assert.deepEqual(result.ticket_ids, ["T-1"]);

const message = await received;
assert.equal(message.type, "watcher_specialist_recovery");
assert.equal(message.sender_instance, "yano-watcher");
assert.equal(message.sender_role, "watcher");
assert.equal(message.run_id, run.id);
assert.match(message.prompt, /T-1/);
assert.match(message.prompt, /Non creare ticket duplicati/);

await subscriber.endAsync();
console.log("notifyPlannerOfOrphanedTickets smoke test passed.");
