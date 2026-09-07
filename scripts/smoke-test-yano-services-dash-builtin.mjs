#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-services-dash-"));
process.env.YANO_DATA_DIR = dataDir;
delete process.env.YANO_DISABLE_BUILTIN_DEPENDENCY_SUPERVISION;
delete process.env.YANO_DASH_AUTOSTART;

const { listServices } = await import("./yano-services.mjs");
const { writeDashState } = await import("./yano-dash-state.mjs");

console.log("=== yano-dash appears as a builtin when no state file exists ===");
{
	const services = listServices({ includeBuiltIns: true });
	const dash = services.find((service) => service.name === "yano-dash");
	assert.ok(dash, "yano-dash deve comparire come builtin");
	assert.equal(dash.restart.type, "command");
	assert.equal(dash.restart.target, "yano dash start --no-open");
}
console.log("   OK");

console.log("=== the healthcheck target follows the state file's current port ===");
{
	writeDashState({ pid: process.pid, port: 11007, url: "http://127.0.0.1:11007/", started_at: new Date().toISOString() });
	const services = listServices({ includeBuiltIns: true });
	const dash = services.find((service) => service.name === "yano-dash");
	assert.match(dash.healthcheck.target, /:11007\/healthz$/);
}
console.log("   OK");

console.log("=== YANO_DASH_AUTOSTART=0 disables the builtin without affecting other builtins ===");
{
	process.env.YANO_DASH_AUTOSTART = "0";
	const services = listServices({ includeBuiltIns: true });
	assert.equal(services.some((service) => service.name === "yano-dash"), false);
	delete process.env.YANO_DASH_AUTOSTART;
}
console.log("   OK");

console.log("\nAll yano-services yano-dash builtin tests passed.");
