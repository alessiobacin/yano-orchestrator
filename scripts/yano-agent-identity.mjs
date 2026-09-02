// Canonical live-agent identity checks shared by the launcher and watcher.
import fs from "node:fs";
import path from "node:path";

export function canonicalAgentRoot(root) {
	try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

function tabFor(snapshot, tabId) { return (snapshot?.tabs || []).find((tab) => tab.tab_id === tabId) || null; }
function agentName(snapshot, agent) {
	const tab = tabFor(snapshot, agent.tab_id);
	return String(agent.name || tab?.label || agent.terminal_title_stripped || agent.terminal_title || "").trim();
}
function live(agent) { return !["stopped", "done", "dead", "exited", "offline"].includes(String(agent.agent_status || agent.status || "").toLowerCase()); }

// Herdr keeps the visible tab label separately from Pi's registered identity.
// After a restart/recovery these can diverge; the label is not allowed to be
// treated as a second agent identity. Callers can use this audit to repair the
// presentation before launching anything.
export function agentTabIdentityAudit(snapshot) {
	const agentsByPane = new Map((snapshot?.agents || []).map((agent) => [agent.pane_id, agent]));
	const tabsByWorkspace = new Map();
	for (const tab of snapshot?.tabs || []) {
		const pane = (snapshot?.panes || []).find((item) => item.tab_id === tab.tab_id);
		const agent = pane && agentsByPane.get(pane.pane_id);
		if (!agent || !live(agent)) continue;
		// A generic Pi terminal title ("π - project") is not an identity. Only
		// Herdr/Yano's explicit name can be used to repair or reject a tab.
		const actual = String(agent.name || agent.instance || "").trim();
		if (!actual) continue;
		const group = tabsByWorkspace.get(tab.workspace_id) || [];
		group.push({ tab_id: tab.tab_id, pane_id: pane.pane_id, label: tab.label || "", actual, root: canonicalAgentRoot(agent.cwd || pane.cwd || ".") });
		tabsByWorkspace.set(tab.workspace_id, group);
	}
	const conflicts = [];
	for (const tabs of tabsByWorkspace.values()) {
		const labels = new Map();
		for (const item of tabs) {
			if (item.label && item.label !== item.actual) conflicts.push({ type: "tab_identity_mismatch", ...item });
			const same = labels.get(item.label) || [];
			if (item.label) same.push(item);
			labels.set(item.label, same);
		}
		for (const [label, same] of labels) if (same.length > 1) conflicts.push({ type: "duplicate_tab_label", label, tabs: same });
	}
	return conflicts;
}

export function liveAgentIdentities(snapshot) {
	return (snapshot?.agents || []).filter(live).map((agent) => ({
		name: agentName(snapshot, agent),
		root: canonicalAgentRoot(agent.cwd || agent.foreground_cwd || "."),
		workspace_id: agent.workspace_id || null,
		tab_id: agent.tab_id || null,
		pane_id: agent.pane_id || null,
		status: agent.agent_status || agent.status || "unknown",
	})).filter((agent) => agent.name);
}

export function findAgentIdentityConflicts(snapshot) {
	const identities = liveAgentIdentities(snapshot);
	const groups = new Map();
	for (const agent of identities) {
		const key = `${agent.root}\0${agent.name}`;
		const list = groups.get(key) || [];
		list.push(agent);
		groups.set(key, list);
	}
	const conflicts = [];
	for (const [key, agents] of groups) {
		if (agents.length > 1) {
			const [root, name] = key.split("\0");
			conflicts.push({ type: "duplicate_instance", root, name, agents });
		}
	}
	const planners = new Map();
	for (const agent of identities) if (/^planner(?:-|$)/i.test(agent.name)) {
		const list = planners.get(agent.root) || [];
		list.push(agent);
		planners.set(agent.root, list);
	}
	for (const [root, list] of planners) {
		if (list.length < 2) continue;
		const names = list.map((agent) => agent.name);
		const expected = list.map((_, index) => `planner-${String(index + 1).padStart(2, "0")}`);
		if (!names.every((name) => /^planner-\d{2}$/.test(name)) || expected.some((name) => !names.includes(name))) conflicts.push({ type: "planner_naming", root, names, expected });
	}
	return conflicts;
}

export function assertAgentIdentityAvailable({ snapshot, root, instance, role }) {
	const canonicalRoot = canonicalAgentRoot(root);
	const duplicate = liveAgentIdentities(snapshot).find((agent) => agent.root === canonicalRoot && agent.name === instance);
	if (duplicate) throw new Error(`identità già in uso nel progetto: ${instance} (${canonicalRoot}); avvio rifiutato per evitare due agenti con lo stesso nome`);
	if (role === "planner" && !/^planner-\d{2}$/.test(instance)) throw new Error(`planner con nome non valido "${instance}"; usa planner-01, planner-02, ...`);
	const conflict = findAgentIdentityConflicts(snapshot).find((item) => item.root === canonicalRoot && item.type === "planner_naming");
	if (conflict) throw new Error(`planner duplicati o non numerati nel progetto ${canonicalRoot}: ${conflict.names.join(", ")}; risolvi prima l’incongruenza`);
	const tabConflict = agentTabIdentityAudit(snapshot).find((item) => item.root === canonicalRoot && item.actual === instance);
	if (tabConflict && tabConflict.tab_id !== duplicate?.tab_id) throw new Error(`identità già rappresentata da una tab Herdr nel progetto: ${instance} (${tabConflict.tab_id}); avvio rifiutato`);
}

export function formatAgentIdentityConflicts(conflicts) {
	return conflicts.map((conflict) => conflict.type === "duplicate_instance"
		? `${conflict.root}: identità duplicata ${conflict.name} (${conflict.agents.map((agent) => agent.pane_id || agent.tab_id || "pane sconosciuto").join(", ")})`
		: conflict.type === "tab_identity_mismatch"
			? `${conflict.root}: tab ${conflict.tab_id} etichettata ${conflict.label || "(vuota)"} ma agente reale ${conflict.actual}`
			: conflict.type === "duplicate_tab_label"
				? `workspace: etichetta tab duplicata ${conflict.label} (${conflict.tabs.map((item) => item.tab_id).join(", ")})`
				: `${conflict.root}: planner non conformi (${conflict.names.join(", ")}); attesi ${conflict.expected.join(", ")}`);
}
