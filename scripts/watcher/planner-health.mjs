// Fase 3 / M3 — planner health and workspace matching, extracted verbatim
// from scripts/yano-watcher-registry.mjs. Pure reads of a Herdr `snapshot`
// plus direct `spawnSync("herdr", ...)` calls; no watcher-registry DB
// access. (ensureRegisteredPlanner/recoverPlanner stay in
// yano-watcher-registry.mjs — they close tabs (M1) and write to the
// registry DB, a different risk class deferred to a future phase.)
import path from "node:path";
import { canonicalAgentRoot } from "../yano-agent-identity.mjs";
import { spawnSync } from "node:child_process";
import { readApplicationHeartbeat } from "../yano-trace-storage.mjs";

// A planner is identified by ROLE, never by its exact tab/agent name. Since
// Revisione 66 Herdr registers every agent under a globally unique name
// (`planner-<project>-<hash>` from herdrAgentName), while Pi's `--instance`
// stays `planner-01`. Matching by the exact legacy name made the supervisor
// miss the live uniquely-named planner and launch a duplicate `planner-01`.
export const PLANNER_IDENTITY_PATTERN = /^planner(?:[-_].*)?$/i;
export function isPlannerIdentity(value) {
	return PLANNER_IDENTITY_PATTERN.test(String(value || "").trim());
}
export function agentIsPlanner(agent) {
	if (!agent) return false;
	if (/^planner$/i.test(String(agent.role || agent.agent_role || "").trim())) return true;
	if (isPlannerIdentity(agent.name) || isPlannerIdentity(agent.instance)) return true;
	return /planner/i.test(`${agent.terminal_title_stripped || ""} ${agent.terminal_title || ""}`);
}

