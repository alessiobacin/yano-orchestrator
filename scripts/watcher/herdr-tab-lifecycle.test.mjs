// Fase 3 / M1 — Herdr tab-lifecycle primitives, extracted from
// scripts/yano-watcher-registry.mjs. End-to-end tab open/close/rename
// behavior against a real project is already covered by the e2e smoke
// suite (smoke-test-fresh-agent-not-closed.mjs, smoke-test-orphaned-
// agentless-tabs.mjs, smoke-test-planner-tab-never-closed.mjs, ...) — these
// unit tests mock spawnSync/herdrSnapshot and focus on each primitive's own
// branching in isolation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...args) => spawnSyncMock(...args) }));

const herdrSnapshotMock = vi.fn(() => null);
vi.mock("../yano-herdr-client.mjs", () => ({ herdrSnapshot: (...args) => herdrSnapshotMock(...args) }));

const agentTabIdentityAuditMock = vi.fn(() => []);
vi.mock("../yano-agent-identity.mjs", () => ({ agentTabIdentityAudit: (...args) => agentTabIdentityAuditMock(...args) }));

beforeEach(() => {
	spawnSyncMock.mockReset();
	herdrSnapshotMock.mockReset().mockReturnValue(null);
	agentTabIdentityAuditMock.mockReset().mockReturnValue([]);
});

