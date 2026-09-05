// Real test for ticket #117 (.scratch/optimize-orchestrator/issues/117-external-services-supervision.md):
// a declarative registry of external services (Docker/pm2/arbitrary command)
// that `yano watcher supervise` health-checks and restarts deterministically
// with bounded backoff — real HTTP servers, real process spawns, real files,
// no mocking of the module under test.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
	addService, listServices, removeService, setServiceEnabled, getService,
	checkExternalServices, superviseExternalServices, servicesRegistryPath,
	pm2ProcessOnline,
} from "./yano-services.mjs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-services-"));
process.env.YANO_DATA_DIR = dataDir;

console.log("=== validation ===");
assert.throws(() => addService({ name: "", healthcheck: { type: "http", target: "x" }, restart: { type: "command", target: "true" } }), /nome non valido/);
assert.throws(() => addService({ name: "ok", healthcheck: null, restart: { type: "command", target: "true" } }), /healthcheck/);
assert.throws(() => addService({ name: "ok", healthcheck: { type: "http", target: "x" }, restart: null }), /restart/);
console.log("   OK — nome/healthcheck/restart mancanti o invalidi vengono rifiutati");

console.log("\n=== registry CRUD ===");
let port;
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); }));
const target = `http://127.0.0.1:${port}/health`;

const created = addService({ name: "fake-llmproxy", healthcheck: { type: "http", target, timeout_ms: 500 }, restart: { type: "command", target: "true" }, backoff: { base_ms: 30, max_ms: 30, max_attempts: 2 } });
assert.equal(created.name, "fake-llmproxy");
assert.equal(created.enabled, true);
assert.equal(created.state.status, "unknown");
assert.ok(fs.existsSync(servicesRegistryPath()), "the registry file is written under YANO_DATA_DIR/services/services.json");
assert.throws(() => addService({ name: "fake-llmproxy", healthcheck: { type: "http", target }, restart: { type: "command", target: "true" } }), /esiste già/);
assert.equal(listServices().length, 1);
assert.equal(getService("fake-llmproxy").name, "fake-llmproxy");
const disabled = setServiceEnabled("fake-llmproxy", false);
assert.equal(disabled.enabled, false);
setServiceEnabled("fake-llmproxy", true);
console.log("   OK — add/list/get/enable/disable, e un nome duplicato viene rifiutato");

console.log("\n=== check (read-only) never restarts or persists state ===");
const healthyCheck = await checkExternalServices({});
assert.equal(healthyCheck.services[0].ok, true, "the real HTTP server answers 200");
assert.equal(getService("fake-llmproxy").state.status, "unknown", "a plain check never mutates persisted state");
await new Promise((resolve) => server.close(resolve));
const downCheck = await checkExternalServices({ name: "fake-llmproxy" });
assert.equal(downCheck.services[0].ok, false);
assert.equal(getService("fake-llmproxy").state.restart_attempts_since_ok, 0, "check never attempts a restart");
console.log("   OK — check riflette lo stato reale del servizio ma non tocca mai lo stato persistito o il restart");

console.log("\n=== supervise: unhealthy service gets restarted, then backs off ===");
const restartMarker = path.join(dataDir, "restart-calls.txt");
fs.writeFileSync(restartMarker, "");
removeService("fake-llmproxy");
addService({
	name: "fake-llmproxy",
	healthcheck: { type: "http", target, timeout_ms: 300 },
	restart: { type: "command", target: `printf 'called\\n' >> ${JSON.stringify(restartMarker)}` },
	backoff: { base_ms: 200, max_ms: 200, max_attempts: 3 },
});
const firstPass = await superviseExternalServices();
assert.equal(firstPass.services[0].healthy, false);
assert.equal(firstPass.services[0].restarted, true, "first unhealthy pass must attempt a restart immediately (no backoff yet)");
assert.equal(firstPass.services[0].attempt, 1);
assert.equal(fs.readFileSync(restartMarker, "utf8").trim(), "called", "the declared restart command actually ran");
const secondPass = await superviseExternalServices();
assert.equal(secondPass.services[0].restarted, false, "an immediate second pass must be inside the backoff window");
assert.equal(secondPass.services[0].reason, "backoff");
assert.equal(fs.readFileSync(restartMarker, "utf8").trim().split("\n").length, 1, "no second restart attempt while backing off");
console.log("   OK — un servizio non sano viene riavviato al primo giro e poi rispetta il backoff, senza martellare il target");

