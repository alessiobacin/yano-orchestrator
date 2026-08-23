// Regression coverage for non-destructive pause/resume and legacy workspace
// discovery. The fixture deliberately uses an arbitrary old extension folder:
// the recovery command must select it from project.json, never create a
// second database in the canonical folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runRecovery } from "./yano-recovery.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-recovery-"));
const project = "recovery-smoke";
const legacyWorkspace = path.join(root, ".pi", "extensions", "legacy-extension");
const dbPath = path.join(legacyWorkspace, "orchestratorStorage", "orchestrator.db");
fs.mkdirSync(path.join(legacyWorkspace, "config"), { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.writeFileSync(path.join(legacyWorkspace, "config", "project.json"), JSON.stringify({ project }));
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, objective TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'generic', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', assigned_instance TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ticket_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE TABLE checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, label TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
`);
const now = new Date().toISOString();
db.prepare("INSERT INTO runs (id, project, objective, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("run-recovery", project, "recovery test", now, now);
db.prepare("INSERT INTO tickets (id, run_id, title, description, status, assigned_instance, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)").run("ticket-recovery", "run-recovery", "worker task", "worktree_path=/tmp/missing-worktree", "coderA-01", now, now);
db.close();

const previousDataDir = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = path.join(root, "yano-temp");
try {
	await runRecovery({ cwd: root, argv: ["pause", "--project", project, "--run", "run-recovery"] });
	assert.ok(fs.existsSync(path.join(root, ".pi", "extensions", "legacy-extension", "orchestratorStorage", "orchestrator.db")), "legacy DB remains in place");
	assert.ok(!fs.existsSync(path.join(root, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage", "orchestrator.db")), "no duplicate modern DB is created");
	const recoveryRoot = path.join(root, "yano-temp", "recovery", project, "run-recovery");
	const snapshots = fs.readdirSync(recoveryRoot);
	assert.equal(snapshots.length, 1, "one recovery snapshot is written");
	const snapshot = JSON.parse(fs.readFileSync(path.join(recoveryRoot, snapshots[0], "snapshot.json"), "utf8"));
	assert.equal(snapshot.assignments[0].instance, "coderA-01", "running assignment is captured");
	await runRecovery({ cwd: root, argv: ["resume", "--project", project, "--run", "run-recovery", "--dry-run"] });
	const check = new DatabaseSync(dbPath, { readOnly: true });
	assert.equal(check.prepare("SELECT status FROM runs WHERE id = ?").get("run-recovery").status, "active", "pause never closes the run");
	assert.equal(check.prepare("SELECT status FROM tickets WHERE id = ?").get("ticket-recovery").status, "running", "pause never rewrites ticket state");
	check.close();
	console.log("smoke-test-yano-recovery: OK (checkpoint, legacy DB, dry-run resume, state preserved)");
} finally {
	if (previousDataDir === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previousDataDir;
}
