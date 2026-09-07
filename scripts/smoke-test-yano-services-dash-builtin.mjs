#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
	assert.match(dash.restart.target, /^nohup .*yano dash start --no-open.*&$/, "the restart command must background+detach itself: yano dash start never exits on its own, and runRestart() uses a 30s-timeout spawnSync that would kill it otherwise");
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

console.log("=== a nohup-backgrounded, never-exiting restart command actually survives instead of being killed by runRestart's 30s spawnSync timeout ===");
// This does NOT invoke the bare "yano" command (the globally-linked one on
// this machine may point at a different installed copy, not this checkout)
// — it registers an ordinary service whose restart target follows the exact
// same "nohup ... &" shape builtinDashService() now uses, and proves the
// underlying spawnSync+shell+nohup mechanism actually detaches a
// long-running child instead of blocking on it. Before this fix,
// yano-dash's restart command was the bare foreground command (no nohup/&),
// which would have hung superviseExternalServices() for ~30s and then
// killed the dashboard it had just started.
{
	const { addService, superviseExternalServices } = await import("./yano-services.mjs");
	const markerFile = path.join(dataDir, "long-running-marker.txt");
	const longRunningScript = path.join(dataDir, "long-running.mjs");
	fs.writeFileSync(longRunningScript, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, "started\\n"); setInterval(() => {}, 1000);`);
	addService({
		name: "long-running-test-service",
		healthcheck: { type: "command", target: `test -f ${JSON.stringify(markerFile)}` },
		restart: { type: "command", target: `nohup node ${JSON.stringify(longRunningScript)} >/dev/null 2>&1 &` },
	});
	const startedAt = Date.now();
	await superviseExternalServices({ includeBuiltIns: false });
	const elapsedMs = Date.now() - startedAt;
	assert.ok(elapsedMs < 5000, `un restart nohup-backgrounded deve tornare quasi subito, non bloccare per il timeout di 30s di runRestart (impiegati ${elapsedMs}ms)`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.ok(fs.existsSync(markerFile), "il processo di restart deve essere partito davvero");
	const stillAlive = spawnSync("pgrep", ["-f", longRunningScript], { encoding: "utf8" });
	assert.equal(stillAlive.status, 0, "il processo di lunga durata deve essere ancora vivo, non ucciso dal timeout di spawnSync — questa è esattamente la regressione che il comando 'yano dash start' non-backgrounded avrebbe causato");
	spawnSync("pkill", ["-f", longRunningScript]);
}
console.log("   OK");

console.log("\nAll yano-services yano-dash builtin tests passed.");
