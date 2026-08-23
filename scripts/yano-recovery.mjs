#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import mqtt from "mqtt";
import { parse as parseYaml } from "yaml";
import { appendTraceRecord, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { projectConfig, projectDbPath, resolveYanoWorkspaceDir, slugifyProject } from "./yano-project.mjs";

const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const TERMINATE_WAIT_MS = 900;
const require = createRequire(import.meta.url);

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}

function has(argv, flag) { return argv.includes(flag); }

function usage() {
	console.log([
		"Uso: yano pause|resume|recovery <status|list> [opzioni]",
		"",
		"  yano pause --run <id> [--yes]       snapshot + stop graceful degli agenti",
		"  yano pause --all --yes              snapshot + stop di tutti i run attivi",
		"  yano resume --run <id> [--yes]     ripristina un run e riapre agenti mancanti",
		"  yano resume --all --yes             ripristina il team del progetto corrente",
		"  yano resume --dry-run               mostra cosa verrebbe ripristinato",
		"  yano recovery status|list           mostra snapshot e stato di ripristino",
		"",
		"Opzioni comuni: --project <nome>, --broker <mqtt://...>",
		"Sicurezza: senza --yes non vengono inviati terminate né avviati processi.",
	].join("\n"));
}

function requireSqlite() {
	try { return process.getBuiltinModule?.("node:sqlite") || require("node:sqlite"); } catch (error) {
		throw new Error(`node:sqlite non disponibile (${error instanceof Error ? error.message : String(error)})`);
	}
}

function getDb(dbPath, readOnly = false) {
	const { DatabaseSync } = requireSqlite();
	return readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
}

function projectScope(cwd, argv) {
	const explicit = value(argv, "--project");
	if (explicit?.trim()) return explicit.trim();
	return projectConfig(cwd).config?.project || resolveTraceProject(cwd);
}

function dbColumns(db, table) {
	try { return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name); } catch { return []; }
}

function selectRuns(db, runId, all) {
	if (runId) {
		const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
		return row ? [row] : [];
	}
	if (!all) return [];
	return db.prepare("SELECT * FROM runs WHERE status = 'active' ORDER BY created_at ASC").all();
}

function safeJson(value) {
	try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

function roleFromInstance(instance) {
	const id = String(instance || "").toLowerCase();
	if (id.startsWith("planner")) return "planner";
	if (id.startsWith("reviewer")) return "reviewer";
	if (id.startsWith("coder")) return "coder";
	if (id.startsWith("tdd")) return "tdd-agent";
	if (id.startsWith("docs")) return "docs-sync";
	if (id.startsWith("schema")) return "schema-migrator";
	if (id.startsWith("e2e")) return "e2e-simulator";
	return "specialist";
}

function readRoster(cwd) {
	const candidates = [
		path.join(cwd, "agents", "agents.yaml"),
		path.join(cwd, ".pi", "agents", "agents.yaml"),
	];
	for (const file of candidates) {
		try {
			const parsed = parseYaml(fs.readFileSync(file, "utf8"));
			return parsed?.agents && typeof parsed.agents === "object" ? parsed.agents : {};
		} catch { /* try next layout */ }
	}
	return {};
}

function collectAssignments(db, runIds) {
	const columns = dbColumns(db, "tickets");
	if (!columns.length) return [];
	const assignedRole = columns.includes("assigned_role") ? "assigned_role" : "NULL AS assigned_role";
	const result = [];
	for (const runId of runIds) {
		const rows = db.prepare(`SELECT id, status, assigned_instance, ${assignedRole}, title, description FROM tickets WHERE run_id = ? AND status IN ('running','pending') ORDER BY created_at ASC`).all(runId);
		for (const row of rows) if (row.assigned_instance) result.push({
			instance: row.assigned_instance,
			role: row.assigned_role || roleFromInstance(row.assigned_instance),
			ticket_id: row.id,
			ticket_status: row.status,
			title: row.title,
			description: row.description,
			worktree_path: String(row.description || "").match(/worktree_path=([^\s]+)/)?.[1] || null,
			run_id: runId,
		});
	}
	return result;
}

async function discoverPresence(project, broker = BROKER_URL) {
	const client = await mqtt.connectAsync(broker, { reconnectPeriod: 0, connectTimeout: 1800 });
	const cards = new Map();
	const topic = `pi/${project}/agents/+/status`;
	await client.subscribeAsync(topic, { qos: 1 });
	const onMessage = (receivedTopic, payload) => {
		try {
			const card = JSON.parse(payload.toString());
			if (card?.project === project && receivedTopic === `pi/${project}/agents/${card.instance}/status`) cards.set(card.instance, card);
		} catch { /* malformed retained presence is ignored */ }
	};
	client.on("message", onMessage);
	await new Promise((resolve) => setTimeout(resolve, 250));
	client.removeListener("message", onMessage);
	return { client, cards: [...cards.values()] };
}

function snapshotDir(project, runId) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(traceRoot(), "recovery", slugifyProject(project), runId, stamp);
}

