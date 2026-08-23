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
	if (args[0] === "pane" && args[1] === "run") return { status: 0, stdout: "", stderr: "" };
	throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
};

const result = runHerdrInit({ cwd: root, initArgs: ["--name", "Focus 'Board'", "--llmp"], runner, herdrBin: "herdr", platform: "linux" });
assert.equal(result.workspace.workspace_id, "w-smoke");
assert.equal(result.pane.pane_id, "w-smoke:p1");
assert.equal(calls[1][0], "workspace");
assert.equal(calls[2].slice(0, 3).join(" "), "pane run w-smoke:p1");
assert.match(calls[2].join(" "), /yano.*init/);
assert.match(calls[2].join(" "), /yano.*start/);
assert.match(calls[2].join(" "), /planner-01/);

const linux = buildHerdrInitCommand({ initArgs: ["--name", "A project's test"], platform: "linux" });
assert.equal(linux.executable, "sh");
assert.match(linux.args.join(" "), /exec/);

const windows = buildHerdrInitCommand({ initArgs: ["--name", "Windows test"], platform: "win32" });
assert.equal(windows.executable, "cmd.exe");
assert.equal(windows.args[0], "/d");

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
	if (args[0] === "pane" && args[1] === "run") return { status: 0, stdout: "", stderr: "" };
	throw new Error(`unexpected reuse Herdr call: ${args.join(" ")}`);
};
const reused = runHerdrInit({ cwd: root, initArgs: ["--name", "Focus Board"], runner: reuseRunner, herdrBin: "herdr", platform: "linux" });
assert.equal(reused.reused, true);
assert.equal(reuseCalls.filter((args) => args[0] === "workspace").length, 0);

console.log("YANO INIT HERDR SMOKE TEST PASSED (workspace, pane command and quoting)");
fs.rmSync(root, { recursive: true, force: true });
