// Regression guard for the newMioDOC incident (2026-09-07): a freshly-launched
// agent instance (planner runs `yano start --instance frontend-developer-01
// ...`) creates a Herdr PANE immediately, but Herdr only adds a matching row
// to `snapshot.agents` once its own polling detects the `pi` process running
// inside that pane — a real, observed, nonzero delay. cleanupStaleProjectTabs()
// runs on every yano-watcher sweep (~every 60s) and, before this fix, looked
// up the `agent` entry by `tab_id` DIRECTLY instead of via the pane's own
// `pane_id` — the correct pattern already used elsewhere in this same file
// (see e.g. resolveWatcherAgentForRow(), ~line 212-213, and the recovery path
// at ~line 1109). Since a pane genuinely exists — and can genuinely have a
// live `pi` process — well before Herdr's agent index catches up, this
// mismatch made `live` short-circuit to `false` WITHOUT EVER actually calling
// paneHasLivePiProcess() to check the pane's real state. A brand-new,
// not-yet-ticketed instance was therefore closed and logged as "dead_agent"
// within its very first watcher sweep, sometimes seconds after connecting and
// before the planner ever got a chance to delegate a ticket to it.
//
// Real evidence: newMioDOC's frontend-developer-01 and coder-01 both
// connected via MQTT (session_start/connected trace events, 2026-09-07
// 07:31:40Z / 07:31:52Z) and then vanished from `herdr api snapshot` entirely
// minutes later, with ZERO agent_terminate_received/sent trace events for
// either instance — proof the close bypassed Yano's own graceful MQTT
// TerminateEnvelope/handleTerminate() protocol and went straight through
// closeHerdrTab() instead, from this exact sweep.
//
// No real `herdr` binary is required beyond the same fake-binary seam used by
// smoke-test-planner-tab-never-closed.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupStaleProjectTabs } from "./yano-watcher-registry.mjs";

console.log("Regression: a freshly-launched, not-yet-indexed agent survives cleanupStaleProjectTabs()");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-fresh-agent-test-bin-"));
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	'const alive = new Set((process.env.YANO_TEST_ALIVE_PANES || "").split(",").filter(Boolean));',
	'if (process.argv[2] === "pane" && process.argv[3] === "process-info") {',
	'  const paneId = process.argv[process.argv.indexOf("--pane") + 1];',
	'  const foreground = alive.has(paneId) ? [{ argv0: "pi", argv: ["pi"] }] : [];',
	'  process.stdout.write(JSON.stringify({ result: { process_info: { foreground_processes: foreground } } }));',
	"  process.exit(0);",
	"}",
	'process.stdout.write("{}");',
	"process.exit(1);",
].join("\n"));
fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.YANO_TEST_ALIVE_PANES = "p-fresh-frontend-dev";

const row = { root: "/tmp/fixture-project", name: "fixture-project" };

check("a tab+pane exist but the agent has not yet been indexed by Herdr, and the pane's process is genuinely alive: the tab must NOT be closed", () => {
	const snapshot = {
		// Deliberately NO entry in agents[] — this is the exact Herdr
		// detection-lag window the bug lived in.
		agents: [],
		tabs: [{ tab_id: "t-fresh-frontend-dev", workspace_id: "w1", label: "frontend-developer-01" }],
		panes: [{ pane_id: "p-fresh-frontend-dev", tab_id: "t-fresh-frontend-dev", workspace_id: "w1", cwd: row.root }],
		workspaces: [{ workspace_id: "w1", label: row.name }],
	};
	const removed = cleanupStaleProjectTabs(snapshot, row, []);
	assert.deepEqual(removed, [], "a freshly-connected agent not yet indexed by Herdr must survive the stale-tab sweep, since its pane is genuinely alive");
});

check("control: the same not-yet-indexed shape WITHOUT a live process is still correctly closed as dead", () => {
	const snapshot = {
		agents: [],
		tabs: [{ tab_id: "t-fresh-dead", workspace_id: "w1", label: "frontend-developer-02" }],
		panes: [{ pane_id: "p-fresh-dead-no-process", tab_id: "t-fresh-dead", workspace_id: "w1", cwd: row.root }],
		workspaces: [{ workspace_id: "w1", label: row.name }],
	};
	const removed = cleanupStaleProjectTabs(snapshot, row, []);
	assert.equal(removed.length, 1, "a genuinely dead, not-yet-indexed pane is still correctly closed");
	assert.equal(removed[0].reason, "dead_agent");
});

check("once Herdr DOES index the agent (normal case), a live worker still survives as before", () => {
	const snapshot = {
		agents: [{ name: "coder-05", cwd: row.root, tab_id: "t-indexed", pane_id: "p-indexed-live", agent_status: "working" }],
		tabs: [{ tab_id: "t-indexed", workspace_id: "w1", label: "coder-05" }],
		panes: [{ pane_id: "p-indexed-live", tab_id: "t-indexed", workspace_id: "w1", cwd: row.root }],
		workspaces: [{ workspace_id: "w1", label: row.name }],
	};
	process.env.YANO_TEST_ALIVE_PANES = "p-indexed-live";
	const removed = cleanupStaleProjectTabs(snapshot, row, []);
	assert.deepEqual(removed, [], "an already-indexed live worker is unaffected by this fix");
});

delete process.env.YANO_TEST_ALIVE_PANES;
fs.rmSync(fakeBin, { recursive: true, force: true });
console.log(`\nsmoke-test-fresh-agent-not-closed: ${passed} passed`);
