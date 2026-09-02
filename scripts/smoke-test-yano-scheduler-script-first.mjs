// TDD contract for the script-first scheduler (spec scheduler-script-first, A–E).
// Written BEFORE the implementation: every block below defines a behaviour the
// implementation must satisfy. `yano schedule`/`yano invoke` CLI surfaces are
// exercised through the real bin dispatcher with a fake spawn (injected via the
// test-only spawn bridge), while script dispatch uses `node <script>` — never a
// shell. See scripts/smoke-test-yano-scheduler.mjs for the legacy natural-language
// CRUD contract, which must keep passing untouched.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YANO_BIN = path.join(PACKAGE_ROOT, "bin", "yano.mjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-scheduler-script-first-"));
const data = path.join(root, "data");
const project = path.join(root, "demo-project");
const scriptsDir = path.join(data, "scheduler", "scripts");
fs.mkdirSync(project, { recursive: true });
// Minimal Yano project markers so `yano start --print-only` (used by the
// invoke bridge) recognises the temp project as an initialized project.
fs.mkdirSync(path.join(project, "agents"), { recursive: true });
fs.writeFileSync(path.join(project, "agents", "roles.yaml"), "roles: {}\n");
fs.mkdirSync(path.join(project, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
fs.writeFileSync(path.join(project, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: "demo-project" }));
fs.mkdirSync(scriptsDir, { recursive: true });
// Driver scripts: plain node shebang files the dispatcher runs via node.
fs.writeFileSync(path.join(scriptsDir, "test-echo.js"), "#!/usr/bin/env node\nconsole.log('ECHO-OK');\n");
fs.writeFileSync(path.join(scriptsDir, "wake.js"), "#!/usr/bin/env node\nconsole.log('mode=' + (process.env.YANO_JOB_MODE || 'self'));\n");

// Parent-side fake spawn: tracks crontab/launch bookkeeping so assertions run
// against the parent's view. Serialised into child processes through the spawn
// bridge as its own function, so the serialised copy is fully self-contained.
let crontab = "MAILTO=test@example.invalid\n";
let workspaceCreated = false;
let schedulerTabCreated = false;
const launches = [];

function fakeSpawn(command, args, options = {}) {
	if (command === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
	if (command === "crontab" && args[0] === "-") { crontab = options.input; return { status: 0, stdout: "", stderr: "" }; }
	if (command === "herdr" && args[0] === "workspace" && args[1] === "create") { workspaceCreated = true; return { status: 0, stdout: "", stderr: "" }; }
	if (command === "herdr" && args[0] === "tab" && args[1] === "create") { schedulerTabCreated = true; return { status: 0, stdout: "", stderr: "" }; }
	if (command === "herdr") {
		const workspace = workspaceCreated ? [{ workspace_id: "w-scheduler", label: "yano-scheduler" }] : [];
		const tabs = schedulerTabCreated ? [{ tab_id: "t-scheduler", workspace_id: "w-scheduler", label: "scheduler-service" }] : [];
		const panes = schedulerTabCreated ? [{ pane_id: "p-scheduler", tab_id: "t-scheduler", workspace_id: "w-scheduler", cwd: path.resolve(PACKAGE_ROOT) }] : [];
		return { status: 0, stdout: JSON.stringify({ result: { snapshot: { agents: [], workspaces: workspace, tabs, panes } } }), stderr: "" };
	}
	launches.push({ command, args, cwd: options.cwd });
	return { status: 0, stdout: "started", stderr: "" };
}

const env = { ...process.env, YANO_DATA_DIR: data, PI_ORCH_BROKER_URL: "mqtt://127.0.0.1:1" };

// Runs the real `yano` CLI in a child process with the fake spawn injected.
const crontabFile = path.join(root, "crontab.txt");
const eventsFile = path.join(root, "events.txt");
function childSpawnEnv() {
	return JSON.stringify({ path: path.join(PACKAGE_ROOT, "scripts", "yano-test-spawn-bridge.mjs"), meta: { crontabFile, eventsFile, projectRoot: PACKAGE_ROOT } });
}
function eventsLines() {
	return fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean) : [];
}
function cli(args) {
	return execFileSync(process.execPath, [YANO_BIN, ...args], {
		cwd: PACKAGE_ROOT,
		encoding: "utf8",
		env: { ...env, YANO_TEST_SPAWN_BRIDGE: childSpawnEnv() },
		maxBuffer: 8 * 1024 * 1024,
	});
}

const runner = {
	passed: 0,
	failed: 0,
	async check(name, fn) {
		try {
			await fn();
			this.passed += 1;
			console.log(`  ok — ${name}`);
		} catch (error) {
			this.failed += 1;
			console.error(`  FAIL — ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};

// Drivers executed by the dispatcher: plain registered scripts in the persistent
// user-data scripts folder (visible through env.YANO_DATA_DIR = <tmp>/data).



console.log("TDD contract: scheduler script-first (A–E + security)");
// Block 1 — security validator (vincoli: no shell arbitrari, no pipe/redirezioni)
await runner.check("validator rejects shell metacharacters in script payloads", async () => {
	const { validateScriptSecurity } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const useDir = path.join(data, "scheduler", "scripts");
	const opts = { exists: () => true, scriptsDir: useDir };
	const issuesDanger = validateScriptSecurity({ mode: "self", script_path: path.join(useDir, "x.sh"), task: "rm -rf /; echo hi > /dev/null" }, opts);
	const issuesPipe = validateScriptSecurity({ mode: "self", script_path: path.join(useDir, "x.sh"), task: "echo ok | cat" }, opts);
	const issuesOk = validateScriptSecurity({ mode: "self", script_path: path.join(useDir, "x.sh"), task: "echo ok" }, opts);
	const issuesBarePlanner = validateScriptSecurity({ mode: "planner", script_path: path.join(useDir, "x.sh"), task: "ok" }, opts);
	const issuesPlannerScope = validateScriptSecurity({ mode: "planner:demo", script_path: path.join(useDir, "x.sh"), task: "ok" }, opts);
	assert.ok(issuesDanger.length > 0);
	assert.ok(issuesPipe.length > 0);
	assert.equal(issuesOk.length, 0);
	assert.ok(issuesBarePlanner.length > 0, "bare 'planner' mode is rejected");
	assert.equal(issuesPlannerScope.length, 0, "planner:<progetto> is accepted");
});
await runner.check("validator rejects jobs without declared mode or safe path", async () => {
	const { validateJob } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const useDir = path.join(data, "scheduler", "scripts");
	const opts = { exists: () => true, scriptsDir: useDir };
	const missingMode = validateJob({ id: "j1", cron: "0 * * * *", project_root: "/tmp", task: "ok" }, opts);
	const shellTask = validateJob({ id: "j1", cron: "0 * * * *", project_root: "/tmp", mode: "self", script_path: path.join(useDir, "x.sh"), task: "rm -rf /; echo hi > /dev/null" }, opts);
	const clean = validateJob({ id: "j1", cron: "0 * * * *", project_root: "/tmp", mode: "self", script_path: path.join(useDir, "x.sh"), task: "ok" }, opts);
	assert.ok(missingMode.length > 0, "missing mode rejected");
	assert.ok(shellTask.find((i) => /metacharatteri/.test(i)), "free-form shell in task rejected");
	assert.ok(clean.length === 0);
});
// Block 2 — `yano schedule add` with a script
await runner.check("schedule add registers a script job and installs the cron", async () => {
	const out = cli(["schedule", "add", "--name", "test-script", "--project-root", project, "--mode", "self", "--script", path.join(scriptsDir, "test-echo.js"), "--cron", "30 9 * * *"]);
	const parsed = JSON.parse(out.trim().split("\n").at(-1));
	assert.equal(parsed.created.mode, "self");
	assert.equal(parsed.created.expected_consequence, "test-echo.js eseguito");
	assert.equal(parsed.created.script_path, path.join(scriptsDir, "test-echo.js"));
	assert.match(fs.readFileSync(crontabFile, "utf8"), /yano-scheduler-supervisor/);
});
await runner.check("schedule add rejects a missing script", async () => {
	let threw = false;
	try {
		cli(["schedule", "add", "--name", "ghost", "--project-root", project, "--mode", "self", "--script", path.join(scriptsDir, "ghost.js"), "--cron", "30 9 * * *"]);
	} catch (error) {
		threw = /script|inesistente/i.test(String(error.stdout || error.message || error));
	}
	assert.ok(threw, "missing script path must be refused with a helpful error");
});
// Block 3 — `yano schedule list` shows the fields
await runner.check("schedule list exposes job fields (script_path/mode/expected_consequence)", async () => {
	const out = cli(["schedule", "list", "--json"]);
	const jobs = JSON.parse(out.trim());
	assert.equal(jobs.length, 1);
	assert.ok("script_path" in jobs[0] && "mode" in jobs[0] && "expected_consequence" in jobs[0]);
});
// Block 4 — `yano schedule run` executes the script via the dispatcher (mode self)
await runner.check("schedule run executes the registered script (mode self)", async () => {
	const { runYanoScheduler } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const listed = await runYanoScheduler({ argv: ["list"], env, spawn: fakeSpawn });
	const target = listed.find((item) => item.name === "test-script");
	assert.ok(target, "job test-script registered");
	const out = cli(["schedule", "run", "--id", target.id, "--json"]);
	const parsed = JSON.parse(out.trim().split("\n").at(-1));
	assert.equal(parsed.run.status, 0);
	assert.match(String(parsed.run.stdout), /ECHO-OK/);
});
// Block 4b — `yano schedule run` on a missing script reports the fallback
await runner.check("schedule run reports a readable failure when the script is deleted", async () => {
	const { runYanoScheduler } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const runGhost = path.join(scriptsDir, "run-ghost.js");
	fs.writeFileSync(runGhost, "#!/usr/bin/env node\nconsole.log('x');\n");
	cli(["schedule", "add", "--name", "run-ghost", "--project-root", project, "--mode", "self", "--script", runGhost, "--cron", "30 11 * * *"]);
	fs.rmSync(runGhost);
	const listed = await runYanoScheduler({ argv: ["list"], env, spawn: fakeSpawn });
	const out = cli(["schedule", "run", "--id", listed.find((item) => item.name === "run-ghost").id, "--json"]);
	const parsed = JSON.parse(out.trim().split("\n").at(-1));
	assert.equal(parsed.run.status, 1);
	assert.match(String(parsed.run.error), /script/i, "fallback loggato per script mancante");
});
// Block 5 — dispatch-by-time executes the script, not a planner (mode self)
await runner.check("tick dispatches the script at the scheduled minute (no planner launched)", async () => {
	const { tick } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const before = launches.length;
	const res = await tick({ env, now: new Date(2026, 8, 3, 9, 30, 0), spawn: fakeSpawn });
	const job = res.dispatched.find((item) => item.id.startsWith("job-test-script"));
	assert.ok(job, "job dispatched in its scheduled minute");
	assert.ok(!launches.slice(before).some((l) => l.args.includes("--role") && l.args.includes("planner")), "no planner launched for mode self");
	assert.equal(job.status, "dispatched");
	assert.ok(!eventsLines().some((l) => l.includes("--role") && l.includes("planner")), "child dispatcher did not launch a planner either");
});
// Block 6 — fallback: missing script logs a failure instead of crashing
await runner.check("tick logs a failed dispatch when the script is missing", async () => {
	// Register a job against an EXISTING script, then delete the script so the
	// tick reports the fallback instead of dispatching.
	const ghost = path.join(scriptsDir, "ghost.js");
	fs.writeFileSync(ghost, "#!/usr/bin/env node\nconsole.log('GHOST');\n");
	cli(["schedule", "add", "--name", "ghost-tick", "--project-root", project, "--mode", "self", "--script", ghost, "--cron", "30 10 * * *"]);
	fs.rmSync(ghost);
	const { tick } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const res = await tick({ env, now: new Date(2026, 8, 3, 10, 30, 0), spawn: fakeSpawn });
	const job = res.dispatched.find((item) => item.name === "ghost-tick");
	assert.equal(job.status, "failed");
	assert.ok(job.enabled === false, "job disabled after script failure");
	assert.ok(job.script_failed === true || String(job.error || "").includes("script"), "fallback loggato per script mancante");
	assert.ok(!launches.some((l) => l.args.includes("--role") && l.args.includes("planner") && String(l.args.join(" ")).includes("ghost-tick")), "no planner fallback for a failed script — the old free-text dispatch is gone");
	assert.ok(!eventsLines().some((l) => l.includes("--role") && l.includes("planner")), "child dispatcher logged no planner fallback for a failed script");
});
// Block 7 — one-shot jobs run exactly once and then disable themselves
await runner.check("one-shot job runs once and disables itself", async () => {
	const { runYanoScheduler } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	// One-shot in-process job, registered through the CHILD CLI so the fake
	// spawn's crontab/events bookkeeping stays consistent, then driven in-process.
	const added = cli(["schedule", "add", "--name", "oneshot", "--project-root", project, "--mode", "self", "--script", path.join(scriptsDir, "test-echo.js"), "--cron", "0 0 * * *", "--once"]);
	const created = JSON.parse(added.trim().split("\n").at(-1)).created;
	assert.equal(created.one_shot, true);
	const listed = await runYanoScheduler({ argv: ["list"], env, spawn: fakeSpawn });
	const job = listed.find((item) => item.name === "oneshot");
	assert.equal(job.cron, "0 0 * * *");
	const { tick } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	const first = (await tick({ env, now: new Date(2026, 8, 4, 0, 0, 0), spawn: fakeSpawn })).dispatched.find((item) => item.id === created.id);
	assert.equal(first.status, "dispatched");
	assert.equal(first.one_shot_disabled, true, "one-shot disables itself after its single run");
	const after = await runYanoScheduler({ argv: ["list"], env, spawn: fakeSpawn });
	const stored = after.find((item) => item.name === "oneshot");
	assert.equal(stored.enabled, false);
});
// Block 8 — mode planner:<project> routes to a project planner with task text
await runner.check("mode planner:<project> launches a project planner with task text", async () => {
	const { runYanoScheduler } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-scheduler.mjs"));
	cli(["schedule", "add", "--name", "planner-job", "--project-root", project, "--mode", "planner:demo-project", "--script", path.join(scriptsDir, "wake.js"), "--cron", "0 12 * * *"]);
	const listed = await runYanoScheduler({ argv: ["list"], env, spawn: fakeSpawn });
	const pj = listed.find((item) => item.name === "planner-job");
	// The script runs first (mode self execution), then the planner compose is
	// verified through the public compose function (E2E launch of a real planner
	// is out of scope for the smoke suite — it requires Herdr + broker).
	const { composePlannerInvoke } = await import(path.join(PACKAGE_ROOT, "scripts", "yano-invoke.mjs"));
	const composed = await composePlannerInvoke({ projectScope: "demo-project", projectRoot: project });
	const cf = JSON.parse((composed.stdout.split("\n").find((line) => line.startsWith("{")) || "{}"));
	assert.equal(cf.project, "demo-project", "compose targets the declared project");
	assert.ok((cf.args || []).join(" ").includes("--role planner") && (cf.args || []).join(" ").includes("demo-project"), "compose args target role planner for the project scope");
	assert.match(String(pj.mode), /^planner:/, "registered mode is planner:<project>");
});
// Block 9 — `yano invoke --role computer-locale --prompt` is callable from the CLI
await runner.check("yano invoke --role computer-locale --prompt works from CLI", async () => {
	const out = cli(["invoke", "--role", "computer-locale", "--prompt", "promemoria tra 10 minuti: pausa caffè"]);
	const parsed = JSON.parse(out.trim().split("\n").at(-1));
	assert.equal(parsed.role, "computer-locale");
	assert.match(String(parsed.prompt), /pausa caff/);
	assert.ok("status" in parsed);
});
// Block 10 — `yano invoke --role planner --project <root> --prompt` is callable from the CLI
await runner.check("yano invoke --role planner --project <root> --prompt works from CLI", async () => {
	const out = cli(["invoke", "--role", "planner", "--project", "demo-project", "--project-root", project, "--prompt", "riepiloga lo stato del progetto"]);
	const parsed = JSON.parse(out.trim().split("\n").at(-1));
	assert.equal(parsed.role, "planner");
	assert.equal(parsed.project, "demo-project");
	assert.match(String(parsed.prompt), /riepiloga/);
});
// Block 11 — check:docs surface contract (read-only); legacy test still passes
await runner.check("documentation sync keeps passing", () => {
	const out = execFileSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "check-documentation-sync.mjs")], { cwd: PACKAGE_ROOT, encoding: "utf8" });
	assert.match(out, /Documentation sync passed/);
});
await runner.check("legacy scheduler smoke test still passes", () => {
	execFileSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "smoke-test-yano-scheduler.mjs")], { cwd: PACKAGE_ROOT, encoding: "utf8" });
});

console.log(`\nsmoke-test-yano-scheduler-script-first: ${runner.passed} passed, ${runner.failed} failed`);
fs.rmSync(root, { recursive: true, force: true });
if (runner.failed > 0) process.exit(1);