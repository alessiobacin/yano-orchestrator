#!/usr/bin/env node

// Fase 9 — daily 06:00 Europe/Rome cross-project digest. Pure, read-only
// aggregation over state that already exists (watcher registry, per-project
// run/decision-hold SQLite, Fase 5's Herdr-reachability streak, Fase 8's
// per-project log-size alert state) — no new source of truth is created
// here. Delivery always uses the GLOBAL notification channel (Decision 2):
// a digest is cross-project by nature, so there is no single project config
// to prioritize.

import {
	herdrReachabilityPath,
	listWatcherProjectRows,
	projectOpenHolds,
	projectRuns,
	readProjectLogSizeState,
	runNeedsPlanner,
} from "./yano-watcher-registry.mjs";
import { sendGlobalNotification } from "./yano-notify.mjs";
import fs from "node:fs";

const RECENT_RECOVERY_WINDOW_MS = 24 * 60 * 60_000;

function readJsonSafe(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function buildDigest({ now = new Date(), rows = null } = {}) {
	const projectRows = rows || listWatcherProjectRows();
	const projects = [];
	const openHolds = [];
	const recoveringAgents = [];
	for (const row of projectRows) {
		const state = projectRuns(row.root);
		const incompleteRuns = state.available ? state.runs.filter(runNeedsPlanner) : [];
		if (incompleteRuns.length) {
			projects.push({
				project: row.name,
				root: row.root,
				incomplete_runs: incompleteRuns.map((run) => ({ id: run.id, objective: run.objective, pending_tickets: run.pending_ticket_count, running_tickets: run.running_ticket_count })),
			});
		}
		for (const hold of projectOpenHolds(row.root)) {
			openHolds.push({ project: row.name, root: row.root, hold_id: hold.id, run_id: hold.run_id, question: hold.question, created_at: hold.created_at });
		}
		if (row.last_recovery_at && now.getTime() - Date.parse(row.last_recovery_at) <= RECENT_RECOVERY_WINDOW_MS) {
			recoveringAgents.push({ project: row.name, root: row.root, last_recovery_at: row.last_recovery_at, last_recovery_reason: row.last_recovery_reason || null });
		}
	}
	const logSizeState = readProjectLogSizeState();
	const logAlerts = Object.values(logSizeState).filter((entry) => entry.over_threshold);
	const reachability = readJsonSafe(herdrReachabilityPath());
	const herdrUnreachable = Boolean(reachability?.unreachable_streak > 0);
	return {
		generated_at: now.toISOString(),
		projects_with_incomplete_work: projects,
		open_decision_holds: openHolds,
		recently_recovered_agents: recoveringAgents,
		project_log_size_alerts: logAlerts,
		herdr: herdrUnreachable ? { unreachable_streak: reachability.unreachable_streak, unreachable_since: reachability.unreachable_since } : null,
	};
}

export function formatDigestText(digest) {
	const lines = [`📋 Digest giornaliero Yano — ${digest.generated_at}`];
	if (!digest.projects_with_incomplete_work.length && !digest.open_decision_holds.length && !digest.recently_recovered_agents.length && !digest.project_log_size_alerts.length && !digest.herdr) {
		lines.push("", "Tutto tranquillo: nessun task pendente, nessuna domanda in attesa, nessun allarme.");
		return lines.join("\n");
	}
	if (digest.open_decision_holds.length) {
		lines.push("", `❓ Domande in attesa di risposta (${digest.open_decision_holds.length}):`);
		for (const hold of digest.open_decision_holds) lines.push(`  - [${hold.project}] ${hold.question}`);
	}
	if (digest.projects_with_incomplete_work.length) {
		lines.push("", `🔄 Progetti con task non completati (${digest.projects_with_incomplete_work.length}):`);
		for (const project of digest.projects_with_incomplete_work) {
			for (const run of project.incomplete_runs) lines.push(`  - [${project.project}] ${run.objective || run.id} — ${run.pending_tickets} pending, ${run.running_tickets} in corso`);
		}
	}
	if (digest.recently_recovered_agents.length) {
		lines.push("", `♻️ Agenti recuperati nelle ultime 24h (${digest.recently_recovered_agents.length}):`);
		for (const agent of digest.recently_recovered_agents) lines.push(`  - [${agent.project}] motivo: ${agent.last_recovery_reason || "sconosciuto"}`);
	}
	if (digest.project_log_size_alerts.length) {
		lines.push("", `💾 Progetti oltre la soglia di log (${digest.project_log_size_alerts.length}):`);
		for (const alert of digest.project_log_size_alerts) lines.push(`  - [${alert.project}] ${(alert.bytes / (1024 * 1024 * 1024)).toFixed(2)}GB — vuoi spostare i log più vecchi nell'archivio configurato?`);
	}
	if (digest.herdr) lines.push("", `⚠️ Herdr non raggiungibile da ${digest.herdr.unreachable_streak} controlli consecutivi (dal ${digest.herdr.unreachable_since}).`);
	return lines.join("\n");
}

export async function runDigest({ now = new Date(), env = process.env, rows = null, send = sendGlobalNotification } = {}) {
	const digest = buildDigest({ now, rows });
	const text = formatDigestText(digest);
	const result = await send(text, { env, sender: "yano-digest" });
	return { digest, text, sent: result };
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (invokedDirectly) {
	const json = process.argv.includes("--json");
	const noSend = process.argv.includes("--dry-run");
	if (noSend) {
		console.log(JSON.stringify(buildDigest(), null, json ? 2 : 0));
	} else {
		runDigest().then((result) => console.log(JSON.stringify(result, null, json ? 2 : 0)));
	}
}
