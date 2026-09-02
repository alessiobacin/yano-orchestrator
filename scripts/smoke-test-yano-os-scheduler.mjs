// Real test for ticket #119
// (.scratch/optimize-orchestrator/issues/119-windows-task-scheduler-parity.md):
// Windows has no `cron`, so yano-os-scheduler.mjs adds a `schtasks` branch to
// the one-minute supervisor installers. Exercised here with a real fake
// `schtasks` binary on PATH (same technique smoke-test-yano-watcher-cron.mjs
// already uses for the real `crontab` binary) and `platform: "win32"`
// forced explicitly, so the Windows branch runs and is verified for real
// even though this test itself runs on Linux/macOS CI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	isWindows, schtasksTaskName,
	installOneMinuteWindowsJob, removeOneMinuteWindowsJob, statusOneMinuteWindowsJob,
} from "./yano-os-scheduler.mjs";

console.log("=== isWindows / schtasksTaskName ===");
assert.equal(isWindows("win32"), true);
assert.equal(isWindows("linux"), false);
assert.equal(isWindows("darwin"), false);
assert.equal(schtasksTaskName("# yano-watcher-supervisor"), "Yanoyanowatchersupervisor");
console.log("   OK — la piattaforma è verificata esplicitamente, e il nome dell'attività è derivato in modo stabile e privo di punteggiatura dal marker crontab già usato su POSIX");

console.log("\n=== non-Windows platforms are a deliberate no-op (POSIX keeps using crontab) ===");
assert.equal(installOneMinuteWindowsJob({ marker: "x", command: "y", platform: "linux" }), null);
assert.equal(removeOneMinuteWindowsJob({ marker: "x", platform: "darwin" }), null);
assert.equal(statusOneMinuteWindowsJob({ marker: "x", platform: "linux" }), null);
console.log("   OK — su piattaforme non Windows le funzioni restituiscono null e non toccano nulla (nessuna regressione al percorso crontab esistente)");

console.log("\n=== schtasks command construction (stubbed binary, no real Windows needed) ===");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-os-scheduler-"));
const fakeBin = path.join(root, "bin");
fs.mkdirSync(fakeBin, { recursive: true });
const state = path.join(root, "schtasks-state.json");
fs.writeFileSync(state, "{}");
const callLog = path.join(root, "schtasks-calls.txt");
fs.writeFileSync(
	path.join(fakeBin, "schtasks"),
	`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, args.join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (args[0] === "/Create") {
  const name = args[args.indexOf("/TN") + 1];
  state[name] = { command: args[args.indexOf("/TR") + 1] };
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
  process.exit(0);
}
if (args[0] === "/Delete") {
  const name = args[args.indexOf("/TN") + 1];
  if (!state[name]) { process.stderr.write("ERROR: The system cannot find the file specified.\\n"); process.exit(1); }
  delete state[name];
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
  process.exit(0);
}
if (args[0] === "/Query") {
  const name = args[args.indexOf("/TN") + 1];
  if (!state[name]) { process.stderr.write("ERROR: The system cannot find the file specified.\\n"); process.exit(1); }
  process.stdout.write("TaskName: " + name + "\\nTaskToRun: " + state[name].command + "\\n");
  process.exit(0);
}
process.exit(2);
`,
);
fs.chmodSync(path.join(fakeBin, "schtasks"), 0o700);
const oldPath = process.env.PATH;
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ""}`;

try {
	const marker = "# yano-watcher-supervisor";
	const command = '"C:\\node.exe" "C:\\yano\\bin\\yano.mjs" watcher supervise --json';

	console.log("   status before install: not installed");
	const before = statusOneMinuteWindowsJob({ marker, platform: "win32" });
	assert.equal(before.installed, false);

	console.log("   install");
	const installed = installOneMinuteWindowsJob({ marker, command, platform: "win32" });
	assert.equal(installed.installed, true);
	assert.equal(installed.backend, "schtasks");
	assert.equal(installed.marker, schtasksTaskName(marker));
	const createCall = fs.readFileSync(callLog, "utf8").trim().split("\n").find((entry) => entry.startsWith("/Create"));
	assert.match(createCall, /^\/Create \/F \/SC MINUTE \/MO 1 \/TN Yanoyanowatchersupervisor \/TR /, "must schedule every 1 minute with the derived task name");
	assert.ok(createCall.includes(command), "the exact supervise command must be passed as /TR");

	console.log("   status after install: installed, schedule reflects the real query output");
	const after = statusOneMinuteWindowsJob({ marker, platform: "win32" });
	assert.equal(after.installed, true);
	assert.match(after.command, /TaskToRun:/, "status must reflect the real `schtasks /Query` output, not a guess");

	console.log("   install again is idempotent (real /F overwrite, no duplicate task)");
	installOneMinuteWindowsJob({ marker, command, platform: "win32" });
	const stillOne = statusOneMinuteWindowsJob({ marker, platform: "win32" });
	assert.equal(stillOne.installed, true);

	console.log("   remove");
	const removed = removeOneMinuteWindowsJob({ marker, platform: "win32" });
	assert.equal(removed.removed, true);
	const afterRemove = statusOneMinuteWindowsJob({ marker, platform: "win32" });
	assert.equal(afterRemove.installed, false);

	console.log("   removing again is a graceful no-op, not a thrown error");
	const removedAgain = removeOneMinuteWindowsJob({ marker, platform: "win32" });
	assert.equal(removedAgain.removed, false);
} finally {
	process.env.PATH = oldPath;
}
console.log("   OK — install/status/remove compongono i comandi schtasks corretti, sono idempotenti e non richiedono mai una vera macchina Windows per essere verificati");

console.log("\n=== yano-watcher-registry.mjs and yano-scheduler.mjs actually call into this module ===");
{
	// Both files import installOneMinuteWindowsJob/removeOneMinuteWindowsJob/
	// statusOneMinuteWindowsJob from yano-os-scheduler.mjs and branch on
	// platform before falling through to their existing, already-tested
	// crontab path — verified by source inspection here (a full run needs a
	// real crontab binary, already covered by smoke-test-yano-watcher-cron.mjs
	// and smoke-test-yano-scheduler.mjs on POSIX; those two continue to pass
	// unmodified, proving the added branch does not disturb the POSIX path).
	const watcherSource = fs.readFileSync(new URL("./yano-watcher-registry.mjs", import.meta.url), "utf8");
	const schedulerSource = fs.readFileSync(new URL("./yano-scheduler.mjs", import.meta.url), "utf8");
	assert.match(watcherSource, /installOneMinuteWindowsJob/);
	assert.match(watcherSource, /removeOneMinuteWindowsJob/);
	assert.match(watcherSource, /statusOneMinuteWindowsJob/);
	assert.match(schedulerSource, /installOneMinuteWindowsJob/);
	assert.match(schedulerSource, /removeOneMinuteWindowsJob/);
	assert.match(schedulerSource, /statusOneMinuteWindowsJob/);
}
console.log("   OK — entrambi i supervisori globali (yano-watcher e yano-scheduler) sono cablati al ramo Windows");

console.log("\nsmoke-test-yano-os-scheduler: ok");
