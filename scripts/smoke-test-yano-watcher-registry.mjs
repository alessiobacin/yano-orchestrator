import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runYanoWatcherRegistry } from "./yano-watcher-registry.mjs";
import { readTraceRecords } from "./yano-trace-storage.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-registry-"));
const projectRoot = path.join(root, "llmproxy");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "llmproxy" }));
const previous = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = dataDir;

async function call(sub, ...args) {
	return runYanoWatcherRegistry({ argv: [sub, "--project-root", projectRoot, ...args] });
}

try {
	const initialized = await call("init", "--project", "llmproxy", "--lookback-ms", "3600000", "--json");
	assert.equal(initialized.project.interval_ms, 60000, "un watcher senza override controlla ogni minuto");
	assert.equal(initialized.project.lookback_ms, 3600000);
	assert.equal(initialized.project.worker_status, "running");

	const once = await call("start", "--once", "--json");
	assert.equal(once.once, true);
	assert.equal(once.worker_started, false);
	assert.equal(once.read_only, true);

	const started = await call("start", "--foreground", "--json");
	assert.equal(started.worker_status, "running");
	assert.equal(started.already_running, true, "start is idempotent when init already owns a live Herdr watcher");

	// The init-created watcher remains Herdr-managed and observable; the
	// idempotent start above must not replace it with a duplicate foreground
	// process.
	const statusRunning = await call("status", "--json");
	assert.equal(statusRunning.worker_status, "running");
	assert.equal(statusRunning.live, "running");
	assert.equal(statusRunning.drift, false);
	assert.equal(statusRunning.recovered, false);

	const dryRun = await call("start", "--dry-run", "--json");
	assert.equal(dryRun.worker_status, "planned");
	assert.equal(dryRun.dry_run, true);
	const statusPlanned = await call("status", "--json");
	assert.equal(statusPlanned.worker_status, "planned");
	assert.equal(statusPlanned.live, null); // not "running": explicit state is respected, no heal attempted

	const paused = await call("pause", "--json");
	assert.equal(paused.worker_status, "paused");
	const statusPaused = await call("status", "--json");
	assert.equal(statusPaused.worker_status, "paused");
	assert.equal(statusPaused.live, null);

	const resumed = await call("resume", "--foreground", "--json");
	assert.equal(resumed.worker_status, "running");
	assert.equal(resumed.supervisor, "foreground");

	const listAll = await runYanoWatcherRegistry({ argv: ["status", "--json"] });
	assert.equal(Array.isArray(listAll), true);
	assert.equal(listAll.length, 1);
	assert.equal(listAll[0].name, "llmproxy");

	const neverRegisteredRoot = path.join(root, "never-registered");
	fs.mkdirSync(neverRegisteredRoot, { recursive: true });
	await assert.rejects(() => runYanoWatcherRegistry({ argv: ["pause", "--project-root", neverRegisteredRoot] }), /non registrato/);

	const trace = readTraceRecords({ cwd: projectRoot, project: "llmproxy" });
	assert.ok(trace.some((record) => record.type === "watcher_registry_pause"));
	assert.ok(trace.some((record) => record.type === "watcher_registry_resume"));
	console.log("smoke-test-yano-watcher-registry: ok");
} finally {
	if (previous === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previous;
	fs.rmSync(root, { recursive: true, force: true });
}