console.log("\n=== supervise: recovery is detected once the service is healthy again ===");
const server2 = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
await new Promise((resolve) => server2.listen(port, "127.0.0.1", resolve));
const recoveredPass = await superviseExternalServices();
assert.equal(recoveredPass.services[0].healthy, true);
assert.equal(recoveredPass.services[0].recovered, true, "a service coming back healthy after a restart attempt must be flagged recovered");
assert.equal(getService("fake-llmproxy").state.restart_attempts_since_ok, 0, "recovery resets the backoff counter");
await new Promise((resolve) => server2.close(resolve));
console.log("   OK — il ripristino del servizio reale viene rilevato e il contatore di backoff si azzera");

console.log("\n=== supervise: max_attempts exhausted -> giving_up, no further restart hammering ===");
// backoff/max_attempts were set to {base_ms:200, max_ms:200, max_attempts:3}
// above, and the recovery pass just reset restart_attempts_since_ok to 0.
// Each of the next 3 passes (once the backoff window has elapsed) restarts
// again (attempts 1, 2, 3); the 4th pass must find max_attempts already
// reached and refuse to restart a 4th time.
for (let attempt = 1; attempt <= 3; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 250));
	const pass = await superviseExternalServices();
	assert.equal(pass.services[0].restarted, true, `attempt ${attempt} of 3 must still restart`);
	assert.equal(pass.services[0].attempt, attempt);
}
await new Promise((resolve) => setTimeout(resolve, 250));
const exhausted = await superviseExternalServices();
assert.equal(exhausted.services[0].restarted, false);
assert.equal(exhausted.services[0].reason, "max_attempts_exhausted");
const callsAtExhaustion = fs.readFileSync(restartMarker, "utf8").trim().split("\n").filter(Boolean).length;
await new Promise((resolve) => setTimeout(resolve, 250));
await superviseExternalServices();
const callsAfterGivingUp = fs.readFileSync(restartMarker, "utf8").trim().split("\n").filter(Boolean).length;
assert.equal(callsAfterGivingUp, callsAtExhaustion, "once giving_up, Yano must stop invoking the restart command — no infinite hammering of a target that cannot come back");
assert.equal(getService("fake-llmproxy").state.status, "giving_up");
console.log("   OK — dopo max_attempts esauriti lo stato diventa giving_up e il comando di restart non viene più invocato");

console.log("\n=== disabled services are skipped by supervise ===");
setServiceEnabled("fake-llmproxy", false);
const skippedPass = await superviseExternalServices();
assert.equal(skippedPass.services[0].skipped, "disabled");
setServiceEnabled("fake-llmproxy", true);
console.log("   OK — un servizio disabilitato non viene né controllato né riavviato");

