// Regression test for Fase 2 (heartbeat unification): before this, the
// application-level file heartbeat that every agent process writes on each
// presence publish was consulted ONLY for the 3 global services (with its
// own duplicated, subtly buggy path/key derivation). Per-project
// planner/agent liveness relied solely on the MQTT-retained `last_heartbeat`
// or Herdr's own process/explain heuristics — neither of which can tell
// "process alive, event loop wedged" apart from healthy. This checks the one
// canonical reader (yano-trace-storage.mjs) is used by both call sites and
// closes the wedge-detection gap for the Herdr-fallback branch.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-heartbeat-unify-"));
process.env.YANO_DATA_DIR = root;
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");

const { applicationHeartbeatPath, projectKey, readApplicationHeartbeat, traceRoot } = await import("./yano-trace-storage.mjs");

console.log("Fase 2: heartbeat unification (one canonical file reader for global services + per-project agents)");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-heartbeat-project-"));

function writeHeartbeat(instance, { ageMs = 0, status = "idle" } = {}) {
	const file = applicationHeartbeatPath(projectRoot, instance);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const observedAt = new Date(Date.now() - ageMs).toISOString();
	fs.writeFileSync(file, JSON.stringify({ observed_at: observedAt, status }));
	return file;
}

check("applicationHeartbeatPath resolves under traceRoot()/heartbeats/<projectKey>/<instance>.json — matching what orchestrator.ts's publishPresence() writes", () => {
	const file = applicationHeartbeatPath(projectRoot, "planner-01");
	assert.equal(file, path.join(traceRoot(), "heartbeats", projectKey(projectRoot), "planner-01.json"));
});

check("a fresh heartbeat file reads as healthy", () => {
	writeHeartbeat("planner-01", { ageMs: 1000 });
	const result = readApplicationHeartbeat(projectRoot, "planner-01", { maxAgeMs: 60_000 });
	assert.equal(result.healthy, true);
	assert.equal(result.found, true);
});

check("a stale heartbeat file (older than maxAgeMs) reads as unhealthy — this is the wedge signal", () => {
	writeHeartbeat("planner-01", { ageMs: 5 * 60_000 });
	const result = readApplicationHeartbeat(projectRoot, "planner-01", { maxAgeMs: 60_000 });
	assert.equal(result.healthy, false);
	assert.equal(result.found, true);
});

check("a missing heartbeat file (never published yet — e.g. warm-up) is reported as not found, distinct from stale", () => {
	const result = readApplicationHeartbeat(projectRoot, "instance-that-never-started", { maxAgeMs: 60_000 });
	assert.equal(result.healthy, false);
	assert.equal(result.found, false);
});

check("two different cwds never collide on the same heartbeat file (per-project isolation)", () => {
	const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-heartbeat-other-"));
	writeHeartbeat("planner-01", { ageMs: 1000 });
	assert.notEqual(applicationHeartbeatPath(projectRoot, "planner-01"), applicationHeartbeatPath(otherRoot, "planner-01"));
	fs.rmSync(otherRoot, { recursive: true, force: true });
});

// Stub herdr on PATH so the watcher-registry's Herdr-fallback branch (used
// when no MQTT last_heartbeat is present) runs deterministically without a
// real Herdr install: a live "pi" process, explained as idle.
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-heartbeat-herdr-bin-"));
const stub = path.join(binDir, "herdr");
fs.writeFileSync(stub, [
	"#!/usr/bin/env node",
	"const args = process.argv.slice(2);",
	"if (args[0] === 'pane' && args[1] === 'process-info') {",
	"  console.log(JSON.stringify({ result: { process_info: { foreground_processes: [{ pid: 4242, argv0: 'pi' }] } } }));",
	"} else if (args[0] === 'agent' && args[1] === 'explain') {",
	"  console.log(JSON.stringify({ state: 'idle' }));",
	"} else { console.log('{}'); }",
].join("\n"));
fs.chmodSync(stub, 0o755);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

const { plannerHeartbeatHealthy } = await import("./yano-watcher-registry.mjs");

check("a planner with no MQTT heartbeat, a live Herdr pane, but a STALE file heartbeat is judged dead (the wedge case)", () => {
	writeHeartbeat("planner-01", { ageMs: 5 * 60_000 });
	assert.equal(plannerHeartbeatHealthy({ agent_status: "idle", cwd: projectRoot, name: "planner-01", pane_id: "pane-1" }), false);
});

check("a planner with no MQTT heartbeat, a live Herdr pane, and a FRESH file heartbeat is judged healthy", () => {
	writeHeartbeat("planner-01", { ageMs: 1000 });
	assert.equal(plannerHeartbeatHealthy({ agent_status: "idle", cwd: projectRoot, name: "planner-01", pane_id: "pane-1" }), true);
});

check("a planner with no MQTT heartbeat, a live Herdr pane, and NO file heartbeat yet (warm-up) still relies on the pre-existing Herdr signal", () => {
	const warmupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-heartbeat-warmup-"));
	assert.equal(plannerHeartbeatHealthy({ agent_status: "idle", cwd: warmupRoot, name: "planner-01", pane_id: "pane-1" }), true);
	fs.rmSync(warmupRoot, { recursive: true, force: true });
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
console.log(`\nsmoke-test-heartbeat-unification: ${passed} passed`);
