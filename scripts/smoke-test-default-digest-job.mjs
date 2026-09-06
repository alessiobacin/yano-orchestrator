// Regression test for Fase 9's bootstrap half: before this, nothing ever
// registered the daily digest job automatically — a user would have had to
// know to run `yano schedule add` themselves. This checks the idempotent
// "default infra" bootstrap (mirrors the pattern already used for global
// services / architect teardown / log rotation) and the new timezone-aware
// cron matching the digest's "06:00 di Roma" requirement depends on: before
// this, cronMatches() only ever compared against the SERVER's local system
// clock, so "0 6 * * *" would silently fire at 06:00 wherever the machine's
// OS timezone happened to be set, not 06:00 Europe/Rome.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-digest-job-"));
process.env.YANO_DATA_DIR = root;
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");

const { cronMatches, ensureDefaultDigestJob, readStore, schedulerScriptsDir, validateJob } = await import("./yano-scheduler.mjs");

console.log("Fase 9: default digest job bootstrap + timezone-aware cron matching");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

check("cronMatches with no timezone behaves exactly as before (plain local Date getters)", () => {
	const now = new Date(2026, 5, 15, 6, 0, 0); // local 06:00
	assert.equal(cronMatches("0 6 * * *", now), true);
	assert.equal(cronMatches("0 7 * * *", now), false);
});

check("cronMatches with an explicit timezone evaluates the wall-clock time IN that zone, not the server's local clock", () => {
	// 04:00 UTC is 06:00 in Europe/Rome during summer (CEST, UTC+2) — a fixed,
	// unambiguous instant independent of whatever timezone this test runs in.
	const utcNow = new Date(Date.UTC(2026, 5, 15, 4, 0, 0));
	assert.equal(cronMatches("0 6 * * *", utcNow, "Europe/Rome"), true);
	assert.equal(cronMatches("0 5 * * *", utcNow, "Europe/Rome"), false);
});

check("ensureDefaultDigestJob() creates the job on first call", () => {
	const result = ensureDefaultDigestJob();
	assert.equal(result.created, true);
	assert.equal(result.job.id, "yano-daily-digest");
	assert.equal(result.job.cron, "0 6 * * *");
	assert.equal(result.job.timezone, "Europe/Rome");
	assert.equal(result.job.mode, "self");
	assert.equal(result.job.enabled, true);
});

check("the job is persisted in jobs.json and validates cleanly (script_path inside the trusted scripts folder)", () => {
	const { store } = readStore(process.env);
	const job = store.jobs.find((j) => j.id === "yano-daily-digest");
	assert.ok(job, "job present in the store");
	const issues = validateJob(job, { exists: fs.existsSync, scriptsDir: schedulerScriptsDir(process.env) });
	assert.deepEqual(issues, [], `job must validate cleanly: ${issues.join("; ")}`);
});

check("the generated bridge script exists, is executable, and points at the real package digest module", () => {
	const { store } = readStore(process.env);
	const job = store.jobs.find((j) => j.id === "yano-daily-digest");
	const content = fs.readFileSync(job.script_path, "utf8");
	assert.ok(content.includes("yano-digest.mjs"));
	assert.ok(content.includes("runDigest"));
	assert.ok((fs.statSync(job.script_path).mode & 0o100) !== 0, "owner-executable");
});

check("calling ensureDefaultDigestJob() again is a no-op — never duplicates the job", () => {
	const before = readStore(process.env).store.jobs.length;
	const result = ensureDefaultDigestJob();
	assert.equal(result.created, false);
	assert.equal(readStore(process.env).store.jobs.length, before);
});

check("a user who disabled the digest job keeps it disabled across re-bootstraps (never force-re-enabled)", () => {
	const { file, store } = readStore(process.env);
	const job = store.jobs.find((j) => j.id === "yano-daily-digest");
	job.enabled = false;
	fs.writeFileSync(file, JSON.stringify(store, null, 2));
	ensureDefaultDigestJob();
	assert.equal(readStore(process.env).store.jobs.find((j) => j.id === "yano-daily-digest").enabled, false);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nsmoke-test-default-digest-job: ${passed} passed`);
