// Regression test for the 2026-09-05 incident: a working daily "self" job
// (script exits 0, prints its own success JSON shape — not the
// {accepted,durable_pending} contract meant for async planner/yano-local-pc
// handoffs) was re-executed roughly every 3-4 minutes for two hours by
// recoverStaleDispatches(), resending a real Telegram notification ~39 times.
//
// Root cause: a successful "self"-mode dispatch was recorded with instance
// status "dispatched" (a PENDING state), so recoverStaleDispatches() treated
// it as stuck once it aged past the dispatch timeout. Fix: recordInstance()
// now marks a successful self-mode dispatch "completed" (terminal), so
// recoverStaleDispatches() — which only ever revisits instances still
// literally "dispatched" — never touches it again.
//
// This test also covers the secondary guard: a genuinely stuck ASYNC
// dispatch (planner:/yano-local-pc modes awaiting an ack that never arrives)
// must stop retrying after MAX_STALE_RECOVERIES attempts instead of forever.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runYanoScheduler, readStore, writeStore, recoverStaleDispatches, MAX_STALE_RECOVERIES } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-scheduler-dup-fire-"));
const data = path.join(root, "data");
const project = path.join(root, "project");
const scriptsDir = path.join(data, "scheduler", "scripts");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(scriptsDir, { recursive: true });
// Mirrors the real incident script: exits 0, prints a legitimate but
// non-{accepted,durable_pending}-shaped success JSON.
const realWorldScript = path.join(scriptsDir, "riepilogo-giornaliero-0700.cjs");
fs.writeFileSync(realWorldScript, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, telegram: 'telegram_sent' }));\n");

const env = { ...process.env, YANO_DATA_DIR: data };
const noopSpawn = (command, args, options = {}) => {
	if (command === "crontab" && args[0] === "-l") return { status: 0, stdout: "", stderr: "" };
	if (command === "crontab" && args[0] === "-") return { status: 0, stdout: "", stderr: "" };
	return { status: 0, stdout: "started", stderr: "" };
};

const runner = { passed: 0, failed: 0, async check(name, fn) { try { await fn(); this.passed += 1; console.log(`  ok — ${name}`); } catch (error) { this.failed += 1; console.error(`  FAIL — ${name}: ${error instanceof Error ? error.message : String(error)}`); } } };

console.log("Regression: scheduler duplicate-fire (2026-09-05 incident)");

let jobId;
await runner.check("self-mode job with non-standard success JSON dispatches exactly once, never re-fires", async () => {
	const created = await runYanoScheduler({ argv: ["add", "--name", "riepilogo-0700", "--project-root", project, "--mode", "self", "--script", realWorldScript, "--cron", "0 7 * * *", "--json"], env, now: new Date("2026-09-05T05:00:00Z"), spawn: noopSpawn });
	jobId = created.created.id;

	// T0: the 07:00 Europe/Rome occurrence fires and succeeds.
	const { tick } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const dispatched = await tick({ env, now: new Date("2026-09-05T05:00:00Z"), spawn: noopSpawn });
	const job = dispatched.dispatched.find((item) => item.id === jobId);
	assert.equal(job.status, "dispatched", "tick()'s immediate report is unaffected by this fix");

	const { store } = readStore(env);
	const persisted = store.jobs.find((item) => item.id === jobId);
	assert.equal(persisted.instances.length, 1);
	assert.equal(persisted.instances[0].status, "completed", "a successful self-mode dispatch is terminal, not pending");

	// Simulate the supervisor running every ~3-4 minutes for two hours, exactly
	// as happened in the real incident, well past the 180s dispatch timeout.
	for (const minutesLater of [4, 8, 30, 65, 120]) {
		const { store: reread } = readStore(env);
		const recovered = recoverStaleDispatches(reread, new Date(new Date("2026-09-05T05:00:00Z").getTime() + minutesLater * 60_000), noopSpawn, env);
		assert.deepEqual(recovered, [], `no stale-dispatch recovery at +${minutesLater}min — the job already completed`);
	}

	const { store: final } = readStore(env);
	const finalJob = final.jobs.find((item) => item.id === jobId);
	assert.equal(finalJob.instances.length, 1, "the script ran exactly once across the whole simulated 2-hour window — this is the regression the incident violated");
});

await runner.check("a genuinely stuck ASYNC dispatch retries up to the cap, then stops permanently (no infinite retry)", async () => {
	// Manufacture a job whose async handoff (planner:/yano-local-pc) never
	// acknowledged — the ONLY case recoverStaleDispatches should still act on.
	const { file, store } = readStore(env);
	const stuckJob = {
		id: "job-stuck-async-test", name: "stuck-async", project_root: project, cron: "0 9 * * *",
		task: "n/a", enabled: true, script_path: realWorldScript, mode: "planner:demo",
		timeout_ms: 120000, expected_consequence: "ack atteso dal planner", created_at: "2026-09-05T09:00:00.000Z", updated_at: "2026-09-05T09:00:00.000Z",
		last_run_at: "2026-09-05T09:00:00.000Z", last_run_slot: "2026-9-5-9-0", last_status: "dispatched",
		instances: [{ instance_id: "stuck-instance-0", schedule_id: "job-stuck-async-test", schedule_name: "stuck-async", started_at: "2026-09-05T09:00:00.000Z", status: "dispatched", result: { instance: "stuck-instance-0", status: 0, stdout: "no ack here" } }],
	};
	store.jobs.push(stuckJob);
	writeStore(file, store);

	let now = new Date("2026-09-05T09:00:00.000Z");
	let totalRecoveries = 0;
	// Drive well past MAX_STALE_RECOVERIES worth of timeout windows. Mutations
	// must be persisted between rounds (exactly as superviseScheduler() does in
	// production) or the retry-attempt counter never survives to the next read.
	for (let round = 0; round < MAX_STALE_RECOVERIES + 3; round += 1) {
		now = new Date(now.getTime() + 4 * 60_000);
		const { file, store: current } = readStore(env);
		const recovered = recoverStaleDispatches(current, now, noopSpawn, env);
		writeStore(file, current);
		totalRecoveries += recovered.filter((item) => item.schedule_id === "job-stuck-async-test" && item.retry).length;
	}
	assert.equal(totalRecoveries, MAX_STALE_RECOVERIES, `retries stop exactly at the cap (${MAX_STALE_RECOVERIES}), never grow unbounded`);

	const { store: settled } = readStore(env);
	const settledJob = settled.jobs.find((item) => item.id === "job-stuck-async-test");
	const lastInstance = settledJob.instances.at(-1);
	assert.equal(lastInstance.status, "dispatch_failed_permanently", "past the cap the job is marked permanently failed instead of retried forever");
	assert.equal(settledJob.last_status, "failed");
});

console.log(`\nsmoke-test-yano-scheduler-duplicate-fire-regression: ${runner.passed} passed, ${runner.failed} failed`);
fs.rmSync(root, { recursive: true, force: true });
if (runner.failed > 0) process.exit(1);
