// Regression coverage for the controlled `yano update --reload` planner.
// The dry-run path deliberately requires no Herdr process and never calls the
// injected updater: it validates project scoping, active-run discovery and the
// safety gate without mutating a real installation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runControlledReload } from "./yano-recovery.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-reload-") );
const project = "reload-smoke";
const workspace = path.join(root, ".pi", "extensions", "yano-orchestrator");
const dbPath = path.join(workspace, "orchestratorStorage", "orchestrator.db");
fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.writeFileSync(path.join(workspace, "config", "project.json"), JSON.stringify({ project }));
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
const now = new Date().toISOString();
db.prepare("INSERT INTO runs (id, project, objective, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run("run-reload", project, "reload smoke", now, now);
db.close();

const previousDataDir = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = path.join(root, "temp");
let called = false;
try {
	const result = await runControlledReload({
		cwd: root,
		packageRoot: root,
		argv: ["--reload", "--dry-run", "--project", project],
		update: async () => { called = true; return { newVersion: "never" }; },
	});
	assert.equal(result.dryRun, true, "reload dry-run returns a preview result");
	assert.equal(result.runs[0].id, "run-reload", "reload preview discovers the active run");
	assert.equal(called, false, "dry-run never invokes the updater");
	console.log("smoke-test-update-reload: OK (dry-run safety gate and active-run discovery)");
} finally {
	if (previousDataDir === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previousDataDir;
}
