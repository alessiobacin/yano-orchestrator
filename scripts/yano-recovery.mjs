#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import mqtt from "mqtt";
import { parse as parseYaml } from "yaml";
import { appendRawTraceRecord, appendTraceRecord, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { projectConfig, projectDbPath, resolveYanoWorkspaceDir, slugifyProject } from "./yano-project.mjs";

const BROKER_URL = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const TERMINATE_WAIT_MS = 900;
const require = createRequire(import.meta.url);

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}

function has(argv, flag) { return argv.includes(flag); }

function commandExists(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
	return !result.error || result.error.code !== "ENOENT";
}

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

function traceReloadEvent({ cwd, project, stage, payload = {} }) {
	try {
		appendRawTraceRecord({ cwd, project, record: {
			type: `reload_${stage}`,
			instance: "yano-cli",
			role: "operator",
			...safeJson(payload),
		} });
	} catch { /* trace is best effort; recovery state remains authoritative */ }
}

function roleFromInstance(instance) {
	const id = String(instance || "").toLowerCase();
	if (id.startsWith("planner")) return "planner";
	if (id.startsWith("reviewer")) return "reviewer";
	if (id.startsWith("coder")) return "coder";
	if (id.startsWith("tdd")) return "tdd-agent";
	if (id.startsWith("docs")) return "docs-sync";
	if (id.startsWith("schema")) return "schema-migrator";
	if (id.startsWith("deployment")) return "deployment-agent";
	if (id.startsWith("e2e")) return "e2e-simulator";
	return "specialist";
}