describe("closeHerdrTab", () => {
	it("returns closed:false without shelling out when tabId is missing", async () => {
		const { closeHerdrTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(closeHerdrTab(null)).toEqual({ closed: false, reason: "missing_tab_id" });
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("reports success on a zero exit status", async () => {
		spawnSyncMock.mockReturnValue({ status: 0 });
		const { closeHerdrTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(closeHerdrTab("tab-1")).toEqual({ closed: true, tab_id: "tab-1" });
		expect(spawnSyncMock).toHaveBeenCalledWith("herdr", ["tab", "close", "tab-1"], { encoding: "utf8" });
	});

	it("surfaces herdr's stderr on failure", async () => {
		spawnSyncMock.mockReturnValue({ status: 1, stderr: "no such tab" });
		const { closeHerdrTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(closeHerdrTab("tab-1")).toEqual({ closed: false, tab_id: "tab-1", error: "no such tab" });
	});
});

describe("renameHerdrTab", () => {
	it("is a no-op when either argument is missing", async () => {
		const { renameHerdrTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(() => renameHerdrTab(null, "label")).not.toThrow();
		expect(() => renameHerdrTab("tab-1", "")).not.toThrow();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("throws with herdr's stderr when the rename fails", async () => {
		spawnSyncMock.mockReturnValue({ status: 1, stderr: "tab busy" });
		const { renameHerdrTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(() => renameHerdrTab("tab-1", "new-label")).toThrow(/tab busy/);
	});
});

describe("watcherProcessMatches", () => {
	function processInfoResult(processes) {
		return { status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: processes } } }) };
	}

	it("returns null immediately when paneId is missing", async () => {
		const { watcherProcessMatches } = await import("./herdr-tab-lifecycle.mjs");
		expect(watcherProcessMatches({ root: "/p" }, null)).toBeNull();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns null when herdr is unreachable (non-zero exit)", async () => {
		spawnSyncMock.mockReturnValue({ status: 1 });
		const { watcherProcessMatches } = await import("./herdr-tab-lifecycle.mjs");
		expect(watcherProcessMatches({ root: "/p", interval_ms: 60000, lookback_ms: 3600000 }, "pane-1")).toBeNull();
	});

	it("returns true when the running command matches root/interval/lookback exactly", async () => {
		spawnSyncMock.mockReturnValue(processInfoResult([{ cmdline: "yano watch --project-root /p --interval-ms 60000 --lookback-ms 3600000 --away" }]));
		const { watcherProcessMatches } = await import("./herdr-tab-lifecycle.mjs");
		expect(watcherProcessMatches({ root: "/p", interval_ms: 60000, lookback_ms: 3600000 }, "pane-1")).toBe(true);
	});

	it("returns false when the process is running with a stale/different interval (config drift)", async () => {
		spawnSyncMock.mockReturnValue(processInfoResult([{ cmdline: "yano watch --project-root /p --interval-ms 300000 --lookback-ms 3600000 --away" }]));
		const { watcherProcessMatches } = await import("./herdr-tab-lifecycle.mjs");
		expect(watcherProcessMatches({ root: "/p", interval_ms: 60000, lookback_ms: 3600000 }, "pane-1")).toBe(false);
	});

	it("returns null when there is no foreground process at all", async () => {
		spawnSyncMock.mockReturnValue(processInfoResult([]));
		const { watcherProcessMatches } = await import("./herdr-tab-lifecycle.mjs");
		expect(watcherProcessMatches({ root: "/p", interval_ms: 60000, lookback_ms: 3600000 }, "pane-1")).toBeNull();
	});
});

describe("findOrCreateWatcherWorkspace", () => {
	it("reuses an existing yano-watcher workspace without shelling out", async () => {
		const snapshot = { workspaces: [{ workspace_id: "w-1", label: "yano-watcher" }] };
		const { findOrCreateWatcherWorkspace } = await import("./herdr-tab-lifecycle.mjs");
		expect(findOrCreateWatcherWorkspace(snapshot, "/p")).toEqual({ workspace: { workspace_id: "w-1", label: "yano-watcher" }, created: false });
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("dry-run returns a placeholder workspace without creating anything", async () => {
		const { findOrCreateWatcherWorkspace } = await import("./herdr-tab-lifecycle.mjs");
		const result = findOrCreateWatcherWorkspace({ workspaces: [] }, "/p", true);
		expect(result).toEqual({ workspace: { workspace_id: null, label: "yano-watcher" }, created: false, dry_run: true });
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("creates a new workspace and parses its id from herdr's stdout", async () => {
		spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: "w-new", label: "yano-watcher" } } }) });
		const { findOrCreateWatcherWorkspace } = await import("./herdr-tab-lifecycle.mjs");
		const result = findOrCreateWatcherWorkspace({ workspaces: [] }, "/p", false);
		expect(result).toEqual({ workspace: { workspace_id: "w-new", label: "yano-watcher" }, created: true });
	});

	it("falls back to a fresh herdrSnapshot() when the create response cannot be parsed", async () => {
		spawnSyncMock.mockReturnValue({ status: 0, stdout: "not json" });
		herdrSnapshotMock.mockReturnValue({ workspaces: [{ workspace_id: "w-refreshed", label: "yano-watcher" }] });
		const { findOrCreateWatcherWorkspace } = await import("./herdr-tab-lifecycle.mjs");
		const result = findOrCreateWatcherWorkspace({ workspaces: [] }, "/p", false);
		expect(result).toEqual({ workspace: { workspace_id: "w-refreshed", label: "yano-watcher" }, created: true });
	});

	it("throws when herdr fails to create the workspace", async () => {
		spawnSyncMock.mockReturnValue({ status: 1, stderr: "no display" });
		const { findOrCreateWatcherWorkspace } = await import("./herdr-tab-lifecycle.mjs");
		expect(() => findOrCreateWatcherWorkspace({ workspaces: [] }, "/p", false)).toThrow(/no display/);
	});
});

describe("pruneOrphanWatcherTabs", () => {
	it("returns [] when there is no snapshot", async () => {
		const { pruneOrphanWatcherTabs } = await import("./herdr-tab-lifecycle.mjs");
		expect(pruneOrphanWatcherTabs(null, [])).toEqual([]);
	});

	it("always closes obsolete debugger-*/suggester-* agent tabs regardless of root", async () => {
		spawnSyncMock.mockReturnValue({ status: 0 });
		const snapshot = { tabs: [{ tab_id: "t-1", label: "debugger-01" }, { tab_id: "t-2", label: "suggester-02" }], panes: [] };
		const { pruneOrphanWatcherTabs } = await import("./herdr-tab-lifecycle.mjs");
		const removed = pruneOrphanWatcherTabs(snapshot, []);
		expect(removed).toHaveLength(2);
		expect(removed.every((item) => item.obsolete_agent)).toBe(true);
	});

	it("closes a watcher-* tab whose pane root is neither a known registered root nor an existing path", async () => {
		spawnSyncMock.mockReturnValue({ status: 0 });
		const snapshot = { tabs: [{ tab_id: "t-1", label: "watcher-ghost-project" }], panes: [{ tab_id: "t-1", cwd: "/definitely/does/not/exist/anywhere" }] };
		const { pruneOrphanWatcherTabs } = await import("./herdr-tab-lifecycle.mjs");
		const removed = pruneOrphanWatcherTabs(snapshot, []);
		expect(removed).toEqual([{ tab_id: "t-1", label: "watcher-ghost-project", root: "/definitely/does/not/exist/anywhere", closed: true }]);
	});

	it("keeps a watcher-* tab whose pane root matches a currently-registered project", async () => {
		const snapshot = { tabs: [{ tab_id: "t-1", label: "watcher-known-project" }], panes: [{ tab_id: "t-1", cwd: process.cwd() }] };
		const { pruneOrphanWatcherTabs } = await import("./herdr-tab-lifecycle.mjs");
		const removed = pruneOrphanWatcherTabs(snapshot, [{ root: process.cwd() }]);
		expect(removed).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("ignores tabs that neither match the obsolete-agent nor the watcher- prefix", async () => {
		const snapshot = { tabs: [{ tab_id: "t-1", label: "planner-01" }], panes: [] };
		const { pruneOrphanWatcherTabs } = await import("./herdr-tab-lifecycle.mjs");
		expect(pruneOrphanWatcherTabs(snapshot, [])).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

describe("repairAgentTabIdentities", () => {
	it("renames every tab_identity_mismatch conflict reported by agentTabIdentityAudit", async () => {
		agentTabIdentityAuditMock.mockReturnValue([{ type: "tab_identity_mismatch", tab_id: "t-1", label: "old", actual: "new" }]);
		spawnSyncMock.mockReturnValue({ status: 0 });
		const { repairAgentTabIdentities } = await import("./herdr-tab-lifecycle.mjs");
		const repaired = repairAgentTabIdentities({ tabs: [], panes: [], agents: [] });
		expect(repaired).toEqual([{ tab_id: "t-1", from: "old", to: "new" }]);
		expect(spawnSyncMock).toHaveBeenCalledWith("herdr", ["tab", "rename", "t-1", "new"], { encoding: "utf8" });
	});

	it("records the error instead of throwing when a rename fails", async () => {
		agentTabIdentityAuditMock.mockReturnValue([{ type: "tab_identity_mismatch", tab_id: "t-1", label: "old", actual: "new" }]);
		spawnSyncMock.mockReturnValue({ status: 1, stderr: "tab gone" });
		const { repairAgentTabIdentities } = await import("./herdr-tab-lifecycle.mjs");
		const repaired = repairAgentTabIdentities({ tabs: [], panes: [], agents: [] });
		expect(repaired[0]).toMatchObject({ tab_id: "t-1", error: expect.stringContaining("tab gone") });
	});

	it("closes an orphaned planner recovery tab that has no live/active agent", async () => {
		spawnSyncMock.mockReturnValue({ status: 0 });
		const snapshot = {
			tabs: [{ tab_id: "t-1", label: "planner-01-recovery-abc123" }],
			panes: [{ tab_id: "t-1", pane_id: "p-1" }],
			agents: [{ pane_id: "p-1", agent_status: "offline" }],
		};
		const { repairAgentTabIdentities } = await import("./herdr-tab-lifecycle.mjs");
		const repaired = repairAgentTabIdentities(snapshot);
		expect(repaired).toEqual([{ tab_id: "t-1", action: "close_orphan_recovery_tab", closed: true }]);
	});

	it("leaves a planner recovery tab alone while its agent is still active", async () => {
		const snapshot = {
			tabs: [{ tab_id: "t-1", label: "planner-01-recovery-abc123" }],
			panes: [{ tab_id: "t-1", pane_id: "p-1" }],
			agents: [{ pane_id: "p-1", agent_status: "working" }],
		};
		const { repairAgentTabIdentities } = await import("./herdr-tab-lifecycle.mjs");
		expect(repairAgentTabIdentities(snapshot)).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

describe("closeUnusedInitialTab", () => {
	it("returns null when there is no bare-numbered initial tab", async () => {
		const { closeUnusedInitialTab } = await import("./herdr-tab-lifecycle.mjs");
		const snapshot = { tabs: [{ tab_id: "t-1", workspace_id: "w-1", label: "planner-01" }] };
		expect(closeUnusedInitialTab(snapshot, "w-1", "t-keep")).toBeNull();
	});

	it("closes the initial numbered tab when it has no live/active agent", async () => {
		spawnSyncMock.mockReturnValue({ status: 0 });
		const snapshot = {
			tabs: [{ tab_id: "t-initial", workspace_id: "w-1", label: "1" }],
			panes: [{ tab_id: "t-initial", pane_id: "p-1" }],
			agents: [{ pane_id: "p-1", agent_status: "done" }],
		};
		const { closeUnusedInitialTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(closeUnusedInitialTab(snapshot, "w-1", "t-keep")).toEqual({ closed: true, tab_id: "t-initial" });
	});

	it("never closes the tab passed as keepTabId, even if it looks like an initial numbered tab", async () => {
		const snapshot = { tabs: [{ tab_id: "t-1", workspace_id: "w-1", label: "1" }] };
		const { closeUnusedInitialTab } = await import("./herdr-tab-lifecycle.mjs");
		expect(closeUnusedInitialTab(snapshot, "w-1", "t-1")).toBeNull();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});
