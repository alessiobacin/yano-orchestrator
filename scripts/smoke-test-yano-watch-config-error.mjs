import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRawTraceRecord } from "./yano-trace-storage.mjs";
import { runWatch } from "./watch-stalls.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watch-config-error-"));
const projectRoot = path.join(root, "project");
fs.mkdirSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage"), { recursive: true });
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const db = new DatabaseSync(path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage", "orchestrator.db"));
db.exec("CREATE TABLE tickets (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, assigned_instance TEXT, run_id TEXT, title TEXT)");
db.close();

const previous = {};
for (const key of ["XDG_CONFIG_HOME", "YANO_DATA_DIR", "YANO_ORCHESTRATOR_REPO", "TELEGRAM_BOT_TOKEN", "TELEGRAM_DESTINATION_CHAT_ID", "PI_ORCH_BROKER_URL"]) {
	previous[key] = process.env[key];
	delete process.env[key];
}
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.YANO_DATA_DIR = path.join(root, "trace");
process.env.PI_ORCH_BROKER_URL = "mqtt://127.0.0.1:1";
appendRawTraceRecord({ cwd: projectRoot, project: "project", record: { type: "agent_send_no_live_target", id: "missing-config-finding", ts: new Date().toISOString() } });

try {
	await assert.rejects(
		runWatch({ cwd: projectRoot, argv: ["--once", "--project", "project"], packageRoot: path.join(root, "global-package") }),
		(error) => error?.code === "YANO_CONFIG_MISSING" && /YANO_ORCHESTRATOR_REPO/.test(error.message) && /yano config set/.test(error.message),
		"un finding Yano senza repository deve restituire un errore configurabile",
	);
	console.log("smoke-test-yano-watch-config-error: ok");
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
