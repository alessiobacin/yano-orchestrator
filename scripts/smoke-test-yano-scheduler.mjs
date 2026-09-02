import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseNaturalSchedule, runYanoScheduler, schedulerCronStatus, validCron } from "./yano-scheduler.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-scheduler-"));
const data = path.join(root, "data");
const project = path.join(root, "llmproxy");
fs.mkdirSync(project);
let crontab = "MAILTO=test@example.invalid\n";
let workspaceCreated = false;
let schedulerTabCreated = false;
const launches = [];
const spawn = (command, args, options = {}) => {
	if (command === "crontab" && args[0] === "-l") return { status: 0, stdout: crontab, stderr: "" };
	if (command === "crontab" && args[0] === "-") { crontab = options.input; return { status: 0, stdout: "", stderr: "" }; }
	if (command === "herdr" && args[0] === "workspace" && args[1] === "create") { workspaceCreated = true; return { status: 0, stdout: "", stderr: "" }; }
	if (command === "herdr" && args[0] === "tab" && args[1] === "create") { schedulerTabCreated = true; return { status: 0, stdout: "", stderr: "" }; }
	if (command === process.execPath && args.includes("launch-planner.mjs")) return { status: 0, stdout: JSON.stringify({ args: ["--instance", "yano-scheduler", "--role", "scheduler"] }), stderr: "" };
	if (command === "herdr") {
		const workspace = workspaceCreated ? [{ workspace_id: "w-scheduler", label: "yano-scheduler" }] : [];
		const tabs = schedulerTabCreated ? [{ tab_id: "t-scheduler", workspace_id: "w-scheduler", label: "yano-scheduler" }] : [];
		const panes = schedulerTabCreated ? [{ pane_id: "p-scheduler", tab_id: "t-scheduler", workspace_id: "w-scheduler", cwd: path.resolve(process.cwd()) }] : [];
		return { status: 0, stdout: JSON.stringify({ result: { snapshot: { agents: [], workspaces: workspace, tabs, panes } } }), stderr: "" };
	}
	launches.push({ command, args, cwd: options.cwd }); return { status: 0, stdout: "started", stderr: "" };
};
const env = { ...process.env, YANO_DATA_DIR: data };

try {
	assert.deepEqual(parseNaturalSchedule("ogni giorno alle 14 e alle 21 voglio che esegui la pulizia del progetto llmproxy"), { cron: "0 14,21 * * *", task: "la pulizia del progetto llmproxy" });
	assert.deepEqual(parseNaturalSchedule("ogni settimana di lunedì alle 13:00 fai partire un resoconto delle risorse"), { cron: "0 13 * * 1", task: "un resoconto delle risorse" });
	assert.equal(validCron("0 14,21 * * *"), true);
	assert.equal(validCron("0 25 * * *"), false);

	const created = await runYanoScheduler({ argv: ["add-natural", "--task", "ogni giorno alle 14 e alle 21 voglio che esegui la pulizia del progetto llmproxy", "--project-root", project, "--json"], env, now: new Date("2026-09-02T10:00:00Z"), spawn });
	assert.equal(created.created.cron, "0 14,21 * * *");
	assert.match(crontab, /yano-scheduler-supervisor/);
	const listed = await runYanoScheduler({ argv: ["list"], env, spawn });
	assert.equal(listed.length, 1);

	const supervised = await runYanoScheduler({ argv: ["supervise"], env, now: new Date(2026, 8, 2, 14, 0, 0), spawn });
	assert.equal(supervised.agent.recovered, true, "supervisor recreates the scheduler agent when Herdr has no live tab");
	assert.equal(supervised.dispatched.length, 1, "due job is dispatched exactly once in its scheduled minute");
	assert.ok(launches.some((launch) => launch.args.includes("--role") && launch.args.includes("scheduler")), "recovery launches the persistent scheduler role");
	assert.ok(launches.some((launch) => launch.args.includes("--role") && launch.args.includes("planner")), "a due job launches a project-scoped planner");
	assert.equal(schedulerCronStatus({ spawn }).installed, true);
	console.log("smoke-test-yano-scheduler: ok (natural CRUD, durable registry, cron and self-healing agent)");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
