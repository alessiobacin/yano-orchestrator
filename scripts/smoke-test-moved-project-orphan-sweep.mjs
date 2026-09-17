// Orphan maintenance tabs + moved-project verdict: deterministic coverage
// for the code-mem/auto-improver evidence (2026-09-15).
//
// 1. pruneOrphanMaintenanceTabs() closes agent-less, pi-less tabs in the
//    yano-auto-improver workspace (the w5K:t1 "1" shell + w5K:t2 finished
//    audit tab: zero agents, bare zsh, DB coordinates already NULL) while
//    sparing live agents, live pi processes, human/planner labels, tabs
//    without observable panes, and every tab outside maintenance
//    workspaces.
// 2. relocatedProjectVerdict(): a registry row whose root is gone resolves
//    to `relocated` when the same project marker is found under a bounded
//    candidate parent (the code-mem Desktop → Development/Code move), to
//    `missing` with an explicit `yano watcher init` re-add hint otherwise,
//    and to `active` when the root still exists (no behavior change).
// 3. ensureRegisteredPlanner() surfaces project_relocated/project_root_missing
//    instead of recovering a planner into a dead path.
//
// Zero Herdr/SQLite: injected snapshot, stub closeHerdrTab via a fake
// `herdr` binary on PATH, temp dirs as candidate parents.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-moved-project-"));
process.env.YANO_DATA_DIR = path.join(root, "data");
process.env.YANO_CONFIG_FILE = path.join(root, "no-such-config.env");

// Fake `herdr` on PATH: `tab close` succeeds and is logged; everything
// else fails (so paneHasLivePiProcess probes report null → unknown).
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "yano-moved-project-bin-"));
const closeLog = path.join(root, "herdr-close-calls.txt");
fs.writeFileSync(closeLog, "");
fs.writeFileSync(path.join(fakeBin, "herdr"), [
	"#!/usr/bin/env node",
	`if (process.argv[2] === "tab" && process.argv[3] === "close") { require("fs").appendFileSync(${JSON.stringify(closeLog)}, process.argv[4] + "\\n"); process.exit(0); }`,
	"process.exit(1);",
].join("\n"));
fs.chmodSync(path.join(fakeBin, "herdr"), 0o700);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;

const { pruneOrphanMaintenanceTabs } = await import("./watcher/herdr-tab-lifecycle.mjs");
const { relocatedProjectVerdict, findRelocatedRoot } = await import("./watcher/moved-project.mjs");
const { ensureRegisteredPlanner } = await import("./yano-watcher-registry.mjs");

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

// ── Fixture: a yano-auto-improver workspace shaped like the w5K evidence ──
const snapshot = {
	workspaces: [{ workspace_id: "w5K", label: "yano-auto-improver" }, { workspace_id: "w1X", label: "yano-watcher" }],
	tabs: [
		{ tab_id: "w5K:t1", workspace_id: "w5K", label: "1" },
		{ tab_id: "w5K:t2", workspace_id: "w5K", label: "auto-improver-code-mem-smoke-fixture" },
		{ tab_id: "w5K:t3", workspace_id: "w5K", label: "human" },
		{ tab_id: "w5K:t4", workspace_id: "w5K", label: "planner-01" },
		{ tab_id: "w1X:t9", workspace_id: "w1X", label: "watcher-code-mem-smoke-fixture" },
	],
	panes: [
		{ pane_id: "w5K:p1", workspace_id: "w5K", tab_id: "w5K:t1", cwd: "/tmp" },
		{ pane_id: "w5K:p2", workspace_id: "w5K", tab_id: "w5K:t2", cwd: "/tmp" },
		{ pane_id: "w5K:p3", workspace_id: "w5K", tab_id: "w5K:t3", cwd: "/tmp" },
		{ pane_id: "w5K:p4", workspace_id: "w5K", tab_id: "w5K:t4", cwd: "/tmp" },
	],
	agents: [],
};

check("agent-less dead maintenance tabs are closed with reason orphan_maintenance_tab", () => {
	const removed = pruneOrphanMaintenanceTabs(snapshot, { hasLivePi: () => false });
	assert.deepEqual(removed.map((item) => item.tab_id).sort(), ["w5K:t1", "w5K:t2"]);
	assert.ok(removed.every((item) => item.reason === "orphan_maintenance_tab" && item.closed));
	const calls = fs.readFileSync(closeLog, "utf8").trim().split("\n");
	assert.ok(calls.includes("w5K:t1") && calls.includes("w5K:t2"));
});

