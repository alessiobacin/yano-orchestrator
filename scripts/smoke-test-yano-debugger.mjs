import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runYanoDebugger } from "./yano-debugger.mjs";
import { readTraceRecords } from "./yano-trace-storage.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-debugger-") );
const projectRoot = path.join(root, "focusboard");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "focusboard" }));
const previous = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = dataDir;

async function call(sub, ...args) {
	return runYanoDebugger({ argv: [sub, "--project-root", projectRoot, ...args] });
}

try {
	const initialized = await call("init", "--project", "focusboard", "--base-port", "3055", "--interval-ms", "5000", "--json");
	assert.equal(initialized.ports.backend.development, 3055);
	assert.equal(initialized.ports.backend.staging, 4055);
	assert.equal(initialized.ports.backend.production, 5055);
	assert.equal(initialized.ports.frontend.development, 6055);
	assert.equal(initialized.ports.frontend.staging, 7055);
	assert.equal(initialized.ports.frontend.production, 8055);
	const once = await call("start", "--once", "--json");
	assert.equal(once.once, true);
	assert.equal(once.worker_started, false);
	assert.equal(once.read_only, true);

	const started = await call("start", "--foreground", "--json");
	assert.equal(started.worker_status, "running");
	assert.equal(started.supervisor, "foreground");
	assert.equal(started.ports.backend.development, 3055);
	const dryRun = await call("start", "--dry-run", "--json");
	assert.equal(dryRun.worker_status, "planned");
	assert.equal(dryRun.dry_run, true);
	assert.match(dryRun.command, /--role debugger/);

	const report = await call("report", "--title", "Salvataggio non riuscito", "--description", "Il salvataggio restituisce 500 dopo aver compilato il form", "--severity", "high", "--source", "user", "--reporter", "qa@example.test", "--expected", "201 Created", "--actual", "500 Internal Server Error", "--steps", "apri form\ncompila titolo\ninvia", "--environment", '{"browser":"test","os":"test"}', "--json");
	assert.equal(report.duplicate, false);
	assert.equal(report.bug.status, "reported");
	const bugId = report.bug.bug_id;

	const duplicate = await call("report", "--title", "Salvataggio non riuscito", "--description", "Il salvataggio restituisce 500 dopo aver compilato il form", "--severity", "high", "--source", "user", "--reporter", "qa@example.test", "--expected", "201 Created", "--actual", "500 Internal Server Error", "--steps", "apri form\ncompila titolo\ninvia", "--environment", '{"browser":"test","os":"test"}', "--json");
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.bug.bug_id, bugId);

	await call("claim", "--bug-id", bugId, "--actor", "debugger-focusboard", "--json");
	for (const state of ["triaged", "reproducing", "not_reproducible"]) {
		const transitioned = await call("transition", "--bug-id", bugId, "--to", state, "--actor", "debugger-focusboard", "--json");
		assert.equal(transitioned.status, state);
	}
	await assert.rejects(() => call("transition", "--bug-id", bugId, "--to", "fixing", "--actor", "debugger-focusboard"), /stato non valido|stato non diagnostico/);
	await assert.rejects(() => call("promote", "--bug-id", bugId, "--deployment-id", "staging-deploy-42", "--actor", "superadmin", "--yes"), /read-only/);

	const paused = await call("pause", "--json");
	assert.equal(paused.worker_status, "paused");
	const resumed = await call("resume", "--foreground", "--json");
	assert.equal(resumed.worker_status, "running");
	assert.equal(resumed.supervisor, "foreground");

	const status = await call("status", "--bug-id", bugId, "--json");
	assert.equal(status.status, "not_reproducible");
	const trace = readTraceRecords({ cwd: projectRoot, project: "focusboard" });
	assert.ok(trace.some((record) => record.type === "debug_report_received"));
	assert.ok(trace.some((record) => record.type === "debug_state_changed" && record.status === "not_reproducible"));
	assert.ok(trace.some((record) => record.type === "debugger_pause"));
	console.log("smoke-test-yano-debugger: ok");
} finally {
	if (previous === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previous;
	fs.rmSync(root, { recursive: true, force: true });
}