export function findProjectWorkspace(snapshot, root, project) {
	// Workspace labels are user-facing and are not a stable identity: Herdr
	// preserves casing while Yano may derive a normalized project name. The
	// canonical identity is the project root. Prefer a case-insensitive label
	// match, then rank candidates by evidence that they actually belong to the
	// root and contain a live planner. This prevents a stale recovery workspace
	// from winning over the original project workspace (for example `llmproxy`
	// versus `llmProxy`).
	const expectedRoot = canonicalAgentRoot(root || ".");
	const expectedLabel = String(project || "").trim().toLocaleLowerCase();
	const candidates = (snapshot?.workspaces || []).filter((workspace) => {
		const panes = (snapshot?.panes || []).filter((pane) => pane.workspace_id === workspace.workspace_id);
		const rooted = panes.some((pane) => pane.cwd && canonicalAgentRoot(pane.cwd) === expectedRoot);
		return String(workspace.label || "").trim().toLocaleLowerCase() === expectedLabel && (rooted || !panes.some((pane) => pane.cwd));
	});
	if (!candidates.length) return null;
	const score = (workspace) => {
		const panes = (snapshot?.panes || []).filter((pane) => pane.workspace_id === workspace.workspace_id);
		const hasRootPane = panes.some((pane) => canonicalAgentRoot(pane.cwd || ".") === expectedRoot);
		const planners = (snapshot?.agents || []).filter((agent) =>
			agent.workspace_id === workspace.workspace_id &&
			canonicalAgentRoot(agent.cwd || ".") === expectedRoot &&
			(plannerLabelForAgent(snapshot, agent) || agentIsPlanner(agent)),
		);
		const livePlanner = planners.some((planner) => ["idle", "working"].includes(String(planner.agent_status || "").toLowerCase()));
		const exactLabel = workspace.label === project;
		return (livePlanner ? 1000 : 0) + (hasRootPane ? 100 : 0) + (exactLabel ? 10 : 0);
	};
	return candidates
		.map((workspace, index) => ({ workspace, index, score: score(workspace) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)[0].workspace;
}

export function plannerAgentsInWorkspace(snapshot, workspaceId, root) {
	return (snapshot?.agents || []).filter((agent) =>
		agent.workspace_id === workspaceId &&
		path.resolve(agent.cwd || "") === path.resolve(root) &&
		(plannerLabelForAgent(snapshot, agent) || agentIsPlanner(agent)),
	);
}

// Herdr can expose a live Pi pane without copying Pi's instance name into
// `agent.name` (notably after a restart). The tab label is the durable Yano
// identity in that case; ignoring it made every healthy planner look missing
// and caused a new recovery tab to be created on every supervisor pass.
export function plannerLabelForAgent(snapshot, agent) {
	const tab = snapshot?.tabs?.find((item) => item.tab_id === agent.tab_id);
	// The tab may carry either the legacy `planner-01` label or Herdr's
	// unique agent name (`planner-<project>-<hash>`); the agent row itself
	// may carry the Pi role. Any of them proves planner identity.
	return Boolean((tab && isPlannerIdentity(tab.label)) || agentIsPlanner(agent));
}

// Fase 2 (heartbeat unification): every agent process (this planner included)
// already writes a bounded application-heartbeat file on each presence
// publish (see orchestrator.ts's publishPresence()) — the same file
// yano-global-services.mjs consults for the 3 global services. Neither the
// MQTT-retained `last_heartbeat` nor Herdr's own process/explain heuristics
// below can tell "process alive, event loop wedged" apart from healthy; the
// file can, because it is only ever refreshed by application code actually
// running. Only enforced when the file exists, so a just-recovered planner
// mid-warm-up (no heartbeat published yet) is judged on the existing signals
// exactly as before.
export function plannerFileHeartbeatSaysDead(planner) {
	if (!planner?.cwd) return false;
	const instance = String(planner.name || "planner-01");
	const file = readApplicationHeartbeat(planner.cwd, instance, { maxAgeMs: 120_000 });
	return file.found && !file.healthy;
}

// Herdr's own `agent explain` is a deeper, authoritative liveness read than
// the shallow `agent_status` string: a Pi pane that just finished responding
// can sit in `agent_status: "done"` indefinitely (observed directly: 45+
// minutes with no auto-transition to "idle") while `explain` already reports
// `state: "idle", warning: null, visible_blocker: false` for that exact same
// pane — genuinely healthy, simply quiescent between tasks. Exported so
// escalation logic (ensureRegisteredPlanner) can use it as a final
// confirmation before ever closing/relaunching a planner that only *looks*
// unhealthy through the shallower checks below.
export function plannerLooksHealthyViaExplain(paneId) {
	if (!paneId) return false;
	const explained = spawnSync("herdr", ["agent", "explain", paneId, "--json"], { encoding: "utf8" });
	let explanation;
	try { explanation = JSON.parse(explained.stdout || ""); } catch { explanation = null; }
	return ["idle", "working"].includes(String(explanation?.state || "").toLowerCase()) && explanation?.warning == null && explanation?.visible_blocker !== true;
}

export function plannerHeartbeatHealthy(planner) {
	const status = String(planner?.agent_status || "unknown").toLowerCase();
	if (!["idle", "working"].includes(status)) return false;
	const heartbeat = Date.parse(planner?.last_heartbeat || "");
	if (Number.isFinite(heartbeat)) return Date.now() - heartbeat <= 120_000;
	// Older Herdr snapshots do not expose MQTT heartbeat fields. In that case
	// use the authoritative pane process plus Herdr's explanation API rather
	// than treating an otherwise live planner as dead every minute.
	if (!planner?.pane_id) return false;
	if (plannerFileHeartbeatSaysDead(planner)) return false;
	const processInfo = spawnSync("herdr", ["pane", "process-info", "--pane", planner.pane_id], { encoding: "utf8" });
	let process;
	try { process = JSON.parse(processInfo.stdout || "")?.result?.process_info?.foreground_processes?.[0]; } catch { process = null; }
	if (!process?.pid) return false;
	return plannerLooksHealthyViaExplain(planner.pane_id);
}

export function panePiProcessState(paneId) {
	if (!paneId) return false;
	const result = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], { encoding: "utf8" });
	if (result.error || result.status !== 0) return null;
	try {
		const processes = JSON.parse(result.stdout || "")?.result?.process_info?.foreground_processes || [];
		return processes.some((item) => item?.argv0 === "pi" || item?.argv?.some((arg) => /(?:^|\/)pi(?:\.m?js)?$/.test(String(arg))));
	} catch { return null; }
}

export function paneHasLivePiProcess(paneId) { return panePiProcessState(paneId) === true; }

export function livePlannerPanesInWorkspace(snapshot, workspaceId, root) {
	const expectedRoot = path.resolve(root || "");
	return (snapshot?.panes || []).filter((pane) => {
		if (pane.workspace_id !== workspaceId || path.resolve(pane.cwd || "") !== expectedRoot) return false;
		const tab = (snapshot.tabs || []).find((item) => item.tab_id === pane.tab_id);
		const agent = (snapshot.agents || []).find((item) => item.pane_id === pane.pane_id);
		return ((tab && isPlannerIdentity(tab.label)) || agentIsPlanner(agent)) && paneHasLivePiProcess(pane.pane_id);
	});
}
