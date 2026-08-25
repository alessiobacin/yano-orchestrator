import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-suggester-"));
const projectRoot = path.join(root, "sample-project");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "sample-project" }, null, 2));
fs.writeFileSync(path.join(projectRoot, "README.md"), "sample project\n");
const before = crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "package.json"))).digest("hex");
const previousDataDir = process.env.YANO_DATA_DIR;
const previousBroker = process.env.PI_ORCH_BROKER_URL;
process.env.YANO_DATA_DIR = dataDir;
process.env.PI_ORCH_BROKER_URL = "mqtt://127.0.0.1:1";

const { runYanoSuggester } = await import("./yano-suggester.mjs");
async function call(sub, ...args) { return runYanoSuggester({ argv: [sub, "--project-root", projectRoot, ...args] }); }

try {
	const initialized = await call("init", "--project", "sample-project", "--notify", "none");
	assert.equal(initialized.read_only, true);
	assert.equal(initialized.project.worker_status, "stopped");
	const submitted = await call("submit", "--title", "Export CSV", "--description", "Vorrei esportare la vista", "--source", "user", "--priority", "medium", "--dry-run");
	assert.equal(submitted.read_only, true);
	assert.equal(submitted.dispatched.launched.dry_run, true);
	assert.match(submitted.dispatched.launched.command, /--role suggester/);
	assert.ok(fs.existsSync(submitted.dispatched.launched.evidence_path));
	assert.ok(fs.existsSync(submitted.dispatched.launched.report_path));
	const duplicate = await call("submit", "--title", "Export CSV", "--description", "Vorrei esportare la vista", "--source", "user", "--priority", "medium", "--queue-only");
	assert.equal(duplicate.duplicate, true);
	const completed = await call("complete", "--suggestion-id", submitted.suggestion_id, "--report-file", submitted.dispatched.launched.report_path, "--category", "feature", "--summary", "Exportare la vista corrente", "--value", "Riduce lavoro manuale", "--complexity", "medium", "--risk", "low", "--confidence", "high");
	assert.equal(completed.status, "awaiting_approval");
	assert.equal(completed.planner_notified, false);
	const approved = await runYanoSuggester({ argv: ["approve", "--project-root", projectRoot, "--suggestion-id", submitted.suggestion_id, "--actor", "superadmin", "--yes"] });
	assert.equal(approved.status, "accepted");
	assert.equal(approved.planner.delivered, 0);
	assert.equal(Object.keys(approved.notifications).length, 0);
	const status = await call("status");
	assert.equal(status.suggestions[0].status, "accepted");
	assert.equal(status.analyses[0].category, "feature");
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "package.json"))).digest("hex"), before);
	console.log("smoke-test-yano-suggester: ok");
} finally {
	if (previousDataDir === undefined) delete process.env.YANO_DATA_DIR; else process.env.YANO_DATA_DIR = previousDataDir;
	if (previousBroker === undefined) delete process.env.PI_ORCH_BROKER_URL; else process.env.PI_ORCH_BROKER_URL = previousBroker;
	fs.rmSync(root, { recursive: true, force: true });
}
