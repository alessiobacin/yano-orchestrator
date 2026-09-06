// Regression test for Fase 8 (log rewrite, part 1 — rotation): the three
// global one-minute-cadence logs (watcher-global, global-services,
// scheduler-connectivity) used to be single ever-growing files. Retention
// (yano-data.mjs's oldFiles()) filters purely by file mtime — a file
// appended to every minute forever always has mtime "now", so retention
// could structurally never fire on it. dailyLogPath() gives each calendar
// day its own file, so every day but today ages normally and the EXISTING
// retention scan (unchanged) can sweep it once it's old enough.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dailyLogPath, retentionPlan } from "./yano-data.mjs";

console.log("Fase 8: daily log rotation makes retention actually reach these logs");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-daily-log-"));

check("dailyLogPath names the file after the calendar day, inside the given directory", () => {
	const p = dailyLogPath(dir, "watcher-global", { now: new Date("2026-09-05T10:00:00Z") });
	assert.equal(p, path.join(dir, "watcher-global-2026-09-05.jsonl"));
});

check("two calls on the SAME day resolve to the SAME file — a real append target, not a new file per call", () => {
	const morning = dailyLogPath(dir, "watcher-global", { now: new Date("2026-09-05T06:00:00Z") });
	const evening = dailyLogPath(dir, "watcher-global", { now: new Date("2026-09-05T23:00:00Z") });
	assert.equal(morning, evening);
});

check("a call on a DIFFERENT day resolves to a different file", () => {
	const today = dailyLogPath(dir, "watcher-global", { now: new Date("2026-09-05T23:59:00Z") });
	const tomorrow = dailyLogPath(dir, "watcher-global", { now: new Date("2026-09-06T00:01:00Z") });
	assert.notEqual(today, tomorrow);
});

check("an old, no-longer-appended-to day's segment IS reachable by the existing retention scan (the actual bug fixed)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-daily-log-retention-"));
	const logsDir = path.join(root, "logs");
	fs.mkdirSync(logsDir, { recursive: true });
	const oldSegment = dailyLogPath(logsDir, "watcher-global", { now: new Date("2026-01-01T00:00:00Z") });
	fs.writeFileSync(oldSegment, '{"event":"old"}\n');
	// Simulate the file's real age: retention checks mtime, not the date in
	// the filename — an old segment that is no longer being appended to has a
	// real old mtime, unlike the single-ever-growing-file design it replaces.
	const oldMs = Date.now() - 60 * 86_400_000; // 60 days ago
	fs.utimesSync(oldSegment, oldMs / 1000, oldMs / 1000);
	const plan = retentionPlan({ root });
	assert.ok(plan.files.some((item) => item.source === oldSegment), "the old daily segment is found by the SAME, unmodified retention scan");
	fs.rmSync(root, { recursive: true, force: true });
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nsmoke-test-daily-log-rotation: ${passed} passed`);
