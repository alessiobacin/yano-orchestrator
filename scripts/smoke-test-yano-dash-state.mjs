#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-state-"));
process.env.YANO_DATA_DIR = dataDir;

const { DASH_PORT, dashStatePath, readDashState, writeDashState, processAlive } = await import("./yano-dash-state.mjs");

console.log("=== DASH_PORT ===");
assert.equal(DASH_PORT.default, 11000);
assert.equal(DASH_PORT.min, 11000);
assert.equal(DASH_PORT.max, 11999);
console.log("   OK");

console.log("=== readDashState with no file ===");
assert.equal(readDashState(), null);
console.log("   OK");

console.log("=== writeDashState / readDashState round-trip ===");
const state = { pid: process.pid, port: 11007, url: "http://127.0.0.1:11007/", started_at: new Date().toISOString() };
writeDashState(state);
assert.deepEqual(readDashState(), state);
assert.equal(fs.existsSync(dashStatePath()), true);
console.log("   OK");

console.log("=== processAlive ===");
assert.equal(processAlive(process.pid), true);
assert.equal(processAlive(999999999), false);
assert.equal(processAlive(null), false);
assert.equal(processAlive(undefined), false);
console.log("   OK");

console.log("\nAll yano-dash-state tests passed.");
