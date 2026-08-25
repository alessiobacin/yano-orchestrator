import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-auto-improver-"));
const projectRoot = path.join(root, "sample-project");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "sample-project", scripts: { test: "node test.mjs" } }, null, 2));
fs.writeFileSync(path.join(projectRoot, "README.md"), "sample project\n");
const before = crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "package.json"))).digest("hex");
const previousDataDir = process.env.YANO_DATA_DIR;
const previousBroker = process.env.PI_ORCH_BROKER_URL;
process.env.YANO_DATA_DIR = dataDir;
process.env.PI_ORCH_BROKER_URL = "mqtt://127.0.0.1:1";

const { runYanoAutoImprove } = await import("./yano-auto-improver.mjs");

async function call(sub, ...args) {
	return runYanoAutoImprove({ argv: [sub, "--project-root", projectRoot, ...args] });
}

try {
	const initialized = await call("init", "--project", "sample-project", "--interval", "5d", "--notify", "none", "--json");
	assert.equal(initialized.read_only, true);
	assert.equal(initialized.project.interval_ms, 5 * 24 * 60 * 60 * 1000);

	const planned = await call("run", "--dry-run", "--no-daemon", "--json");
	assert.equal(planned.read_only, true);
	assert.equal(planned.launched.dry_run, true);
	assert.match(planned.launched.command, /--role auto-improver/);
	assert.ok(fs.existsSync(planned.evidencePath));
	assert.ok(fs.existsSync(planned.reportPath));
	const evidence = JSON.parse(fs.readFileSync(planned.evidencePath, "utf8"));
	assert.equal(evidence.read_only, true);
	assert.equal(evidence.project.root, projectRoot);
	assert.equal(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8").includes("sample-project"), true);

	const summaryFile = path.join(dataDir, "auto-improver", "summary.json");
	fs.writeFileSync(summaryFile, JSON.stringify({ summary: "Audit completato senza modifiche al progetto." }));
	const completed = await runYanoAutoImprove({ argv: ["complete", "--audit-id", planned.auditId, "--report-file", planned.reportPath, "--summary-file", summaryFile, "--json"] });
	assert.equal(completed.status, "completed");
	assert.equal(completed.planner.delivered, 0);
	assert.equal(completed.notifications && Object.keys(completed.notifications).length, 0);

	const status = await call("status", "--json");
	assert.equal(status.project.worker_status, "idle");
	assert.equal(status.audits[0].status, "completed");
	assert.equal(status.audits[0].summary, "Audit completato senza modifiche al progetto.");
	assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(projectRoot, "package.json"))).digest("hex"), before);
	console.log("smoke-test-yano-auto-improver: ok");
} finally {
	if (previousDataDir === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previousDataDir;
	if (previousBroker === undefined) delete process.env.PI_ORCH_BROKER_URL;
	else process.env.PI_ORCH_BROKER_URL = previousBroker;
	fs.rmSync(root, { recursive: true, force: true });
}