function looksLikeAgentInstance(instance) {
	return /^(planner|coder|reviewer|frontend[-_]developer|frontend[-_]reviewer|docs|tdd|e2e|schema|security|specialist|qa|docker|k8s|cicd|data|openapi|architecture|release|dependency|refactoring|observability|deployment|a11y|design|speed)[-_]/i.test(String(instance || ""));
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

async function discoverPresence(project, broker = BROKER_URL, cwd = process.cwd()) {
	const client = await mqtt.connectAsync(broker, { reconnectPeriod: 0, connectTimeout: 1800 });
	const cards = new Map();
	const scope = process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : projectKey(cwd, project);
	const topic = `pi/${scope}/agents/+/status`;
	await client.subscribeAsync(topic, { qos: 1 });
	const onMessage = (receivedTopic, payload) => {
		try {
			const card = JSON.parse(payload.toString());
			if (card?.project === project && (!card.project_key || card.project_key === scope) && receivedTopic === `pi/${scope}/agents/${card.instance}/status`) cards.set(card.instance, card);
		} catch { /* malformed retained presence is ignored */ }
	};
	client.on("message", onMessage);
	// Retained messages are delivered asynchronously after SUBSCRIBE. 250 ms
	// was too short on a busy broker and made pause see only the first agent,
	// leaving the other Herdr panes alive. Match the fleet command's settling
	// window so the checkpoint and graceful-stop set are complete.
	await new Promise((resolve) => setTimeout(resolve, 650));
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

function snapshotInputs({ cwd, workspaceDir, dbPath, project, run, assignments, presence, traceRecords, herdrSnapshot = null, reload = null }) {
	const directory = snapshotDir(project, run.id);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const files = {
		database: copyIfExists(dbPath, path.join(directory, "orchestrator.db")),
		wal: copyIfExists(`${dbPath}-wal`, path.join(directory, "orchestrator.db-wal")),
		shm: copyIfExists(`${dbPath}-shm`, path.join(directory, "orchestrator.db-shm")),
		project_config: copyIfExists(path.join(workspaceDir, "config", "project.json"), path.join(directory, "project.json")),
	};
	const manifest = {
		schema_version: 2,
		created_at: new Date().toISOString(),
		project,
		project_cwd: cwd,
		workspace_dir: workspaceDir,
		run: safeJson(run),
		assignments: safeJson(assignments),
		presence: safeJson(presence),
		herdr: safeJson(herdrSnapshot),
		reload: safeJson(reload),
		git: gitSnapshot(cwd),
		trace_records: traceRecords,
		files,
		resume_contract: "Restore only missing instances, keep SQLite run/ticket state and worktrees intact, then wake the planner. A reload resumes semantically from the last observable checkpoint, never from hidden model tokens.",
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

async function pauseRun({ cwd, project, dbPath, workspaceDir, run, broker, yes, herdrSnapshot = null, reload = null, terminateAgents = true }) {
	const db = getDb(dbPath);
	ensureRecoveryTable(db);
	const assignments = collectAssignments(db, [run.id]);
	let presence = [];
	let client = null;
	try {
		({ client, cards: presence } = await discoverPresence(project, broker, cwd));
	} catch (error) {
		console.warn(`yano pause: broker non raggiungibile (${error instanceof Error ? error.message : String(error)}); snapshot locale comunque salvato.`);
	}
	const traceRecords = readTraceRecords({ cwd, project, limit: 100000 });
	const { directory, manifest } = snapshotInputs({ cwd, workspaceDir, dbPath, project, run, assignments, presence, traceRecords, herdrSnapshot, reload });
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
	if (client && yes && terminateAgents) {
		for (const card of presence.filter((item) => item.status !== "offline")) {
			await client.publishAsync(`pi/${process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : projectKey(cwd, project)}/agents/${card.instance}/commands`, JSON.stringify({
				type: "terminate",
				requested_by_instance: "yano-cli",
				requested_by_role: "operator",
				reason: `yano pause: snapshot non distruttivo ${directory}`,
				timestamp: new Date().toISOString(),
			}), { qos: 1 });
		}
	}
	// MQTT presence can be absent/stale while a Pi process is still visible in
	// Herdr. A pause must actually stop that process too; otherwise a paused
	// run keeps consuming work and can continue spawning agents. Restrict this
	// fallback to panes whose cwd is exactly this project root, never merely a
	// tab with a matching label.
	const herdrStopped = [];
	if (yes && terminateAgents && commandExists("herdr")) {
		const liveHerdr = herdrJson(["api", "snapshot"]);
		const herdrAgents = liveHerdr?.agents || liveHerdr?.panes || [];
		for (const pane of herdrAgents.filter((item) => item.agent === "pi" && path.resolve(item.cwd || "") === path.resolve(cwd))) {
			const result = spawnSync("herdr", ["pane", "send-keys", pane.pane_id, "ctrl-c", "ctrl-d"], { encoding: "utf8" });
			if (result.status === 0) herdrStopped.push(pane.pane_id);
		}
	}
	if (client) await client.endAsync();
	db.close();
	console.log(`yano pause: run ${run.id} salvato in ${directory}`);
	console.log(`   agent osservati: ${presence.filter((item) => item.status !== "offline").map((item) => item.instance).join(", ") || "nessuno"}`);
	console.log(`   ${yes && terminateAgents ? "terminate graceful inviati" : "nessun processo fermato"}; fallback Herdr: ${herdrStopped.join(", ") || "nessuna pane"}; stato SQLite preservato.`);
	return { pauseId, directory, manifest, herdrStopped };
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
	for (const snapshot of snapshots) for (const tab of (snapshot?.data?.herdr?.tabs || [])) {
		if (tab.label && looksLikeAgentInstance(tab.label)) {
			result.set(tab.label, { instance: tab.label, role: roleFromInstance(tab.label), source: result.get(tab.label)?.source || "herdr-snapshot" });
		}
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

function herdrInventory(snapshot) {
	if (!snapshot) return null;
	return {
		workspaces: (snapshot.workspaces || []).map((item) => ({
			workspace_id: item.workspace_id,
			label: item.label,
			root_pane_id: item.root_pane_id || item.root_pane?.pane_id || null,
		})),
		tabs: (snapshot.tabs || []).map((item) => ({
			tab_id: item.tab_id,
			workspace_id: item.workspace_id,
			label: item.label,
		})),
		panes: (snapshot.panes || []).map((item) => ({
			pane_id: item.pane_id,
			tab_id: item.tab_id,
			workspace_id: item.workspace_id,
			cwd: item.cwd || null,
		})),
	};
}

function herdrHasProjectWorkspace(snapshot, cwd, project) {
	if (!snapshot) return false;
	return (snapshot.workspaces || []).some((workspace) => workspace.label === project);
}

function herdrLaunch({ cwd, project, instance, args }) {
	const snapshot = herdrJson(["api", "snapshot"]);
	// The cwd can appear in a shared workspace hosting a specialist for this
	// project. Recovery must use only the explicitly named project workspace.
	const workspace = snapshot?.workspaces?.find((item) => item.label === project);
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
		const discovered = await discoverPresence(project, value(argv, "--broker") || BROKER_URL, cwd);
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
	return { runs, launched, snapshots, agents };
}

async function waitForPresenceCondition({ cwd, project, broker, instances, timeoutMs, predicate }) {
	const deadline = Date.now() + timeoutMs;
	let last = [];
	while (Date.now() < deadline) {
		let client = null;
		try {
			const discovered = await discoverPresence(project, broker, cwd);
			client = discovered.client;
			last = discovered.cards;
			const selected = discovered.cards.filter((card) => instances.has(card.instance));
			if (predicate(selected, instances)) return { ok: true, cards: selected };
		} catch {
			// Keep polling until the bounded deadline; the caller gets the last
			// observed cards and a deterministic diagnostic on timeout.
		} finally {
			if (client) { try { await client.endAsync(); } catch { /* best effort */ } }
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return { ok: false, cards: last.filter((card) => instances.has(card.instance)) };
}

async function prepareReload({ cwd, project, broker, cards, timeoutMs, force }) {
	const live = cards.filter((card) => card.status !== "offline");
	const instances = new Set(live.map((card) => card.instance));
	if (!instances.size || force) return { prepared: force ? [] : [...instances], forced: force, cards: live };
	let client = null;
	try {
		const discovered = await discoverPresence(project, broker, cwd);
		client = discovered.client;
		for (const card of discovered.cards.filter((item) => instances.has(item.instance) && item.status !== "offline")) {
			await client.publishAsync(`pi/${process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : projectKey(cwd, project)}/agents/${card.instance}/commands`, JSON.stringify({
				type: "reload_prepare",
				requested_by_instance: "yano-cli",
				requested_by_role: "operator",
				reason: "yano update --reload: raggiungere un safe point prima dell\'aggiornamento",
				timestamp: new Date().toISOString(),
			}), { qos: 1 });
		}
	} finally {
		if (client) { try { await client.endAsync(); } catch { /* best effort */ } }
	}
	const ready = await waitForPresenceCondition({
		cwd, project,
		broker,
		instances,
		timeoutMs,
		predicate: (selected, expected) => [...expected].every((instance) => selected.some((card) => card.instance === instance && card.reload_requested === true && card.reload_ready === true)),
	});
	if (!ready.ok) {
		const pending = ready.cards.filter((card) => !card.reload_ready).map((card) => card.instance);
		let cancelClient = null;
		try {
			const discovered = await discoverPresence(project, broker, cwd);
			cancelClient = discovered.client;
			for (const card of discovered.cards.filter((item) => instances.has(item.instance) && item.status !== "offline")) {
				await cancelClient.publishAsync(`pi/${process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : projectKey(cwd, project)}/agents/${card.instance}/commands`, JSON.stringify({
					type: "reload_cancel",
					requested_by_instance: "yano-cli",
					requested_by_role: "operator",
					reason: "safe point non raggiunto: barriera reload annullata senza fermare gli agenti",
					timestamp: new Date().toISOString(),
				}), { qos: 1 });
			}
		} catch { /* best effort: the original timeout remains the actionable error */ }
		finally { if (cancelClient) { try { await cancelClient.endAsync(); } catch { /* best effort */ } } }
		throw new Error(`safe point non raggiunto entro ${timeoutMs} ms dagli agenti: ${pending.join(", ") || [...instances].join(", ")}. Usa --force solo se accetti di interrompere il lavoro corrente.`);
	}
	return { prepared: [...instances], forced: false, cards: ready.cards };
}

async function waitForOffline({ project, broker, instances, timeoutMs }) {
	if (!instances.size) return { ok: true, cards: [] };
	return waitForPresenceCondition({
		project,
		broker,
		instances,
		timeoutMs,
		predicate: (selected) => selected.every((card) => card.status === "offline"),
	});
}

function writeReloadUpdate(snapshotResults, updateResult, state) {
	for (const result of snapshotResults) {
		try {
			fs.writeFileSync(path.join(result.directory, "reload-update.json"), `${JSON.stringify({
				updated_at: new Date().toISOString(),
				state,
				update: safeJson(updateResult),
			}, null, 2)}\n`, { mode: 0o600 });
		} catch { /* snapshot is already durable; reporting is best effort */ }
	}
}

/**
 * Controlled update orchestration. The update callback is deliberately
 * injected so this module owns the pause/snapshot/restart transaction without
 * importing the updater back (which would create a circular dependency).
 */
export async function runControlledReload({ cwd, packageRoot, argv, update }) {
	const project = projectScope(cwd, argv);
	traceReloadEvent({ cwd, project, stage: "preflight", payload: { dry_run: has(argv, "--dry-run"), force: has(argv, "--force") } });
	const dbPath = projectDbPath(cwd, project);
	const dryRun = has(argv, "--dry-run");
	const yes = has(argv, "--yes");
	const force = has(argv, "--force");
	const timeoutMs = Math.max(5_000, Number(value(argv, "--timeout") || 120) * 1000);
	if (has(argv, "--all-projects")) throw new Error("yano update --reload è limitato al progetto corrente; usa un progetto per volta per evitare reload globali accidentali.");
	if (!fs.existsSync(dbPath)) {
		console.log(`yano update --reload: database Yano non trovato per ${project}; nessun agente/run da ricaricare${dryRun ? ", anteprima senza aggiornamento" : ", eseguo l'update normale"}.`);
		if (dryRun) return { dryRun: true, runs: [], presence: [], reason: "database-missing" };
		return update();
	}
	const db = getDb(dbPath, true);
	const runs = db.prepare("SELECT * FROM runs WHERE status = 'active' ORDER BY created_at ASC").all();
	db.close();
	if (!runs.length) {
		console.log(`yano update --reload: nessun run attivo nel progetto ${project}${dryRun ? ", anteprima senza aggiornamento" : ", eseguo l'update normale"}.`);
		if (dryRun) return { dryRun: true, runs: [], presence: [], reason: "no-active-run" };
		return update();
	}
	const herdrSnapshot = herdrJson(["api", "snapshot"]);
	if (!herdrSnapshot && !dryRun) throw new Error("Herdr non raggiungibile: reload annullato prima di fermare gli agenti.");
	if (!dryRun && !commandExists("herdr")) throw new Error("Herdr non trovato sul PATH: reload annullato.");
	if (!dryRun && !herdrHasProjectWorkspace(herdrSnapshot, cwd, project)) throw new Error(`workspace Herdr del progetto "${project}" non trovato: reload annullato prima di fermare gli agenti.`);
	let discoveryClient = null;
	let presence = [];
	try {
			const discovered = await discoverPresence(project, value(argv, "--broker") || BROKER_URL, cwd);
		discoveryClient = discovered.client;
		presence = discovered.cards.filter((card) => card.status !== "offline");
	} catch (error) {
		if (!dryRun) throw new Error(`broker MQTT non raggiungibile: reload annullato (${error instanceof Error ? error.message : String(error)})`);
	} finally {
		if (discoveryClient) { try { await discoveryClient.endAsync(); } catch { /* best effort */ } }
	}
	console.log(`yano update --reload: progetto ${project}, run attivi ${runs.map((run) => run.id).join(", ")}.`);
	console.log(`   agenti live rilevati: ${presence.map((card) => `${card.instance}(${card.status})`).join(", ") || "nessuno"}`);
	console.log(`   piano: safe point → snapshot → update → restart Herdr → verifica versione.`);
	if (dryRun || !yes) {
		console.log("   nessuna modifica eseguita: aggiungi --yes per confermare (oppure --dry-run per questa anteprima). ");
		return { dryRun: true, runs, presence, herdr: herdrInventory(herdrSnapshot) };
	}
	const broker = value(argv, "--broker") || BROKER_URL;
	const startedAt = new Date().toISOString();
	const prepared = await prepareReload({ cwd, project, broker, cards: presence, timeoutMs, force });
	traceReloadEvent({ cwd, project, stage: "barrier", payload: { agents: prepared.prepared, forced: prepared.forced, timeout_ms: timeoutMs } });
	const workspaceDir = resolveYanoWorkspaceDir(cwd, project);
	const snapshotResults = [];
	try {
		for (const run of runs) {
			const result = await pauseRun({
				cwd, project, dbPath, workspaceDir, run, broker, yes: true,
				herdrSnapshot: herdrInventory(herdrSnapshot),
				reload: { requested_at: startedAt, forced: prepared.forced, safe_point_agents: prepared.prepared },
				terminateAgents: snapshotResults.length === 0,
			});
			snapshotResults.push(result);
		}
		traceReloadEvent({ cwd, project, stage: "checkpoint", payload: { snapshots: snapshotResults.map((result) => result.directory) } });
		const offline = await waitForOffline({ project, broker, instances: new Set(presence.map((card) => card.instance)), timeoutMs });
		if (!offline.ok) throw new Error(`alcuni agenti non hanno confermato offline dopo terminate: ${offline.cards.filter((card) => card.status !== "offline").map((card) => card.instance).join(", ")}`);
	} catch (error) {
		writeReloadUpdate(snapshotResults, null, "paused_with_error");
		throw error;
	}
	let updateResult;
	try {
		updateResult = await update();
		traceReloadEvent({ cwd, project, stage: "updated", payload: { update: updateResult } });
		writeReloadUpdate(snapshotResults, updateResult, "updated_pending_resume");
	} catch (error) {
		writeReloadUpdate(snapshotResults, { error: error instanceof Error ? error.message : String(error) }, "update_failed_agents_left_paused");
		console.error(`yano update --reload: aggiornamento fallito; gli agenti restano in pausa e lo snapshot è disponibile in ${snapshotResults[0]?.directory || "<YANO_DATA_DIR>/recovery"}.`);
		throw error;
	}
	const resumeArgv = [...argv.filter((arg) => !["--dry-run", "--force", "--reload"].includes(arg)), "--yes"];
	const resumed = await resumeRuns({ cwd, project, dbPath, runs, argv: resumeArgv });
	traceReloadEvent({ cwd, project, stage: "resumed", payload: { agents: resumed.launched } });
	const expectedVersion = updateResult?.newVersion || updateResult?.currentVersion || null;
	if (expectedVersion) {
		const deadline = Date.now() + timeoutMs;
		const expectedInstances = new Set(resumed.agents.map((agent) => agent.instance));
		let verified = [];
		while (Date.now() < deadline) {
			const records = readTraceRecords({ cwd, project, since: new Date(startedAt), limit: 100000 });
			verified = records.filter((record) => record.type === "trace_preflight" && record.version_match === true && record.yano_runtime_version === expectedVersion && expectedInstances.has(record.instance));
			if ([...expectedInstances].every((instance) => verified.some((record) => record.instance === instance))) break;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const missing = [...expectedInstances].filter((instance) => !verified.some((record) => record.instance === instance));
		if (missing.length) {
			writeReloadUpdate(snapshotResults, { ...updateResult, missing_version_handshake: missing }, "resume_version_unverified");
			throw new Error(`reload completato senza handshake della nuova versione per: ${missing.join(", ")}`);
		}
	}
	writeReloadUpdate(snapshotResults, updateResult, "completed");
	traceReloadEvent({ cwd, project, stage: "completed", payload: { version: expectedVersion, agents: resumed.launched.map((item) => item.instance) } });
	console.log(`yano update --reload: completato; ${resumed.launched.length} agenti rilanciati e versione verificata (${expectedVersion || "non disponibile"}).`);
	return { ...updateResult, resumed, snapshots: snapshotResults };
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
	if (!sub || sub === "--help" || sub === "-h" || has(argv, "--help") || has(argv, "-h")) { usage(); return; }
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
