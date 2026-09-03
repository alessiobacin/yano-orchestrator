// Shared liveness-aware routing for Yano service handoffs.
//
// The Pi extension uses the same policy internally for agent_send. These
// helpers cover the registry workers (feedback, feedback and auto-improver),
// whose CLI processes also publish MQTT commands and must not silently drop a
// notification when the intended worker or planner is absent.

import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectKey } from "./yano-trace-storage.mjs";

async function discoverLiveAgents(client, scope, expectedProjectKey = null) {
	if (!client) return [];
	const agents = new Map();
	const onMessage = (_topic, payload) => {
		try {
			const card = JSON.parse(payload.toString());
			if (card?.instance) agents.set(card.instance, card);
		} catch { /* malformed retained presence */ }
	};
	try {
		client.on("message", onMessage);
		await client.subscribeAsync(`pi/${scope}/agents/+/status`, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 250));
	} catch { /* caller still has durable registry state */ }
	try { client.removeListener("message", onMessage); } catch { /* best effort */ }
	const staleAfterMs = Number(process.env.PI_ORCH_STALE_AFTER_MS) || 45_000;
	const now = Date.now();
	return [...agents.values()].filter((agent) => {
		if (agent.status === "offline") return false;
		if (expectedProjectKey && agent.project_key && agent.project_key !== expectedProjectKey) return false;
		const heartbeat = Date.parse(agent.last_heartbeat || "");
		return Number.isFinite(heartbeat) && now - heartbeat <= staleAfterMs;
	});
}

function startWatcher({ projectRoot, project, packageRoot }) {
	if (process.env.PI_ORCH_TEST_NO_EXIT === "1" || process.env.YANO_AUTO_WATCHER === "0") {
		return { attempted: false, ok: false, detail: "bootstrap skipped by environment" };
	}
	try {
		const cli = path.join(packageRoot, "bin", "yano.mjs");
		const result = spawnSync(process.execPath, [cli, "watcher", "start", "--project-root", projectRoot, "--project", project], {
			cwd: projectRoot,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 2_000_000,
		});
		return {
			attempted: true,
			ok: result.status === 0,
			detail: String(result.stderr || result.stdout || "").trim().slice(-800),
		};
	} catch (error) {
		return { attempted: true, ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Route a service-generated command to a live target, live planner, or the
 * retained watcher fallback channel. The original envelope is preserved so
 * the watcher can replay it after recovering planner-01.
 */
export async function routeAgentMessage({ client, projectRoot, project, packageRoot, message, targetInstance = null, targetRole = null }) {
	if (!client) return { route: "unreachable", delivered: 0, planners: [], target: null };
	const project_key = projectKey(projectRoot, project);
	// Test harnesses intentionally use their historical human scope because
	// their fake peers do not expose project_key; production always uses the
	// root-derived namespace.
	const scope = process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : project_key;
	const live = await discoverLiveAgents(client, scope, project_key);
	const targets = live.filter((agent) => targetInstance ? agent.instance === targetInstance : agent.role === targetRole);
	if (targets.length) {
		let delivered = 0;
		for (const target of targets) {
			try {
				await client.publishAsync(`pi/${scope}/agents/${target.instance}/commands`, JSON.stringify({
					...message,
					project_key,
					project_root: path.resolve(projectRoot),
					target_instance: target.instance,
					target_role: target.role,
				}), { qos: 1 });
				delivered++;
			} catch { /* another route/next retry remains possible */ }
		}
		return { route: "target", delivered, planners: [], target: targets.map((agent) => agent.instance) };
	}

	const planners = live.filter((agent) => agent.role === "planner");
	if (planners.length) {
		let delivered = 0;
		for (const planner of planners) {
			try {
				await client.publishAsync(`pi/${scope}/agents/${planner.instance}/commands`, JSON.stringify({
					...message,
					project_key,
					project_root: path.resolve(projectRoot),
					target_instance: planner.instance,
					target_role: "planner",
					prompt: `[yano-routing] Destinatario originale offline: ${targetInstance || `role:${targetRole || "?"}`}. Prendi in carico questo messaggio, avvisa il mittente e decidi se rilanciare o sostituire l'agente.

${message.prompt || ""}`,
					fallback_for: targetInstance || targetRole || null,
					routed_by: "yano-routing",
				}), { qos: 1 });
				delivered++;
			} catch { /* retained watcher path below is the durable safety net */ }
		}
		return { route: "planner", delivered, planners: planners.map((agent) => agent.instance), target: null };
	}

	const watcherBootstrap = startWatcher({ projectRoot, project, packageRoot });
	try {
		await client.publishAsync(`pi/${scope}/system/agent-fallback`, JSON.stringify({
			type: "agent_route_fallback",
			fallback_id: crypto.randomUUID(),
			project,
			project_key,
			project_root: path.resolve(projectRoot),
			original_target: targetInstance || `role:${targetRole || "?"}`,
			original: message,
			timestamp: new Date().toISOString(),
		}), { qos: 1, retain: true });
		return { route: "watcher", delivered: 1, planners: [], target: null, watcher_bootstrap: watcherBootstrap };
	} catch (error) {
		return { route: "unreachable", delivered: 0, planners: [], target: null, watcher_bootstrap: watcherBootstrap, detail: error instanceof Error ? error.message : String(error) };
	}
}
