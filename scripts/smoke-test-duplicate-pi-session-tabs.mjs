import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupDuplicateProjectSessionTabs } from "./yano-watcher-registry.mjs";

const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-duplicate-session-test-"));
fs.writeFileSync(path.join(fakeBin, "herdr"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ result: { type: 'tab_close' } }));\n");
fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;

const row = { root: "/tmp/duplicate-session-project", name: "newbiz-website" };
const session = "/sessions/old.jsonl";
const snapshot = {
	workspaces: [{ workspace_id: "w1", label: row.name }],
	tabs: [
		{ tab_id: "t-keep", workspace_id: "w1", label: "coder-01" },
		{ tab_id: "t-duplicate", workspace_id: "w1", label: "coder-01-newbiz-website" },
		{ tab_id: "t-other", workspace_id: "w1", label: "reviewer-01" },
		{ tab_id: "t-human", workspace_id: "w1", label: "human" },
	],
	panes: [
		{ pane_id: "p-keep", tab_id: "t-keep", workspace_id: "w1", cwd: row.root, agent_session: { value: session } },
		{ pane_id: "p-duplicate", tab_id: "t-duplicate", workspace_id: "w1", cwd: row.root, agent_session: { value: session } },
		{ pane_id: "p-other", tab_id: "t-other", workspace_id: "w1", cwd: row.root, agent_session: { value: "/sessions/other.jsonl" } },
		{ pane_id: "p-human", tab_id: "t-human", workspace_id: "w1", cwd: row.root },
	],
	agents: [],
};
const closed = cleanupDuplicateProjectSessionTabs(snapshot, row, []);
assert.equal(closed.length, 1);
assert.ok(["t-keep", "t-duplicate"].includes(closed[0].tab_id));
assert.equal(closed[0].reason, "duplicate_pi_session");
snapshot.panes.find((pane) => pane.pane_id === "p-duplicate").agent_session.value = "/sessions/new.jsonl";
assert.deepEqual(cleanupDuplicateProjectSessionTabs(snapshot, row, []), [], "same name with different sessions is not a duplicate session");
fs.rmSync(fakeBin, { recursive: true, force: true });
console.log("DUPLICATE-PI-SESSION SMOKE TEST PASSED");
