#!/usr/bin/env node

// Verifies the user-crontab supervisor without touching the real crontab.
// The actual installation is exercised manually by `yano watcher cron
// install`; this test replaces only the crontab binary with a temp fixture.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmodSync, writeFileSync } from "node:fs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-watcher-cron-"));
const fakeBin = path.join(root, "bin");
const state = path.join(root, "crontab.txt");
const dataDir = path.join(root, "yano-data");
fs.mkdirSync(fakeBin, { recursive: true });
writeFileSync(path.join(fakeBin, "crontab"), `#!/usr/bin/env node
const fs = require("node:fs");
const state = process.env.FAKE_CRONTAB_STATE;
if (process.argv[2] === "-l") {
  if (!fs.existsSync(state)) { process.stderr.write("crontab: no crontab for test\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(state, "utf8"));
} else if (process.argv[2] === "-") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => fs.writeFileSync(state, input));
} else process.exit(2);
`);
chmodSync(path.join(fakeBin, "crontab"), 0o700);

const oldPath = process.env.PATH;
const oldData = process.env.YANO_DATA_DIR;
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ""}`;
process.env.FAKE_CRONTAB_STATE = state;
process.env.YANO_DATA_DIR = dataDir;

try {
	const { runYanoWatcherRegistry } = await import("./yano-watcher-registry.mjs");
	const call = (argv) => runYanoWatcherRegistry({ argv: [...argv, "--json"] });

	const before = await call(["cron", "status"]);
	assert.equal(before.installed, false, "cron status reports missing entry without a crontab");

	fs.writeFileSync(state, "MAILTO=operator@example.test\n");
	const installed = await call(["cron", "install"]);
	assert.equal(installed.installed, true, "cron install succeeds");
	assert.equal(installed.schedule, "* * * * *", "cron schedule is every minute");
	assert.match(fs.readFileSync(state, "utf8"), /MAILTO=operator@example\.test/);
	assert.equal(fs.readFileSync(state, "utf8").split("yano-watcher-supervisor").length - 1, 1, "exactly one marked entry is installed");

	await call(["cron", "install"]);
	assert.equal(fs.readFileSync(state, "utf8").split("yano-watcher-supervisor").length - 1, 1, "repeated install is idempotent");
	const status = await call(["cron", "status"]);
	assert.equal(status.installed, true, "cron status sees the installed entry");

	const removed = await call(["cron", "remove"]);
	assert.equal(removed.removed, true, "cron remove succeeds");
	assert.equal(fs.readFileSync(state, "utf8").includes("yano-watcher-supervisor"), false, "remove deletes only Yano's marked entry");
	assert.match(fs.readFileSync(state, "utf8"), /MAILTO=operator@example\.test/);

	const supervised = await call(["supervise"]);
	assert.deepEqual(supervised.projects, [], "supervise is harmless when no watcher is registered");
	assert.equal(fs.existsSync(path.join(dataDir, "watcher", "supervisor.lock")), false, "supervisor lock is cleaned after the pass");

	console.log("smoke-test-yano-watcher-cron: ok (one-minute crontab, idempotency, lock cleanup)");
} finally {
	if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
	if (oldData === undefined) delete process.env.YANO_DATA_DIR; else process.env.YANO_DATA_DIR = oldData;
	delete process.env.FAKE_CRONTAB_STATE;
	fs.rmSync(root, { recursive: true, force: true });
}
