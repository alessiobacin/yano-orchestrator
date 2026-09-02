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
	if (conflict) throw new Error(`planner duplicati o non numerati nel progetto ${canonicalRoot}: ${conflict.names.join(", ")}; risolvi prima l'incongruenza`);
}

export function formatAgentIdentityConflicts(conflicts) {
	return conflicts.map((conflict) => conflict.type === "duplicate_instance"
		? `${conflict.root}: identità duplicata ${conflict.name} (${conflict.agents.map((agent) => agent.pane_id || agent.tab_id || "pane sconosciuto").join(", ")})`
		: `${conflict.root}: planner non conformi (${conflict.names.join(", ")}); attesi ${conflict.expected.join(", ")}`);
}
