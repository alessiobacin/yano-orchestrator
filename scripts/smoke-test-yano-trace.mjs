// Verifica la superficie CLI del tracing globale: modalità per progetto,
// directory fuori dal repository e cancellazione filtrata/totale.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { ensureTraceProject, clearTraceData, getTraceConfig, projectKey, setTraceMode, tracePaths, traceProjectKeys } from "./yano-trace-storage.mjs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-cli-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-project-"));
const previous = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = dataDir;

try {
	assert.equal(getTraceConfig({ cwd, project: "trace-smoke" }).mode, "events");
	assert.equal(setTraceMode({ cwd, project: "trace-smoke", mode: "full" }).mode, "full");
	assert.equal(projectKey(cwd, "Trace Smoke"), projectKey(cwd, "trace-smoke"), "human project name and MQTT alias share one canonical trace key");
	assert.ok(traceProjectKeys({ cwd, project: "trace-smoke" }).length >= 1, "trace exposes canonical and legacy alias keys for migration");
	const paths = ensureTraceProject({ cwd, project: "trace-smoke" });
	assert.ok(paths.projectDir.startsWith(dataDir));
	assert.ok(!paths.projectDir.startsWith(cwd));
	const file = tracePaths({ cwd, project: "trace-smoke", instance: "coder-01" }).instanceLog;
	fs.appendFileSync(file, [
		JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", instance: "coder-01", run_id: "run-a", type: "tool_execution_start" }),
		JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", instance: "coder-01", run_id: "run-b", type: "tool_execution_end" }),
	].join("\n") + "\n");
	const partial = clearTraceData({ cwd, project: "trace-smoke", run: "run-a" });
	assert.equal(partial.events, 1);
	assert.match(fs.readFileSync(file, "utf8"), /run-b/);
	assert.doesNotMatch(fs.readFileSync(file, "utf8"), /run-a/);
	const all = clearTraceData({ all: true });
	assert.equal(all.all, true);
	assert.ok(!fs.existsSync(dataDir));
	console.log("YANO TRACE SMOKE TEST PASSED");
} finally {
	if (previous === undefined) delete process.env.YANO_DATA_DIR;
	else process.env.YANO_DATA_DIR = previous;
	try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* cleanup */ }
}
