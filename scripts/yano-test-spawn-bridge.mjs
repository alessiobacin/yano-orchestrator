// Test-only bridge: exposes a self-contained fake `spawn` (built from the meta
// passed by the smoke test) so `yano schedule`/`yano cron` child processes can
// use it as their `spawn`. Only the smoke test
// (smoke-test-yano-scheduler-script-first.mjs) imports this module; production
// never reads YANO_TEST_SPAWN_BRIDGE (see yano-scheduler.mjs). The returned
// function captures no outer bindings — the crontab is persisted to a file the
// parent test reads, so parent assertions and child writes stay in sync.
export function yanoTestSpawn(meta) {
	const fs = process.getBuiltinModule("node:fs");
	const path = process.getBuiltinModule("node:path");
	const crontabFile = meta.crontabFile;
	const eventsFile = meta.eventsFile;
	const marker = "# yano-scheduler-supervisor";
	const recordEvent = (line) => { try { fs.appendFileSync(eventsFile, `${line}\n`); } catch { /* best effort */ } };
	return function fakeSpawn(command, args, options = {}) {
		if (command === "crontab" && args[0] === "-l") {
			const current = fs.existsSync(crontabFile) ? fs.readFileSync(crontabFile, "utf8") : "MAILTO=test@example.invalid\n";
			return { status: 0, stdout: current, stderr: "" };
		}
		if (command === "crontab" && args[0] === "-") {
			fs.writeFileSync(crontabFile, options.input || "");
			return { status: 0, stdout: "", stderr: "" };
		}
		if (command === "herdr" && args[0] === "workspace" && args[1] === "create") {
			recordEvent("workspace");
			return { status: 0, stdout: "", stderr: "" };
		}
		if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
			recordEvent("tab");
			return { status: 0, stdout: "", stderr: "" };
		}
		if (command === "herdr") {
			// Static snapshot: the scheduler supervisor can always find its own
			// workspace/tab once created; no live Pi agents.
			const workspace = fs.existsSync(eventsFile) && fs.readFileSync(eventsFile, "utf8").split("\n").includes("workspace")
				? [{ workspace_id: "w-scheduler", label: "yano-scheduler" }] : [];
			const tabCreated = fs.existsSync(eventsFile) && fs.readFileSync(eventsFile, "utf8").split("\n").includes("tab");
			const tabs = tabCreated ? [{ tab_id: "t-scheduler", workspace_id: "w-scheduler", label: "scheduler-service" }] : [];
			const panes = tabCreated ? [{ pane_id: "p-scheduler", tab_id: "t-scheduler", workspace_id: "w-scheduler", cwd: meta.projectRoot }] : [];
			return { status: 0, stdout: JSON.stringify({ result: { snapshot: { agents: [], workspaces: workspace, tabs, panes } } }), stderr: "" };
		}
		recordEvent(`launch ${command} ${JSON.stringify(args || [])}`);
		return { status: 0, stdout: "started", stderr: "" };
	};
}