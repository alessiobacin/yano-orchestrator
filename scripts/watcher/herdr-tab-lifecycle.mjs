// Fase 3 / M1 — low-level Herdr tab lifecycle primitives, extracted
// verbatim from scripts/yano-watcher-registry.mjs. Pure functions of
// (snapshot, ...) plus shell-out to the `herdr` CLI; no watcher-registry DB
// access. (shellQuote is NOT part of this module — it is used by several
// other call sites left in yano-watcher-registry.mjs, so it stays there;
// scripts/watcher/cron-schedule.mjs, Fase 3/M0, already keeps its own
// independent copy for the same reason.)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentTabIdentityAudit } from "../yano-agent-identity.mjs";
import { herdrSnapshot } from "../yano-herdr-client.mjs";
import { traceRoot } from "../yano-trace-storage.mjs";

const WORKSPACE_LABEL = "yano-watcher";

export function renameHerdrTab(tabId, label) {
	if (!tabId || !label) return;
	const result = spawnSync("herdr", ["tab", "rename", tabId, label], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile rinominare la tab ${tabId} in ${label}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

export function closeHerdrTab(tabId) {
	if (!tabId) return { closed: false, reason: "missing_tab_id" };
	const result = spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
	return result.status === 0
		? { closed: true, tab_id: tabId }
		: { closed: false, tab_id: tabId, error: (result.stderr || result.stdout || "Herdr non ha chiuso la tab").trim() };
}

export function watcherProcessMatches(row, paneId) {
	if (!paneId) return null;
	const result = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], { encoding: "utf8", maxBuffer: 2_000_000 });
	if (result.status !== 0) return null;
	try {
		const payload = JSON.parse(result.stdout || "");
		const processes = payload?.result?.process_info?.foreground_processes || [];
		if (!processes.length) return null;
		const command = processes.map((item) => item.cmdline || item.argv?.join(" ") || "").join(" ");
		return command.includes("yano watch") && command.includes(`--project-root ${row.root}`) && command.includes(`--interval-ms ${Math.max(1000, Number(row.interval_ms))}`) && command.includes(`--lookback-ms ${Math.max(1000, Number(row.lookback_ms))}`);
	} catch { return null; }
}

export function repairAgentTabIdentities(snapshot) {
	const repaired = [];
	for (const conflict of agentTabIdentityAudit(snapshot)) {
		if (conflict.type !== "tab_identity_mismatch") continue;
		try {
			renameHerdrTab(conflict.tab_id, conflict.actual);
			repaired.push({ tab_id: conflict.tab_id, from: conflict.label, to: conflict.actual });
		} catch (error) {
			repaired.push({ tab_id: conflict.tab_id, from: conflict.label, to: conflict.actual, error: error instanceof Error ? error.message : String(error) });
		}
	}
	// Recovery tabs are implementation artefacts, never durable agents. A
	// previous race could leave several empty planner recovery tabs behind;
	// remove only tabs with no live pane/agent, never an active work tab.
	for (const tab of snapshot?.tabs || []) {
		if (!/^planner-\d{2}-recovery-/i.test(tab.label || "")) continue;
		const pane = (snapshot.panes || []).find((item) => item.tab_id === tab.tab_id);
		const agent = pane && (snapshot.agents || []).find((item) => item.pane_id === pane.pane_id);
		if (agent && !["done", "offline", "unknown", "stopped"].includes(String(agent.agent_status || "").toLowerCase())) continue;
		const closed = closeHerdrTab(tab.tab_id);
		repaired.push({ tab_id: tab.tab_id, action: "close_orphan_recovery_tab", ...closed });
	}
	return repaired;
}

export function closeUnusedInitialTab(snapshot, workspaceId, keepTabId) {
	const initial = (snapshot?.tabs || []).find((tab) => tab.workspace_id === workspaceId && tab.tab_id !== keepTabId && /^(1|\d+)$/.test(tab.label || ""));
	if (!initial) return null;
	const pane = (snapshot?.panes || []).find((item) => item.tab_id === initial.tab_id);
	const agent = pane && (snapshot?.agents || []).find((item) => item.pane_id === pane.pane_id);
	if (agent && !["done", "offline", "unknown"].includes(String(agent.agent_status || "").toLowerCase())) return null;
	return closeHerdrTab(initial.tab_id);
}

export function findOrCreateWatcherWorkspace(snapshot, root, dryRun = false) {
	let workspace = snapshot?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (workspace) return { workspace, created: false };
	if (dryRun) return { workspace: { workspace_id: null, label: WORKSPACE_LABEL }, created: false, dry_run: true };
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", root, "--label", WORKSPACE_LABEL, "--focus"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`yano watcher: impossibile creare il workspace Herdr "${WORKSPACE_LABEL}"${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	try {
		const parsed = JSON.parse(result.stdout);
		workspace = parsed?.result?.workspace || parsed?.workspace;
	} catch { /* refresh below */ }
	if (!workspace?.workspace_id) workspace = herdrSnapshot()?.workspaces?.find((item) => item.label === WORKSPACE_LABEL);
	if (!workspace?.workspace_id) throw new Error("yano watcher: Herdr ha creato il workspace ma non ha restituito workspace_id");
	return { workspace, created: true };
}

export function pruneOrphanWatcherTabs(snapshot, rows) {
	if (!snapshot) return [];
	const knownRoots = new Set(rows.map((row) => path.resolve(row.root)));
	const removed = [];
	for (const tab of snapshot.tabs || []) {
		if (/^(debugger|suggester)(-|$)/i.test(tab.label || "")) {
			const closed = closeHerdrTab(tab.tab_id);
			removed.push({ tab_id: tab.tab_id, label: tab.label, root: null, obsolete_agent: true, ...closed });
			continue;
		}
		if (!/^watcher-/i.test(tab.label || "")) continue;
		const pane = (snapshot.panes || []).find((item) => item.tab_id === tab.tab_id);
		const root = pane?.cwd ? path.resolve(pane.cwd) : null;
		if (!root || (root !== path.resolve(traceRoot()) && !knownRoots.has(root) && !fs.existsSync(root))) {
			const closed = closeHerdrTab(tab.tab_id);
			removed.push({ tab_id: tab.tab_id, label: tab.label, root, ...closed });
		}
	}
	return removed;
}