check("human/planner labels, unknown-liveness tabs and non-maintenance workspaces are never touched", () => {
	const removed = pruneOrphanMaintenanceTabs(snapshot, { hasLivePi: () => null });
	assert.deepEqual(removed, [], "on doubt (null liveness) nothing closes");
	const calls = fs.readFileSync(closeLog, "utf8");
	assert.ok(!calls.includes("w5K:t3") && !calls.includes("w5K:t4") && !calls.includes("w1X:t9"));
});

check("a live agent or a live pi process vetoes the close", () => {
	const withAgent = { ...snapshot, agents: [{ pane_id: "w5K:p1", agent_status: "idle" }] };
	assert.deepEqual(pruneOrphanMaintenanceTabs(withAgent, { hasLivePi: () => false }).map((item) => item.tab_id), ["w5K:t2"]);
	assert.deepEqual(pruneOrphanMaintenanceTabs(snapshot, { hasLivePi: (panes) => panes.includes("w5K:p1") }).map((item) => item.tab_id), ["w5K:t2"]);
});

check("a tab with no observable pane is left alone (absence of evidence)", () => {
	const noPane = { ...snapshot, panes: snapshot.panes.filter((pane) => pane.tab_id !== "w5K:t1") };
	assert.ok(!pruneOrphanMaintenanceTabs(noPane, { hasLivePi: () => false }).some((item) => item.tab_id === "w5K:t1"));
});

// ── Fixture: code-mem move — old Desktop root gone, marker under a sibling ──
// Shaped so the REAL candidateParents() path resolves it with no injection:
// the old root's parent (<tmp>/Desktop) exists and is scanned depth-1, and
// the marker matches by project NAME, not dirname (a move usually renames
// nothing, but the mechanism must not depend on that).
const oldParent = path.join(root, "Desktop");
const oldRoot = path.join(oldParent, "code-mem-smoke-fixture");
const newRoot = path.join(oldParent, "code-mem-smoke-fixture-new-home");
fs.mkdirSync(oldParent, { recursive: true }); // emptied old location, like ~/Desktop after the move
fs.mkdirSync(path.join(newRoot, ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
fs.writeFileSync(path.join(newRoot, ".pi", "extensions", "yano-orchestrator", "config", "project.json"), JSON.stringify({ project: "code-mem-smoke-fixture" }));

check("findRelocatedRoot finds the same project marker under a bounded sibling parent", () => {
	assert.equal(findRelocatedRoot(oldRoot, "code-mem-smoke-fixture"), newRoot);
	assert.equal(findRelocatedRoot(oldRoot, "other-project"), null, "a different project name never matches");
});

check("relocatedProjectVerdict returns relocated + proposal + re-add hint", () => {
	const verdict = relocatedProjectVerdict({ root: oldRoot, name: "code-mem-smoke-fixture" });
	assert.equal(verdict.status, "relocated");
	assert.equal(verdict.new_root, newRoot);
	assert.match(verdict.proposal, /spostato/);
	assert.match(verdict.readd_hint, /yano watcher init --project-root/);
});

check("relocatedProjectVerdict returns missing with an explicit re-add hint when nothing matches", () => {
	const verdict = relocatedProjectVerdict({ root: path.join(root, "gone", "nope"), name: "ghost" });
	assert.equal(verdict.status, "missing");
	assert.match(verdict.readd_hint, /yano watcher init --project-root/);
});

check("relocatedProjectVerdict returns active when the root still exists (no behavior change)", () => {
	assert.equal(relocatedProjectVerdict({ root: newRoot, name: "code-mem-smoke-fixture" }).status, "active");
});

check("ensureRegisteredPlanner surfaces project_relocated instead of recovering into a dead path", () => {
	const outcome = ensureRegisteredPlanner({ root: oldRoot, name: "code-mem-smoke-fixture", project_key: "k" }, { workspaces: [], tabs: [], panes: [], agents: [] }, null);
	assert.equal(outcome.recovery, "project_relocated");
	assert.equal(outcome.moved.status, "relocated");
	assert.equal(outcome.moved.new_root, newRoot);
});

check("ensureRegisteredPlanner surfaces project_root_missing when the project is nowhere to be found", () => {
	const outcome = ensureRegisteredPlanner({ root: path.join(root, "gone", "nope"), name: "ghost", project_key: "k" }, { workspaces: [], tabs: [], panes: [], agents: [] }, null);
	assert.equal(outcome.recovery, "project_root_missing");
	assert.match(outcome.moved.readd_hint, /yano watcher init/);
});

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(fakeBin, { recursive: true, force: true });
console.log(`\nsmoke-test-moved-project-orphan-sweep: ${passed} passed`);
