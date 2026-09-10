// Fase 3 / M2 — reading a project's own run/ticket/decision-hold state,
// extracted verbatim from scripts/yano-watcher-registry.mjs. Reads the
// PROJECT's own SQLite DB (via openProjectDatabase(root)), never the
// watcher registry's own watcher_projects table — zero Herdr dependency.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { projectDbPath } from "../yano-project.mjs";

const require = createRequire(import.meta.url);

// Duplicated from yano-watcher-registry.mjs (which keeps its own copy too,
// still used there by the registry DB's own openDatabase()) — a tiny,
// stable one-liner, zero drift risk.
function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); }
	catch (error) { throw new Error(`yano watcher: node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)}); serve Node >=22.5`); }
}

function openProjectDatabase(root) {
	const file = projectDbPath(root);
	const legacy = path.join(root, ".yano", "orchestrator.db");
	const dbFile = fs.existsSync(file) ? file : legacy;
	if (!fs.existsSync(dbFile)) return null;
	try {
		const { DatabaseSync } = requireSqlite();
		return new DatabaseSync(dbFile, { readOnly: true });
	} catch { return null; }
}

export function projectRuns(root) {
	const db = openProjectDatabase(root);
	if (!db) return { available: false, runs: [] };
	try {
		const runs = db.prepare(`
			SELECT r.id, r.project, r.objective, r.status, r.finalization_status, r.updated_at,
			       MAX(COALESCE(e.created_at, r.updated_at)) AS last_activity_at,
			       COUNT(DISTINCT CASE WHEN h.status = 'open' THEN h.id END) AS open_holds
			FROM runs r
			LEFT JOIN events e ON e.run_id = r.id
			LEFT JOIN decision_holds h ON h.run_id = r.id
			GROUP BY r.id
			ORDER BY r.updated_at DESC
		`).all();
		// A pause is a durable operator/cron decision. The run intentionally
		// remains active so its checkpoint and ticket state are preserved, but
		// supervision must not interpret it as work requiring a planner. Without
		// this join, a recovery scan could wake the same planner that pause had
		// just stopped, creating an endless pause/recovery loop.
		const pausedRunIds = new Set();
		try {
			for (const pause of db.prepare("SELECT DISTINCT run_id FROM yano_recovery_pauses WHERE status = 'paused'").all()) pausedRunIds.add(pause.run_id);
		} catch { /* older databases are simply not pause-aware yet */ }
		// description/result_summary are also consumed by the dashboard's
		// evidence view to link a feedback card to the exact ticket.  This is a
		// read-only addition; older project DBs are covered by the outer fallback.
		let tickets;
		try {
			tickets = db.prepare("SELECT id, run_id, title, description, status, assigned_instance, required_playbook, result_summary, updated_at FROM tickets ORDER BY updated_at DESC").all();
		} catch {
			// Minimal/legacy fixture databases may not contain optional ticket
			// context columns; activity must remain available from their core fields.
			tickets = db.prepare("SELECT id, run_id, title, status, assigned_instance, required_playbook, updated_at FROM tickets ORDER BY updated_at DESC").all();
		}
		const dependencies = db.prepare("SELECT d.ticket_id, d.depends_on_id, dependency.status AS dependency_status FROM ticket_dependencies d JOIN tickets dependency ON dependency.id = d.depends_on_id").all();
		const dependenciesByTicket = new Map();
		for (const dependency of dependencies) {
			if (!dependenciesByTicket.has(dependency.ticket_id)) dependenciesByTicket.set(dependency.ticket_id, []);
			dependenciesByTicket.get(dependency.ticket_id).push(dependency);
		}
		const byRun = new Map();
		for (const ticket of tickets) {
			if (!byRun.has(ticket.run_id)) byRun.set(ticket.run_id, []);
			byRun.get(ticket.run_id).push(ticket);
		}
		const bindings = new Map(db.prepare("SELECT run_id, playbook_id, checksum, snapshot FROM playbook_bindings").all().map((binding) => {
			let snapshot = null; try { snapshot = JSON.parse(binding.snapshot); } catch {}
			return [binding.run_id, { ...binding, snapshot }];
		}));
		const runtimeStates = new Map(db.prepare("SELECT run_id, state_id, generation, updated_at FROM playbook_runtime_state").all().map((state) => [state.run_id, state]));
		return { available: true, runs: runs.map((run) => {
			run = { ...run, paused: pausedRunIds.has(run.id) };
			const runTickets = byRun.get(run.id) || [];
			const binding = bindings.get(run.id) || null;
			const flowViolations = [];
			for (const ticket of runTickets) {
				const deps = dependenciesByTicket.get(ticket.id) || [];
				if (["running", "done"].includes(ticket.status)) {
					const unfinished = deps.filter((dependency) => dependency.dependency_status !== "done");
					if (unfinished.length) flowViolations.push({ kind: "ticket_out_of_order", ticket_id: ticket.id, status: ticket.status, unfinished_dependencies: unfinished.map((item) => ({ ticket_id: item.depends_on_id, status: item.dependency_status })) });
				}
				if (binding?.playbook_id && ticket.required_playbook && ticket.required_playbook !== binding.playbook_id) flowViolations.push({ kind: "ticket_playbook_mismatch", ticket_id: ticket.id, required_playbook: ticket.required_playbook, bound_playbook: binding.playbook_id });
			}
			const runtime = runtimeStates.get(run.id) || null;
			const terminalStates = new Set((binding?.snapshot?.states || []).filter((state) => state.terminal === true).map((state) => state.id));
			if (run.status === "active" && runtime?.state_id && terminalStates.has(runtime.state_id) && runtime.state_id !== "blocked") flowViolations.push({ kind: "active_run_in_terminal_playbook_state", state_id: runtime.state_id });
			return {
				...run,
				tickets: runTickets,
				playbook_binding: binding ? { playbook_id: binding.playbook_id, checksum: binding.checksum } : null,
				playbook_state: runtime,
				playbook_flow: { status: flowViolations.length ? "violation" : "ordered", violations: flowViolations },
				active_ticket_count: runTickets.filter((ticket) => ["pending", "running"].includes(ticket.status)).length,
				running_ticket_count: runTickets.filter((ticket) => ticket.status === "running").length,
				pending_ticket_count: runTickets.filter((ticket) => ticket.status === "pending").length,
				ready_pending_tickets: runTickets.filter((ticket) => ticket.status === "pending" && (dependenciesByTicket.get(ticket.id) || []).every((dependency) => dependency.dependency_status === "done")).map((ticket) => ticket.id),
			};
		}) };
	} catch { return { available: false, runs: [] }; }
	finally { try { db.close(); } catch { /* best effort */ } }
}

function projectHasActiveWork(root) {
	return projectRuns(root).runs.some(runNeedsPlanner);
}

// Fase 9 (digest giornaliero) — the run-level open_holds COUNT already
// computed by projectRuns() is enough to decide "does this project need a
// planner", but the digest needs the actual question text so the user can
// act without opening the project. A separate, minimal read-only query
// avoids reshaping projectRuns()'s existing contract for every other caller.
export function projectOpenHolds(root) {
	const db = openProjectDatabase(root);
	if (!db) return [];
	try {
		return db.prepare("SELECT id, run_id, question, created_at FROM decision_holds WHERE status = 'open' ORDER BY created_at ASC").all();
	} catch { return []; }
	finally { try { db.close(); } catch { /* best effort */ } }
}

export function runNeedsPlanner(run) {
	// A completed run is terminal. `pending_finalize` is an administrative
	// state, not evidence of live work, so it must never trigger an LLM wake-up.
	return run.status === "active" && run.paused !== true;
}

export function projectNeedsPlanner(root) {
	const state = projectRuns(root);
	if (!state.available) return false;
	return state.runs.some((run) => !run.paused && (runNeedsPlanner(run) || Number(run.open_holds || 0) > 0));
}