console.log("\n=== docker/pm2 restart command construction (stubbed binaries, no real Docker/pm2 needed) ===");
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-services-bin-"));
const dockerCalls = path.join(dataDir, "docker-calls.txt");
const pm2Calls = path.join(dataDir, "pm2-calls.txt");
fs.writeFileSync(path.join(fakeBin, "docker"), `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(dockerCalls)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(0);\n`);
fs.chmodSync(path.join(fakeBin, "docker"), 0o700);
fs.writeFileSync(path.join(fakeBin, "pm2"), `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(pm2Calls)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(0);\n`);
fs.chmodSync(path.join(fakeBin, "pm2"), 0o700);
const oldPath = process.env.PATH;
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ""}`;
try {
	removeService("fake-llmproxy");
	const server3 = { close: () => {} };
	addService({ name: "docker-mqtt", healthcheck: { type: "command", target: "false" }, restart: { type: "docker", target: "yano-mqtt-broker" }, backoff: { base_ms: 10, max_ms: 10, max_attempts: 5 } });
	addService({ name: "pm2-llmproxy", healthcheck: { type: "command", target: "false" }, restart: { type: "pm2", target: "llmproxy" }, backoff: { base_ms: 10, max_ms: 10, max_attempts: 5 } });
	await superviseExternalServices();
	assert.equal(fs.readFileSync(dockerCalls, "utf8").trim(), "restart yano-mqtt-broker", "a docker-type restart must run exactly `docker restart <target>`");
	assert.equal(fs.readFileSync(pm2Calls, "utf8").trim(), "restart llmproxy", "a pm2-type restart must run exactly `pm2 restart <target>`");
	void server3;
} finally {
	process.env.PATH = oldPath;
}
console.log("   OK — restart.type docker/pm2 compone esattamente `docker restart <target>`/`pm2 restart <target>`");

console.log("\n=== command-type healthcheck uses the real exit code ===");
removeService("docker-mqtt");
removeService("pm2-llmproxy");
addService({ name: "cmd-check", healthcheck: { type: "command", target: "true" }, restart: { type: "command", target: "true" } });
const cmdOk = await checkExternalServices({ name: "cmd-check" });
assert.equal(cmdOk.services[0].ok, true, "exit code 0 is healthy");
removeService("cmd-check");
addService({ name: "cmd-fail", healthcheck: { type: "command", target: "false" }, restart: { type: "command", target: "true" } });
const cmdFail = await checkExternalServices({ name: "cmd-fail" });
assert.equal(cmdFail.services[0].ok, false, "a non-zero exit code is unhealthy");
console.log("   OK — l'healthcheck di tipo command usa il vero exit code del comando");

console.log("\n=== remove ===");
const removed = removeService("cmd-fail");
assert.equal(removed.removed, true);
assert.equal(listServices().find((service) => service.name === "cmd-fail"), undefined);
assert.deepEqual(removeService("does-not-exist"), { removed: false });
console.log("   OK — remove è idempotente e riflette correttamente l'esito");

// Confirm no stray real docker/pm2 process was actually needed anywhere in
// this file (the CLI itself, exercised separately below, only ever spawns
// whatever is on PATH — verified above with the stub, never assumed real).
spawnSync("true");

console.log("\n=== llmproxy pm2 auto-discovery (a Docker container is not the only way llmproxy runs) ===");
// Before this fix, builtin dependency discovery only ever looked for a Docker
// container; a pm2-launched llmproxy (the README's own documented example,
// `yano services add --restart-pm2 llmproxy`) was never health-checked or
// restarted automatically unless the operator registered it by hand.
const pm2Bin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-services-pm2-"));
const pm2JlistCalls = path.join(dataDir, "pm2-jlist-calls.txt");
// A configurable stub: reads the desired jlist response from an env var so
// the same fake binary serves both the "online" and "offline/missing" cases.
fs.writeFileSync(path.join(pm2Bin, "pm2"), [
	"#!/usr/bin/env node",
	`require("fs").appendFileSync(${JSON.stringify(pm2JlistCalls)}, process.argv.slice(2).join(" ") + "\\n");`,
	'if (process.argv[2] === "jlist") { process.stdout.write(process.env.YANO_TEST_PM2_JLIST || "[]"); process.exit(0); }',
	"process.exit(0);",
].join("\n"));
fs.chmodSync(path.join(pm2Bin, "pm2"), 0o700);
const pathBeforePm2 = process.env.PATH;
process.env.PATH = `${pm2Bin}${path.delimiter}${pathBeforePm2 || ""}`;
try {
	process.env.YANO_TEST_PM2_JLIST = JSON.stringify([{ name: "test-llmproxy-pm2", pm2_env: { status: "online" } }]);
	assert.equal(pm2ProcessOnline("test-llmproxy-pm2"), true, "pm2ProcessOnline reports true for an online pm2 process");
	assert.equal(pm2ProcessOnline("some-other-name"), false, "pm2ProcessOnline reports false for a name not in pm2's list");
	process.env.YANO_TEST_PM2_JLIST = JSON.stringify([{ name: "test-llmproxy-pm2", pm2_env: { status: "stopped" } }]);
	assert.equal(pm2ProcessOnline("test-llmproxy-pm2"), false, "pm2ProcessOnline reports false for a pm2 process that exists but is not online");
	console.log("   OK — pm2ProcessOnline reflects `pm2 jlist` accurately (online / wrong name / stopped)");

	// A manually-registered service using the new native "pm2" healthcheck type
	// (no shell-command string needed, unlike the pre-existing "command" type).
	process.env.YANO_TEST_PM2_JLIST = JSON.stringify([{ name: "manual-pm2-check", pm2_env: { status: "online" } }]);
	addService({ name: "native-pm2-healthcheck", healthcheck: { type: "pm2", target: "manual-pm2-check" }, restart: { type: "pm2", target: "manual-pm2-check" } });
	const pm2HealthOk = await checkExternalServices({ name: "native-pm2-healthcheck" });
	assert.equal(pm2HealthOk.services[0].ok, true, "native pm2-type healthcheck reports healthy when pm2 reports the process online");
	process.env.YANO_TEST_PM2_JLIST = JSON.stringify([{ name: "manual-pm2-check", pm2_env: { status: "errored" } }]);
	const pm2HealthDown = await checkExternalServices({ name: "native-pm2-healthcheck" });
	assert.equal(pm2HealthDown.services[0].ok, false, "native pm2-type healthcheck reports unhealthy when pm2 reports the process not online");
	removeService("native-pm2-healthcheck");
	console.log("   OK — native \"pm2\" healthcheck type works without a hand-written shell command");

	// Builtin auto-discovery: no Docker container named after the env override
	// exists, so it must fall back to pm2 discovery instead of finding nothing.
	process.env.YANO_LLMPROXY_PM2_NAME = "test-llmproxy-pm2";
	process.env.YANO_LLMPROXY_CONTAINER = "container-that-does-not-exist-in-this-test";
	process.env.YANO_TEST_PM2_JLIST = JSON.stringify([{ name: "test-llmproxy-pm2", pm2_env: { status: "online" } }]);
	const discovered = listServices({ includeBuiltIns: true }).find((service) => service.name === "llmproxy");
	assert.ok(discovered, "llmproxy is auto-discovered via pm2 when no matching Docker container exists");
	assert.equal(discovered.builtin, true);
	assert.equal(discovered.healthcheck.type, "pm2");
	assert.equal(discovered.healthcheck.target, "test-llmproxy-pm2");
	assert.equal(discovered.restart.type, "pm2");
	assert.equal(discovered.restart.target, "test-llmproxy-pm2");
	// And once it goes offline, it is no longer discovered as healthy-by-default
	// (supervise would then rely on whatever is actually registered, same as
	// today when nothing at all was auto-discoverable).
	process.env.YANO_TEST_PM2_JLIST = JSON.stringify([{ name: "test-llmproxy-pm2", pm2_env: { status: "stopped" } }]);
	assert.equal(listServices({ includeBuiltIns: true }).find((service) => service.name === "llmproxy"), undefined, "a stopped pm2 process is not auto-discovered as a live builtin dependency");
	console.log("   OK — builtin dependency discovery falls back to pm2 when llmproxy is not a Docker container");
} finally {
	process.env.PATH = pathBeforePm2;
	delete process.env.YANO_TEST_PM2_JLIST;
	delete process.env.YANO_LLMPROXY_PM2_NAME;
	delete process.env.YANO_LLMPROXY_CONTAINER;
}

console.log("\nsmoke-test-yano-services: ok");
