import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { buildHerdrInitCommand, runHerdrInit } from "./init-herdr.mjs";

const calls = [];
const root = path.resolve("/tmp/yano-init-herdr-smoke");
fs.mkdirSync(root, { recursive: true });
const runner = (_binary, args) => {
	calls.push(args);
	if (args[0] === "api" && args[1] === "snapshot") return { status: 0, stdout: JSON.stringify({ result: { workspaces: [], panes: [], agents: [] } }), stderr: "" };
	if (args[0] === "workspace" && args[1] === "create") {
		return {
			status: 0,
			stdout: JSON.stringify({ result: { workspace: { workspace_id: "w-smoke", label: "yano-init-herdr-smoke" }, root_pane: { pane_id: "w-smoke:p1" } } }),
			stderr: "",
		};
	}
	if (args[0] === "workspace" && args[1] === "focus") return { status: 0, stdout: "", stderr: "" };
	if (args[0] === "pane" && args[1] === "run") return { status: 0, stdout: "", stderr: "" };
	if (args.length === 0) return { status: 0, stdout: "", stderr: "" };
	throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
};

const saveHerdrEnv = process.env.HERDR_ENV;
		delete process.env.HERDR_ENV; // test seam: runHerdrInit must see a plain shell, not the agent harness env
		const result = runHerdrInit({ cwd: root, initArgs: ["--name", "Focus 'Board'", "--llmp"], runner, herdrBin: "herdr", platform: "linux", launchClient: true });
		if (saveHerdrEnv) process.env.HERDR_ENV = saveHerdrEnv;
assert.equal(result.workspace.workspace_id, "w-smoke");
assert.equal(result.pane.pane_id, "w-smoke:p1");
assert.equal(calls[1][0], "workspace");
assert.deepEqual(calls[2], ["workspace", "focus", "w-smoke"]);
assert.equal(calls[3].slice(0, 3).join(" "), "pane run w-smoke:p1");
assert.equal(calls[3].length, 4, "pane run receives one complete command string");
assert.match(calls[3][3], /^yano init /);
assert.match(calls[3][3], /&& exec yano start/);
assert.match(calls[3][3], /planner-01/);
assert.doesNotMatch(calls[3][3], /sh -lc/);
assert.deepEqual(calls[4], [], "a normal terminal opens/attaches the Herdr client");
assert.equal(result.clientOpened, true);

const linux = buildHerdrInitCommand({ initArgs: ["--name", "A project's test"], platform: "linux" });
assert.match(linux.command, /^yano init --name /);
assert.match(linux.command, /A project.*s test/);
assert.match(linux.command, /&& exec yano start/);

const windows = buildHerdrInitCommand({ initArgs: ["--name", "Windows test"], platform: "win32" });
assert.match(windows.command, /^yano init --name /);
assert.match(windows.command, /&& yano start/);

const reuseCalls = [];
const reuseRunner = (_binary, args) => {
	reuseCalls.push(args);
	if (args[0] === "api" && args[1] === "snapshot") return {
		status: 0,
		stdout: JSON.stringify({ result: { snapshot: {
			workspaces: [{ workspace_id: "w-existing", label: "yano-init-herdr-smoke" }],
			panes: [{ pane_id: "w-existing:p1", workspace_id: "w-existing", cwd: root }],
			agents: [],
		} } }),
		stderr: "",
	};
	if (args[0] === "workspace" && args[1] === "focus") return { status: 0, stdout: "", stderr: "" };
	if (args[0] === "pane" && args[1] === "run") return { status: 0, stdout: "", stderr: "" };
	if (args.length === 0) return { status: 0, stdout: "", stderr: "" };
	throw new Error(`unexpected reuse Herdr call: ${args.join(" ")}`);
};
delete process.env.HERDR_ENV; // test seam (same as first call block)
const reused = runHerdrInit({ cwd: root, initArgs: ["--name", "Focus Board"], runner: reuseRunner, herdrBin: "herdr", platform: "linux", launchClient: true });
assert.equal(reused.reused, true);
assert.equal(reuseCalls.filter((args) => args[0] === "workspace" && args[1] === "create").length, 0);
assert.deepEqual(reuseCalls[1], ["workspace", "focus", "w-existing"]);
assert.deepEqual(reuseCalls[3], [], "a normal terminal attaches Herdr also when reusing a workspace");

console.log("YANO INIT HERDR SMOKE TEST PASSED (workspace, pane command and quoting)");
fs.rmSync(root, { recursive: true, force: true });