function copyIfExists(source, target) {
	if (!fs.existsSync(source)) return false;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target);
	return true;
}

function gitSnapshot(cwd) {
	const run = (args) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		return result.status === 0 ? result.stdout.trim() : null;
	};
	return {
		cwd,
		branch: run(["branch", "--show-current"]),
		head: run(["rev-parse", "HEAD"]),
		status: run(["status", "--short"]),
		worktrees: run(["worktree", "list", "--porcelain"]),
	};
}

function snapshotInputs({ cwd, workspaceDir, dbPath, project, run, assignments, presence, traceRecords }) {
	const directory = snapshotDir(project, run.id);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const files = {
		database: copyIfExists(dbPath, path.join(directory, "orchestrator.db")),
		wal: copyIfExists(`${dbPath}-wal`, path.join(directory, "orchestrator.db-wal")),
		shm: copyIfExists(`${dbPath}-shm`, path.join(directory, "orchestrator.db-shm")),
		project_config: copyIfExists(path.join(workspaceDir, "config", "project.json"), path.join(directory, "project.json")),
	};
	const manifest = {
		schema_version: 1,
		created_at: new Date().toISOString(),
		project,
		project_cwd: cwd,
		workspace_dir: workspaceDir,
		run: safeJson(run),
		assignments: safeJson(assignments),
		presence: safeJson(presence),
		git: gitSnapshot(cwd),
		trace_records: traceRecords,
		files,
		resume_contract: "Restore only missing instances, keep SQLite run/ticket state and worktrees intact, then wake the planner.",
	};
	fs.writeFileSync(path.join(directory, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	return { directory, manifest };
}

function ensureRecoveryTable(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS yano_recovery_pauses (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL,
		project TEXT NOT NULL,
		snapshot_dir TEXT NOT NULL,
		created_at TEXT NOT NULL,
		resumed_at TEXT,
		status TEXT NOT NULL DEFAULT 'paused',
		metadata_json TEXT NOT NULL
	)`);
}

async function pauseRun({ cwd, project, dbPath, workspaceDir, run, broker, yes }) {
	const db = getDb(dbPath);
	ensureRecoveryTable(db);
	const assignments = collectAssignments(db, [run.id]);
	let presence = [];
	let client = null;
	try {
		({ client, cards: presence } = await discoverPresence(project, broker));
	} catch (error) {
		console.warn(`yano pause: broker non raggiungibile (${error instanceof Error ? error.message : String(error)}); snapshot locale comunque salvato.`);
	}
	const traceRecords = readTraceRecords({ cwd, project, limit: 100000 });
	const { directory, manifest } = snapshotInputs({ cwd, workspaceDir, dbPath, project, run, assignments, presence, traceRecords });
	const pauseId = `${run.id}-${Date.now()}`;
	const metadata = { directory, assignments, presence, requested_stop: yes };
	db.prepare("INSERT OR REPLACE INTO yano_recovery_pauses (id, run_id, project, snapshot_dir, created_at, status, metadata_json) VALUES (?, ?, ?, ?, ?, 'paused', ?)").run(pauseId, run.id, project, directory, new Date().toISOString(), JSON.stringify(metadata));
	const pausePayload = { pause_id: pauseId, snapshot_dir: directory, agent_count: presence.length };
	if (dbColumns(db, "events").includes("run_id")) {
		db.prepare("INSERT INTO events (run_id, ticket_id, type, payload, created_at) VALUES (?, NULL, 'run_paused', ?, ?)").run(run.id, JSON.stringify(pausePayload), new Date().toISOString());
	}
	if (dbColumns(db, "checkpoints").includes("run_id")) {
		db.prepare("INSERT INTO checkpoints (run_id, label, payload, created_at) VALUES (?, 'yano_pause', ?, ?)").run(run.id, JSON.stringify(pausePayload), new Date().toISOString());
	}
	if (client && yes) {
		for (const card of presence.filter((item) => item.status !== "offline")) {
			await client.publishAsync(`pi/${project}/agents/${card.instance}/commands`, JSON.stringify({
				type: "terminate",
				requested_by_instance: "yano-cli",
				requested_by_role: "operator",
				reason: `yano pause: snapshot non distruttivo ${directory}`,
				timestamp: new Date().toISOString(),
			}), { qos: 1 });
		}
	}
	if (client) await client.endAsync();
	db.close();
	console.log(`yano pause: run ${run.id} salvato in ${directory}`);
	console.log(`   agent osservati: ${presence.filter((item) => item.status !== "offline").map((item) => item.instance).join(", ") || "nessuno"}`);
	console.log(`   ${yes ? "terminate graceful inviati" : "nessun processo fermato: aggiungi --yes"}; stato SQLite preservato.`);
	return { pauseId, directory, manifest };
}

function latestSnapshots(project, runId) {
	const base = path.join(traceRoot(), "recovery", slugifyProject(project), runId || "");
	if (!fs.existsSync(base)) return [];
	return fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name)).filter((dir) => fs.existsSync(path.join(dir, "snapshot.json"))).sort().reverse();
}

function readSnapshot(project, runId) {
	const dir = latestSnapshots(project, runId)[0];
	if (!dir) return null;
	try { return { directory: dir, data: JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8")) }; } catch { return null; }
}

function requiredAgents({ cwd, db, runIds, snapshots }) {
	const roster = readRoster(cwd);
	const result = new Map();
	result.set("planner-01", { instance: "planner-01", role: "planner", source: "recovery-default" });
	for (const snapshot of snapshots) for (const card of (snapshot?.data?.presence || []).filter((item) => item.status !== "offline")) {
		if (card.instance && card.role) result.set(card.instance, { instance: card.instance, role: card.role, source: "pause-presence" });
	}
	for (const assignment of collectAssignments(db, runIds)) {
		result.set(assignment.instance, { ...assignment, source: "running-ticket" });
	}
	for (const [instance, config] of Object.entries(roster)) {
		if (instance === "planner-01" || result.has(instance)) result.set(instance, { instance, role: config.role || roleFromInstance(instance), source: result.get(instance)?.source || "roster" });
	}
	return [...result.values()];
}

function herdrJson(args) {
	const result = spawnSync("herdr", args, { encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		const resultBody = parsed?.result || parsed;
		return resultBody?.snapshot || resultBody;
	} catch { return null; }
}

function herdrLaunch({ cwd, project, instance, args }) {
	const snapshot = herdrJson(["api", "snapshot"]);
	const workspace = snapshot?.workspaces?.find((item) => item.label === project || snapshot.panes?.some((pane) => pane.workspace_id === item.workspace_id && path.resolve(pane.cwd || "") === path.resolve(cwd)));
	if (!workspace) return { instance, launched: false, error: `workspace Herdr "${project}" non trovato` };
	let current = snapshot.tabs?.find((tab) => tab.workspace_id === workspace.workspace_id && tab.label === instance);
	let pane = current && snapshot.panes?.find((item) => item.tab_id === current.tab_id);
	if (!pane) {
		const created = herdrJson(["tab", "create", "--workspace", workspace.workspace_id, "--cwd", cwd, "--label", instance, "--no-focus"]);
		if (!created) return { instance, launched: false, error: "Herdr non ha creato la tab" };
		const refreshed = herdrJson(["api", "snapshot"]);
		current = refreshed?.tabs?.find((tab) => tab.workspace_id === workspace.workspace_id && tab.label === instance);
		pane = current && refreshed?.panes?.find((item) => item.tab_id === current.tab_id);
	}
	if (!pane) return { instance, launched: false, error: "tab Herdr creata ma pane non trovato" };
	const result = spawnSync("herdr", ["pane", "run", pane.pane_id, "yano", ...args], { encoding: "utf8" });
	if (result.status !== 0) return { instance, launched: false, pane: pane.pane_id, error: result.stderr?.trim() || "Herdr non ha avviato il comando" };
	return { instance, launched: true, pane: pane.pane_id, supervisor: "herdr" };
}

function launchAgent({ cwd, project, instance, role, configDir, continuePlanner, prompt, background }) {
	const args = ["start", "--instance", instance, "--role", role, "--project", project];
	if (configDir) args.push("--config-dir", configDir);
	if (continuePlanner) args.push("--continue");
	if (prompt) args.push(prompt);
	if (!background) return { instance, role, launched: false, command: `yano ${args.map((arg) => JSON.stringify(arg)).join(" ")}` };
	return { role, ...herdrLaunch({ cwd, project, instance, args }) };
}

async function resumeRuns({ cwd, project, dbPath, runs, argv }) {
	const dryRun = has(argv, "--dry-run");
	const yes = has(argv, "--yes");
	const background = has(argv, "--background") || has(argv, "--yes");
	const db = getDb(dbPath);
	ensureRecoveryTable(db);
	const snapshots = runs.map((run) => readSnapshot(project, run.id)).filter(Boolean);
	const agents = requiredAgents({ cwd, db, runIds: runs.map((run) => run.id), snapshots });
	const live = new Set();
	let presenceClient = null;
	try {
		const discovered = await discoverPresence(project, value(argv, "--broker") || BROKER_URL);
		presenceClient = discovered.client;
		for (const card of discovered.cards) live.add(card.instance);
	} catch { /* offline broker: launch plan is still useful */ }
	const rosterConfig = path.join(cwd, ".pi", "agents");
	const configDir = fs.existsSync(path.join(rosterConfig, "roles.yaml")) ? rosterConfig : (fs.existsSync(path.join(cwd, "agents", "roles.yaml")) ? path.join(cwd, "agents") : null);
	const launched = [];
	for (const agent of agents) {
		if (live.has(agent.instance)) continue;
		const isPlanner = agent.role === "planner";
		const prompt = isPlanner ? `Ripristina il lavoro Yano del progetto ${project}. I run ${runs.map((run) => run.id).join(", ")} sono stati salvati e non chiusi: verifica SQLite, ticket running/pending, worktree e agenti; riprendi da dove eri rimasto e non ricreare ticket già esistenti.` : null;
		// The Yano extension deliberately requires every instance to start from
		// the project root so all agents share the same SQLite/presence state.
		// The assigned worktree remains in the ticket description and is selected
		// by the planner/coder after startup; launching Pi inside it would create
		// an isolated nested orchestrator and is rejected by the extension.
		launched.push(launchAgent({ cwd, project, instance: agent.instance, role: agent.role, configDir, continuePlanner: isPlanner && snapshots.length > 0, prompt, background: !dryRun && yes && background }));
	}
	if (presenceClient) await presenceClient.endAsync();
	if (!dryRun && yes) {
		for (const run of runs) db.prepare("UPDATE yano_recovery_pauses SET resumed_at = ?, status = 'resumed' WHERE run_id = ? AND status = 'paused'").run(new Date().toISOString(), run.id);
		for (const run of runs) if (dbColumns(db, "events").includes("run_id")) db.prepare("INSERT INTO events (run_id, ticket_id, type, payload, created_at) VALUES (?, NULL, 'run_resumed', ?, ?)").run(run.id, JSON.stringify({ agents: launched }), new Date().toISOString());
	}
	db.close();
	console.log(`yano resume: ${runs.length} run, ${launched.length} agenti da ripristinare.`);
	for (const item of launched) {
		const detail = item.session
			? item.session
			: item.pane
				? `${item.supervisor || "supervisor"} pane ${item.pane}`
				: item.error || item.command || "nessun supervisore";
		console.log(`   ${item.launched ? "✓" : "→"} ${item.instance} (${item.role}) — ${detail}`);
	}
	if (!yes) console.log("   modalità dry-run operativa: aggiungi --yes per salvare lo stato e avviare il team in Herdr.");
	return { runs, launched, snapshots };
}

async function recoveryStatus({ cwd, project, argv }) {
	const dbPath = projectDbPath(cwd, project);
	if (!fs.existsSync(dbPath)) { console.log(`yano recovery: database non trovato (${dbPath})`); return; }
	const db = getDb(dbPath, true);
	const rows = dbColumns(db, "yano_recovery_pauses").length ? db.prepare("SELECT * FROM yano_recovery_pauses ORDER BY created_at DESC").all() : [];
	db.close();
	console.log(`yano recovery: progetto ${project}`);
	for (const row of rows) console.log(`- ${row.run_id} [${row.status}] ${row.created_at} → ${row.snapshot_dir}`);
	if (!rows.length) console.log("- nessun checkpoint presente");
}

export async function runRecovery({ cwd, argv }) {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { usage(); return; }
	const project = projectScope(cwd, argv);
	if (sub === "recovery" || sub === "status" || sub === "list") {
		await recoveryStatus({ cwd, project, argv });
		return;
	}
	const dbPath = projectDbPath(cwd, project);
	if (!fs.existsSync(dbPath)) throw new Error(`database Yano non trovato: ${dbPath}`);
	const workspaceDir = resolveYanoWorkspaceDir(cwd, project);
	const db = getDb(dbPath, true);
	const runs = selectRuns(db, value(argv, "--run"), has(argv, "--all"));
	db.close();
	if (!runs.length) throw new Error("specifica --run <id> oppure --all; nessun run attivo trovato");
	if (!has(argv, "--yes") && !has(argv, "--dry-run")) console.log("Anteprima: usa --yes per eseguire l'operazione, senza --yes non vengono fermati o avviati agenti.");
	if (sub === "pause") {
		for (const run of runs) await pauseRun({ cwd, project, dbPath, workspaceDir, run, broker: value(argv, "--broker") || BROKER_URL, yes: has(argv, "--yes") });
		return;
	}
	if (sub === "resume") {
		await resumeRuns({ cwd, project, dbPath, runs, argv });
		return;
	}
	usage();
}

if (import.meta.url === `file://${process.argv[1]}`) runRecovery({ cwd: process.cwd(), argv: process.argv.slice(2) }).catch((error) => { console.error(`yano recovery: ${error.message}`); process.exit(1); });
