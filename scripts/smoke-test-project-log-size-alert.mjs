// Regression test for Fase 8 (log rewrite, part 2 — the 2GB per-project
// threshold): before this, no code anywhere checked disk usage — a project
// could accumulate unbounded trace data with nobody ever told. This checks
// ONLY (never moves/deletes anything automatically, per the explicit "alert
// + ask, never automatic" requirement) and debounces repeat alerts for the
// same project so it doesn't fire every single minute forever.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-log-size-alert-"));
process.env.YANO_DATA_DIR = root;
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");
process.env.YANO_PROJECT_LOG_ALERT_BYTES = String(1024); // 1KB threshold — easy to cross deterministically in a test

const { checkProjectLogSizes } = await import("./yano-watcher-registry.mjs");
const { projectKey, tracePaths } = await import("./yano-trace-storage.mjs");

console.log("Fase 8: per-project log size alert (2GB threshold, alert-only)");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

const bigProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-log-size-big-"));
const smallProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-log-size-small-"));
const bigProject = "big-project";
const smallProject = "small-project";

function writeBytes(projectRoot, project, size) {
	const { projectDir } = tracePaths({ cwd: projectRoot, project });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "filler.jsonl"), "x".repeat(size));
}
writeBytes(bigProjectRoot, bigProject, 5000); // over the 1KB test threshold
writeBytes(smallProjectRoot, smallProject, 10); // well under

const rows = [
	{ root: bigProjectRoot, name: bigProject },
	{ root: smallProjectRoot, name: smallProject },
];

check("a project over the threshold is flagged as a new alert on first detection", () => {
	const result = checkProjectLogSizes(rows);
	assert.equal(result.checked, 2);
	assert.equal(result.over_threshold, 1);
	assert.equal(result.new_alerts.length, 1);
	assert.equal(result.new_alerts[0].project, bigProject);
	assert.ok(result.new_alerts[0].bytes >= 1024);
});

check("nothing is ever moved or deleted by this check — it is read-only", () => {
	const { projectDir } = tracePaths({ cwd: bigProjectRoot, project: bigProject });
	assert.ok(fs.existsSync(path.join(projectDir, "filler.jsonl")), "the oversized file is untouched");
});

check("re-checking the SAME still-over-threshold project immediately does NOT re-alert (debounced)", () => {
	const result = checkProjectLogSizes(rows);
	assert.equal(result.over_threshold, 1, "still flagged as over threshold");
	assert.equal(result.new_alerts.length, 0, "but no NEW alert — the cooldown prevents re-notifying every minute");
});

check("a project under the threshold is never flagged", () => {
	const result = checkProjectLogSizes(rows);
	assert.ok(!result.new_alerts.some((a) => a.project === smallProject));
});

check("the alert state persists to disk across a fresh process (survives a watcher restart)", () => {
	const key = projectKey(bigProjectRoot, bigProject);
	const state = JSON.parse(fs.readFileSync(path.join(root, "watcher", "project-log-sizes.json"), "utf8"));
	assert.ok(state[key].over_threshold, "persisted state remembers the over-threshold project by its stable project key");
	assert.ok(state[key].last_alerted_at, "the alert timestamp is persisted, not just held in memory");
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(bigProjectRoot, { recursive: true, force: true });
fs.rmSync(smallProjectRoot, { recursive: true, force: true });
console.log(`\nsmoke-test-project-log-size-alert: ${passed} passed`);
