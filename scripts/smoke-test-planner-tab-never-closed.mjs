// Regression guard for Fase 3 of the cron/watcher/scheduler restructuring:
// cleanupCompletedAgentTabs() — the watcher's per-minute sweep that closes
// dead/finished agent tabs — must NEVER close a planner's own tab, even when
// every ticket assigned to it is terminal (done/failed) or the pane looks
// dead. A project's planner+workspace must stay alive even after all
// assigned work is complete; only ensureRegisteredPlanner() (a distinct,
// cooldown-gated function) is allowed to close and recreate a genuinely
// stuck planner tab.
//
// The `isPlanner` exemption (`if (isPlanner) continue;`) was already correct
// in the code at the time of this test, but had no dedicated regression
// test — a generic-looking future refactor of this sweep could silently
// reintroduce the pre-fix behavior (see commit history: an earlier version
// gated the exemption on `plannerRequired && !dead`, which COULD close a
// planner in some states) without any test catching it.
//
// No real `herdr` binary is required: cleanupCompletedAgentTabs() only
// decides WHICH tabs to attempt to close before invoking closeHerdrTab();
// the planner exemption happens before that call is ever reached, so this
// test only needs to inspect the returned `removed` list.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupCompletedAgentTabs } from "./yano-watcher-registry.mjs";

console.log("Regression: planner tab is never closed by cleanupCompletedAgentTabs()");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

// cleanupCompletedAgentTabs() calls paneHasLivePiProcess(), which shells out
// to a real `herdr pane process-info` with no injection seam. A fake herdr
// on PATH reports a live "pi" process for any pane_id listed in
// YANO_TEST_ALIVE_PANES (comma-separated) — needed to test the "an
// in-progress, genuinely alive worker survives" case, which a missing/absent
// herdr binary can't distinguish from "dead" on its own.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-planner-tab-test-bin-"));
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
process.env.YANO_TEST_ALIVE_PANES = "p-coder-running";

const row = { root: "/tmp/fixture-project", name: "fixture-project" };

function snapshotWith(agents) {
	return {
		agents,
		tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: "w1" })),
	};
}

check("a planner tab with ALL its tickets done/failed is never included in the closed list", () => {
	const agents = [
		{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" },
	];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "planner-01" }, { status: "failed", assigned_instance: "planner-01" }] }];
	const removed = cleanupCompletedAgentTabs(snapshotWith(agents), row, runs);
	assert.deepEqual(removed, [], "planner-01 must not appear in the closed-tab list even with only terminal tickets");
});

check("a planner tab whose pane LOOKS dead (no live pi process detectable) is still never closed by this sweep", () => {
	// paneHasLivePiProcess() calls a real `herdr pane process-info`; with no
	// herdr binary reachable in this test environment it deterministically
	// returns false ("dead"), which is exactly the case this test needs: a
	// planner that LOOKS dead to this generic sweep must still be exempt —
	// only ensureRegisteredPlanner()'s cooldown-gated path may act on it.
	const agents = [{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner-looks-dead", agent_status: "offline" }];
	const removed = cleanupCompletedAgentTabs(snapshotWith(agents), row, []);
	assert.deepEqual(removed, [], "a planner tab is exempt from this generic sweep regardless of apparent liveness");
});

check("a NON-planner agent with a terminal ticket IS included (the sweep still does its actual job)", () => {
	const agents = [{ name: "coder-01", cwd: row.root, tab_id: "t-coder", pane_id: "p-coder", agent_status: "idle" }];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "coder-01" }] }];
	const removed = cleanupCompletedAgentTabs(snapshotWith(agents), row, runs);
	// reason is "terminal_ticket" vs "dead_process" depending on whether the
	// real `herdr` binary is reachable in this environment (paneHasLivePiProcess
	// falls back to "dead" without it) — this test only asserts on WHICH
	// instance was attempted, which is what the planner exemption is actually
	// about; the exact reason string has its own coverage elsewhere.
	assert.equal(removed.length, 1, "a finished non-planner agent's tab is still attempted for closure");
	assert.equal(removed[0].instance, "coder-01");
	assert.ok(["terminal_ticket", "dead_process"].includes(removed[0].reason));
});

check("a mixed snapshot: planner survives, finished coder is closed, in-progress coder survives", () => {
	const agents = [
		{ name: "planner-01", cwd: row.root, tab_id: "t-planner", pane_id: "p-planner", agent_status: "idle" },
		{ name: "coder-01", cwd: row.root, tab_id: "t-coder-done", pane_id: "p-coder-done", agent_status: "idle" },
		{ name: "coder-02", cwd: row.root, tab_id: "t-coder-running", pane_id: "p-coder-running", agent_status: "working" },
	];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "coder-01" }, { status: "running", assigned_instance: "coder-02" }] }];
	const removed = cleanupCompletedAgentTabs(snapshotWith(agents), row, runs);
	assert.deepEqual(removed.map((item) => item.instance), ["coder-01"], "only the finished, non-planner agent is closed — planner and in-progress worker both survive");
});

check("an agent instance from a DIFFERENT project's cwd is never touched", () => {
	const agents = [{ name: "coder-01", cwd: "/tmp/other-project", tab_id: "t-other", pane_id: "p-other", agent_status: "idle" }];
	const runs = [{ tickets: [{ status: "done", assigned_instance: "coder-01" }] }];
	const removed = cleanupCompletedAgentTabs(snapshotWith(agents), row, runs);
	assert.deepEqual(removed, [], "cwd scoping prevents cross-project tab closure");
});

delete process.env.YANO_TEST_ALIVE_PANES;
fs.rmSync(fakeBin, { recursive: true, force: true });
console.log(`\nsmoke-test-planner-tab-never-closed: ${passed} passed`);
