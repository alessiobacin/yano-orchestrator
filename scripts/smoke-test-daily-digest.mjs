// Regression test for Fase 9 (daily 06:00 Europe/Rome digest): before this,
// nothing summarized cross-project state — an open decision_hold, a stalled
// run, a recently-recovered agent or a log-size alert (Fase 8) each stayed
// buried in their own per-project/per-mechanism state file until someone
// went looking. This exercises buildDigest()/formatDigestText() against real
// fixtures (a real project SQLite DB with a run+ticket+decision_hold, a real
// watcher-registry row, real Fase 5/Fase 8 state files) and the standalone
// notification sender against a stubbed fetch.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-digest-data-"));
process.env.YANO_DATA_DIR = root;
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");
// Must be set before yano-watcher-registry.mjs is first imported below: its
// 2GB default threshold is captured into a top-level const at module load.
process.env.YANO_PROJECT_LOG_ALERT_BYTES = "1";

const { herdrReachabilityPath } = await import("./yano-watcher-registry.mjs");
const { projectDbPath } = await import("./yano-project.mjs");
const { traceRoot } = await import("./yano-trace-storage.mjs");
const { buildDigest, formatDigestText, runDigest } = await import("./yano-digest.mjs");

console.log("Fase 9: daily digest (cross-project pending work, open holds, recoveries, log alerts)");
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok — ${name}`); }

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-digest-project-"));
const projectName = "focusboard";
const { DatabaseSync } = process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : await import("node:sqlite");

// Seed the watcher registry directly (hand-crafted SQLite row, matching the
// real schema) instead of going through `yano watcher init` — that command
// opens a REAL Herdr tab as a side effect, which a unit test must never do.
const watcherDbPath = path.join(traceRoot(), "watcher", "watcher-registry.sqlite");
fs.mkdirSync(path.dirname(watcherDbPath), { recursive: true });
const watcherDb = new DatabaseSync(watcherDbPath);
watcherDb.exec(`
	CREATE TABLE IF NOT EXISTS watcher_projects (
		project_key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
		workspace_id TEXT, worker_tab_id TEXT, worker_pane_id TEXT, worker_instance TEXT,
		worker_status TEXT NOT NULL DEFAULT 'stopped', interval_ms INTEGER NOT NULL DEFAULT 60000,
		lookback_ms INTEGER NOT NULL DEFAULT 3600000, last_recovery_at TEXT, last_recovery_reason TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	);
`);
const seedNow = new Date().toISOString();
watcherDb.prepare("INSERT INTO watcher_projects (project_key, name, root, worker_status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
	.run(`workspace-${projectName}`, projectName, projectRoot, "running", seedNow, seedNow);
watcherDb.close();

// Seed the project's own SQLite DB with an active run, a pending ticket, and
// an open decision hold — the exact shape projectRuns()/projectOpenHolds()
// read from a real project checkout.
fs.mkdirSync(path.dirname(projectDbPath(projectRoot)), { recursive: true });
const db = new DatabaseSync(projectDbPath(projectRoot));
db.exec(`
	CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT, objective TEXT, status TEXT, finalization_status TEXT, updated_at TEXT);
	CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
	CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, question TEXT, status TEXT, created_at TEXT);
	CREATE TABLE tickets (id TEXT PRIMARY KEY, run_id TEXT, title TEXT, status TEXT, assigned_instance TEXT, required_playbook TEXT, updated_at TEXT);
	CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_id TEXT);
	CREATE TABLE playbook_bindings (run_id TEXT, playbook_id TEXT, checksum TEXT, snapshot TEXT);
	CREATE TABLE playbook_runtime_state (run_id TEXT, state_id TEXT, generation INTEGER, updated_at TEXT);
`);
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run-1", projectName, "Migrare il modulo pagamenti", "active", "not_started", nowIso);
db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?)").run("t-1", "run-1", "Implementare gateway", "pending", null, null, nowIso);
db.prepare("INSERT INTO decision_holds VALUES (?,?,?,?,?,?)").run("hold-1", "run-1", "t-1", "Quale provider di pagamento vuoi usare?", "open", nowIso);
db.close();

// Fase 5 state: Herdr unreachable for several passes.
fs.mkdirSync(path.dirname(herdrReachabilityPath()), { recursive: true });
fs.writeFileSync(herdrReachabilityPath(), JSON.stringify({ unreachable_streak: 5, unreachable_since: nowIso, last_checked_at: nowIso }));

// Fase 8 state: a different project over the (test-lowered) log threshold.
const { checkProjectLogSizes } = await import("./yano-watcher-registry.mjs");
const { tracePaths } = await import("./yano-trace-storage.mjs");
const bigLogProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-digest-biglog-"));
const { projectDir } = tracePaths({ cwd: bigLogProjectRoot, project: "big-log-project" });
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "filler.jsonl"), "x".repeat(2048));
checkProjectLogSizes([{ root: bigLogProjectRoot, name: "big-log-project" }]);

await check("an active run with a pending ticket appears under projects_with_incomplete_work", () => {
	const digest = buildDigest();
	const entry = digest.projects_with_incomplete_work.find((p) => p.project === projectName);
	assert.ok(entry, "focusboard is reported");
	assert.equal(entry.incomplete_runs[0].pending_tickets, 1);
});

await check("the open decision_hold's actual question text is surfaced, not just a count", () => {
	const digest = buildDigest();
	const hold = digest.open_decision_holds.find((h) => h.project === projectName);
	assert.equal(hold.question, "Quale provider di pagamento vuoi usare?");
});

await check("a project registered but with NO recent recovery is not listed as recovering", () => {
	const digest = buildDigest();
	assert.ok(!digest.recently_recovered_agents.some((a) => a.project === projectName));
});

await check("Fase 5's persisted Herdr-unreachable streak is surfaced", () => {
	const digest = buildDigest();
	assert.equal(digest.herdr.unreachable_streak, 5);
});

await check("Fase 8's persisted over-threshold project log alert is surfaced", () => {
	const digest = buildDigest();
	assert.ok(digest.project_log_size_alerts.some((a) => a.project === "big-log-project"));
});

await check("formatDigestText renders a human-readable summary containing the key facts", () => {
	const text = formatDigestText(buildDigest());
	assert.ok(text.includes("Quale provider di pagamento vuoi usare?"));
	assert.ok(text.includes("big-log-project"));
	assert.ok(text.includes("Herdr non raggiungibile"));
});

await check("an empty state (no projects, no alerts) renders a reassuring all-clear message, not an empty digest", () => {
	const text = formatDigestText({ generated_at: seedNow, projects_with_incomplete_work: [], open_decision_holds: [], recently_recovered_agents: [], project_log_size_alerts: [], herdr: null });
	assert.ok(/tranquillo/i.test(text));
});

await check("runDigest() sends the formatted text through the injected sender and returns its result", async () => {
	let sentText = null;
	const fakeSend = async (text) => { sentText = text; return { ok: true, detail: "stub" }; };
	const result = await runDigest({ send: fakeSend });
	assert.ok(sentText.includes("Quale provider di pagamento vuoi usare?"));
	assert.equal(result.sent.ok, true);
});

// yano-notify.mjs: verify the global-channel sender resolves config and
// reaches out to the right endpoint, without a real network call.
const { sendGlobalNotification } = await import("./yano-notify.mjs");
await check("sendGlobalNotification reports 'not configured' cleanly when no channel is set up", async () => {
	const result = await sendGlobalNotification("test", { env: { ...process.env, TELEGRAM_BOT_TOKEN: "", TELEGRAM_DESTINATION_CHAT_ID: "", EVOLUTION_API_URL: "", SENDGRID_API_KEY: "" } });
	assert.equal(result.ok, false);
});

await check("sendGlobalNotification sends via Telegram when configured, using an injected fetch", async () => {
	let requestedUrl = null;
	const fakeFetch = async (url) => { requestedUrl = url; return { ok: true, json: async () => ({ ok: true }) }; };
	const result = await sendGlobalNotification("ciao", {
		env: { TELEGRAM_BOT_TOKEN: "tok123", TELEGRAM_DESTINATION_CHAT_ID: "chat456", YANO_DATA_DIR: root, YANO_CONFIG_FILE: process.env.YANO_CONFIG_FILE },
		fetchImpl: fakeFetch,
	});
	assert.equal(result.channels.telegram.ok, true);
	assert.ok(requestedUrl.includes("tok123"));
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(bigLogProjectRoot, { recursive: true, force: true });
console.log(`\nsmoke-test-daily-digest: ${passed} passed`);
