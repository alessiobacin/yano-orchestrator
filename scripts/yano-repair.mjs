#!/usr/bin/env node

// Riallineamento automatico di un progetto Yano.
//
// update --reload copre soltanto un run persistito in orchestrator.db.
// Questo comando copre anche il caso precedente: agenti Herdr ancora vivi
// sotto uno scope MQTT vecchio, progetto senza database e tab da riallineare.
// Non cancella codice, trace, worktree o database.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { buildTraceOverview, projectKey, readTraceRecords, resolveTraceProject, traceRoot } from "./yano-trace-storage.mjs";
import { projectDbPath, resolveYanoWorkspaceDir, slugifyProject } from "./yano-project.mjs";
import { ensureProjectDatabase } from "./yano-project-db.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}

function has(argv, flag) { return argv.includes(flag); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function isLivePresenceCard(card) {
	if (!card || card.status === "offline") return false;
	const heartbeat = Date.parse(card.last_heartbeat || card.started_at || "");
	const staleAfter = Number(process.env.PI_ORCH_STALE_AFTER_MS) || 45_000;
	return Number.isFinite(heartbeat) && Date.now() - heartbeat <= staleAfter;
}
function safeJson(valueToSerialize) {
	try { return JSON.parse(JSON.stringify(valueToSerialize)); } catch { return String(valueToSerialize); }
}
function canonicalRoot(valueToResolve) {
	try { return fs.realpathSync(valueToResolve); } catch { return path.resolve(valueToResolve); }
}
function commandExists(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
	return !result.error || result.error.code !== "ENOENT";
}

function projectInfo(cwd, argv) {
	const root = canonicalRoot(value(argv, "--project-root") || cwd);
	const explicit = value(argv, "--project");
	const name = String(explicit || resolveTraceProject(root)).trim();
	if (!name) throw new Error("impossibile determinare il nome del progetto");
	return {
		root,
		name,
		key: projectKey(root, name),
		workspaceDir: resolveYanoWorkspaceDir(root, name),
		dbPath: projectDbPath(root, name),
	};
}

function sqliteClass() {
	try { return process.getBuiltinModule?.("node:sqlite")?.DatabaseSync || require("node:sqlite").DatabaseSync; }
	catch { return null; }
}

function readSqliteRows(file, table) {
	if (!file || !fs.existsSync(file)) return [];
	const DatabaseSync = sqliteClass();
	if (!DatabaseSync) return [];
	let db = null;
	try {
		db = new DatabaseSync(file, { readOnly: true });
		const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
		if (!present) return [];
		return db.prepare(`SELECT * FROM ${table}`).all();
	} catch { return []; }
	finally { try { db?.close(); } catch { /* best effort */ } }
}

function workerIsActive(status) {
	return !new Set(["", "stopped", "paused", "rejected", "completed", "done", "blocked", "offline"]).has(String(status || "").toLowerCase());
}

function externalWorkerRows(snapshot = null) {
	const root = traceRoot();
	const registries = [
		{ source: "debugger", role: "debugger", file: path.join(root, "debugger", "debugger.sqlite"), table: "debugger_projects", defaultInstance: (name) => `debugger-${slugifyProject(name)}` },
		{ source: "auto-improver", role: "auto-improver", file: path.join(root, "auto-improver", "auto-improver.sqlite"), table: "auto_projects", defaultInstance: (name) => `auto-improver-${slugifyProject(name)}` },
		{ source: "suggester", role: "suggester", file: path.join(root, "suggester", "suggester.sqlite"), table: "suggester_projects", defaultInstance: (name) => `suggester-${slugifyProject(name)}` },
	];
	const rows = [];
	for (const registry of registries) {
		for (const row of readSqliteRows(registry.file, registry.table)) {
			if (!row.root || !workerIsActive(row.worker_status)) continue;
			const name = String(row.name || path.basename(row.root));
			rows.push({
				source: [registry.source],
				role: registry.role,
				root: canonicalRoot(row.root),
				name,
				key: row.project_key || projectKey(row.root, name),
				status: row.worker_status || "unknown",
				workspace_id: row.workspace_id || null,
				tab_id: row.worker_tab_id || null,
				pane_id: row.worker_pane_id || null,
				instance: row.worker_instance || registry.defaultInstance(name),
			});
		}
	}
	// Architect e Watcher non hanno un registro projects dedicato: la loro
	// presenza runtime è pubblicata da Herdr. Prima del fix venivano quindi
	// esclusi da `external_workers`, anche se erano regolarmente attivi.
	const workspaceLabels = new Map((snapshot?.workspaces || []).map((workspace) => [workspace.workspace_id, workspace.label]));
	for (const pane of allSnapshotPanes(snapshot)) {
		const role = roleFromInstance(pane.instance, pane.label);
		if (!role || !["architect", "watcher", "debugger", "auto-improver", "suggester"].includes(role)) continue;
		if (pane.agent !== "pi" || ["unknown", "offline", "done", "completed"].includes(String(pane.agent_status || "").toLowerCase()) || !pane.cwd) continue;
		const name = resolveTraceProject(pane.cwd);
		const key = projectKey(pane.cwd, name);
		const existing = rows.find((worker) => worker.role === role && canonicalRoot(worker.root) === canonicalRoot(pane.cwd));
		if (existing) {
			Object.assign(existing, {
				root: canonicalRoot(pane.cwd), name, key, status: pane.agent_status || "idle",
				workspace_id: pane.workspace_id || existing.workspace_id,
				tab_id: pane.tab_id || existing.tab_id, pane_id: pane.pane_id || existing.pane_id,
				instance: pane.instance || existing.instance, active: true,
				workspace: workspaceLabels.get(pane.workspace_id) || existing.workspace || null,
			});
			existing.source = [...new Set([...(existing.source || []), "herdr"] )];
		} else {
			rows.push({ source: "herdr", role, root: canonicalRoot(pane.cwd), name, key, status: pane.agent_status || "idle", active: true, workspace_id: pane.workspace_id || null, workspace: workspaceLabels.get(pane.workspace_id) || null, tab_id: pane.tab_id || null, pane_id: pane.pane_id || null, instance: pane.instance || pane.label });
		}
	}
	return rows;
}

function allSnapshotPanes(snapshot) {
	if (!snapshot) return [];
	const agentsByPane = new Map((snapshot.agents || []).map((agent) => [agent.pane_id, agent]));
	const tabsById = new Map((snapshot.tabs || []).map((tab) => [tab.tab_id, tab]));
	const source = [...(snapshot.panes || [])];
	const known = new Set(source.map((pane) => pane.pane_id).filter(Boolean));
	for (const agent of snapshot.agents || []) {
		if (!agent.pane_id || !known.has(agent.pane_id)) source.push(agent);
	}
	return source.map((pane) => {
		const companion = agentsByPane.get(pane.pane_id) || {};
		const merged = { ...companion, ...pane };
		const tabLabel = tabsById.get(merged.tab_id)?.label;
		return {
			pane_id: merged.pane_id,
			tab_id: merged.tab_id,
			workspace_id: merged.workspace_id,
			label: paneLabel(merged) || String(tabLabel || "").trim(),
			agent: merged.agent || null,
			agent_status: merged.agent_status || "unknown",
			instance: paneInstance(merged) || (merged.agent === "pi" ? paneLabel(merged) : null),
			cwd: merged.cwd || merged.foreground_cwd || null,
			raw_labels: [merged.label, merged.terminal_title_stripped, merged.terminal_title, merged.name, tabLabel].filter(Boolean),
		};
	});
}

function externalWorkersForProject(info, snapshot = null) {
	return externalWorkerRows(snapshot).filter((worker) => canonicalRoot(worker.root) === canonicalRoot(info.root));
}

function findWorkerPane(snapshot, worker) {
	const panes = allSnapshotPanes(snapshot);
	return panes.find((pane) => worker.pane_id && pane.pane_id === worker.pane_id)
		|| panes.find((pane) => worker.tab_id && pane.tab_id === worker.tab_id)
		|| panes.find((pane) => pane.workspace_id === worker.workspace_id && pane.label === canonicalTabLabel({ name: worker.name }, worker.role));
}

function workerWorkspaceLabel(role) {
	return {
		debugger: "yano-debugger",
		"auto-improver": "yano-auto-improver",
		suggester: "yano-suggester",
	}[role] || `yano-${role}`;
}

function workerWorkspaceRoot(role) {
	return path.join(traceRoot(), "agent-workspaces", workerWorkspaceLabel(role));
}

function isYanoProjectRoot(root) {
	return [
		path.join(root, ".pi", "extensions", "yano-orchestrator", "config", "project.json"),
		path.join(root, ".pi", "agents", "roles.yaml"),
		path.join(root, "agents", "roles.yaml"),
	].some((file) => fs.existsSync(file));
}

function collectRepairProjectRoots(snapshot, workers) {
	const roots = new Set(workers.map((worker) => canonicalRoot(worker.root)));
	for (const pane of allSnapshotPanes(snapshot)) {
		if (pane.agent !== "pi" || !pane.cwd) continue;
		const root = canonicalRoot(pane.cwd);
		if (isYanoProjectRoot(root)) roots.add(root);
	}
	return [...roots].sort();
}

function ensureWorkerPane(snapshot, info, worker) {
	let current = findWorkerPane(snapshot, worker);
	if (current) return current;
	if (!commandExists("herdr")) return null;
	let workspace = (snapshot?.workspaces || []).find((item) => item.workspace_id === worker.workspace_id || item.label === workerWorkspaceLabel(worker.role));
	if (!workspace) {
		fs.mkdirSync(workerWorkspaceRoot(worker.role), { recursive: true, mode: 0o700 });
		const created = spawnSync("herdr", ["workspace", "create", "--cwd", workerWorkspaceRoot(worker.role), "--label", workerWorkspaceLabel(worker.role), "--no-focus"], { encoding: "utf8" });
		if (created.status !== 0) return null;
		workspace = herdrSnapshot()?.workspaces?.find((item) => item.label === workerWorkspaceLabel(worker.role));
	}
	if (!workspace?.workspace_id) return null;
	const label = canonicalTabLabel(info, worker.role) || `${worker.role}-${slugifyProject(info.name)}`;
	const result = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", label, "--no-focus"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	current = findWorkerPane(herdrSnapshot(), { ...worker, workspace_id: workspace.workspace_id });
	return current;
}

function herdrSnapshot() {
	if (!commandExists("herdr")) return null;
	const result = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 32_000_000 });
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		return parsed?.result?.snapshot || parsed?.result || parsed;
	} catch { return null; }
}

function paneLabel(pane) {
	// Herdr can retain pane.name/label from the process that occupied the pane
	// before a graceful restart. The terminal title is updated by yano start and
	// is the freshest human-visible identity, so prefer it for reconciliation.
	return String(pane?.terminal_title_stripped || pane?.terminal_title || pane?.label || pane?.name || "").trim();
}

function paneInstance(pane) {
	const candidates = [pane?.agent_instance, pane?.terminal_title_stripped, pane?.terminal_title, pane?.name, pane?.label];
	return candidates.map((item) => String(item || "").trim()).find((item) => item && roleFromInstance(item)) || null;
}

function allProjectPanes(snapshot, root) {
	if (!snapshot) return [];
	const canonical = canonicalRoot(root);
	return allSnapshotPanes(snapshot)
		.filter((pane) => canonicalRoot(pane.cwd || pane.foreground_cwd || "") === canonical)
		.map((pane) => ({
			pane_id: pane.pane_id,
			tab_id: pane.tab_id,
			workspace_id: pane.workspace_id,
			label: pane.label,
			agent: pane.agent || null,
			agent_status: pane.agent_status || "unknown",
			instance: pane.instance || (pane.agent === "pi" ? pane.label : null),
			raw_labels: pane.raw_labels || [pane.label].filter(Boolean),
			cwd: pane.cwd || pane.foreground_cwd || root,
		}));
}

function activeProjectPanes(snapshot, root) {
	return allProjectPanes(snapshot, root).filter((pane) => pane.agent === "pi" && !["unknown", "offline", "done"].includes(pane.agent_status));
}

function blankProjectPanes(snapshot, root) {
	return allProjectPanes(snapshot, root).filter((pane) => !pane.agent && !pane.instance);
}

function blankProjectPaneInWorkspace(snapshot, root, workspaceId) {
	return blankProjectPanes(snapshot, root).find((pane) => pane.workspace_id === workspaceId) || null;
}

function aliasesFromSnapshot(snapshot, panes, canonicalName) {
	const aliases = new Set([canonicalName, slugifyProject(canonicalName)]);
	const labels = [
		...panes.flatMap((pane) => pane.raw_labels || [pane.label]),
		...(snapshot?.tabs || []).filter((tab) => (snapshot?.panes || []).some((pane) => pane.tab_id === tab.tab_id && canonicalRoot(pane.cwd || pane.foreground_cwd || "") === canonicalRoot(panes[0]?.cwd || ""))).map((tab) => tab.label),
	];
	for (const rawLabel of labels) {
		const label = String(rawLabel || "").toLowerCase();
		const match = label.match(/^(?:architect|watcher|debugger|auto-improver|suggester|yano-watcher|yano-debugger|yano-auto-improver|yano-suggester)[-_](.+)$/);
		if (match?.[1] && !/^prop-\d{14}-[a-f0-9]+$/.test(match[1])) aliases.add(match[1]);
	}
	return [...aliases].filter(Boolean);
}

async function discoverPresence(scopes, broker) {
	const uniqueScopes = [...new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean))];
	if (!uniqueScopes.length) return { ok: true, broker, scopes: [], cards: [] };
	let client = null;
	try {
		client = await mqtt.connectAsync(broker, { reconnectPeriod: 0, connectTimeout: 2_000 });
		const cards = new Map();
		const onMessage = (topic, payload) => {
			try {
				const card = JSON.parse(payload.toString());
				if (card?.instance) cards.set(topic + ":" + card.instance, { scope: topic.split("/")[1], ...card });
			} catch { /* retained malformed presence is ignored */ }
		};
		// Register before subscribing: MQTT retained cards may be delivered
		// synchronously as part of subscribeAsync. Registering afterwards loses
		// exactly the cards repair needs to reconcile.
		client.on("message", onMessage);
		for (const scope of uniqueScopes) await client.subscribeAsync("pi/" + scope + "/agents/+/status", { qos: 0 });
		await sleep(650);
		client.removeListener("message", onMessage);
		await client.endAsync();
		const allCards = [...cards.values()];
		return { ok: true, broker, scopes: uniqueScopes, cards: allCards, live_cards: allCards.filter(isLivePresenceCard), stale_cards: allCards.filter((card) => !isLivePresenceCard(card)) };
	} catch (error) {
		try { if (client) await client.endAsync(); } catch { /* best effort */ }
		return { ok: false, broker, scopes: uniqueScopes, cards: [], live_cards: [], stale_cards: [], error: error instanceof Error ? error.message : String(error) };
	}
}

async function discoverAllPresence(broker) {
	let client = null;
	try {
		client = await mqtt.connectAsync(broker, { reconnectPeriod: 0, connectTimeout: 2_000 });
		const cards = new Map();
		const onMessage = (topic, payload) => {
			try {
				const card = JSON.parse(payload.toString());
				const scope = topic.split("/")[1];
				if (scope && card?.instance) cards.set(topic + ":" + card.instance, { scope, ...card });
			} catch { /* malformed retained presence is ignored */ }
		};
		client.on("message", onMessage);
		await client.subscribeAsync("pi/+/agents/+/status", { qos: 0 });
		await sleep(650);
		client.removeListener("message", onMessage);
		await client.endAsync();
		const allCards = [...cards.values()];
		return { ok: true, broker, cards: allCards, live_cards: allCards.filter(isLivePresenceCard), stale_cards: allCards.filter((card) => !isLivePresenceCard(card)) };
	} catch (error) {
		try { if (client) await client.endAsync(); } catch { /* best effort */ }
		return { ok: false, broker, cards: [], live_cards: [], stale_cards: [], error: error instanceof Error ? error.message : String(error) };
	}
}

function gitSnapshot(root) {
	const run = (args) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
		return result.status === 0 ? result.stdout.trim() : null;
	};
	return {
		branch: run(["branch", "--show-current"]),
		head: run(["rev-parse", "HEAD"]),
		status: run(["status", "--short"]),
		worktrees: run(["worktree", "list", "--porcelain"]),
	};
}

function copyIfExists(source, target) {
	if (!fs.existsSync(source)) return false;
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	fs.copyFileSync(source, target);
	return true;
}

function writeRepairSnapshot(info, input) {
	const directory = path.join(traceRoot(), "recovery", "repair", slugifyProject(info.name), nowStamp() + "-" + crypto.randomUUID().slice(0, 8));
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const records = readTraceRecords({ cwd: info.root, project: info.name, limit: 100_000 });
	const files = {
		database: copyIfExists(info.dbPath, path.join(directory, "orchestrator.db")),
		wal: copyIfExists(info.dbPath + "-wal", path.join(directory, "orchestrator.db-wal")),
		shm: copyIfExists(info.dbPath + "-shm", path.join(directory, "orchestrator.db-shm")),
		project_config: copyIfExists(path.join(info.workspaceDir, "config", "project.json"), path.join(directory, "project.json")),
		package_json: copyIfExists(path.join(info.root, "package.json"), path.join(directory, "package.json")),
	};
	const manifest = {
		schema_version: 1,
		created_at: new Date().toISOString(),
		operation: "yano repair",
		project: { name: info.name, root: info.root, key: info.key },
		aliases: input.aliases,
		package_version: input.packageVersion,
		options: input.options,
		herdr: safeJson(input.herdr),
		presence: safeJson(input.presence),
		git: gitSnapshot(info.root),
		trace: {
			count: records.length,
			overview: buildTraceOverview({ cwd: info.root, project: info.name, limit: 100_000 }),
		},
		files,
		contract: "Repair preserves project source, trace files and SQLite state; it only reconciles project agents and optionally updates Yano.",
	};
	fs.writeFileSync(path.join(directory, "repair.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
	return { directory, manifest };
}

async function terminatePresence(cards, broker, reason) {
	const live = cards.filter((card) => card.status !== "offline");
	if (!live.length) return { ok: true, sent: [] };
	let client = null;
	try {
		client = await mqtt.connectAsync(broker, { reconnectPeriod: 0, connectTimeout: 2_000 });
		const sent = [];
		for (const card of live) {
			await client.publishAsync("pi/" + card.scope + "/agents/" + card.instance + "/commands", JSON.stringify({
				type: "terminate",
				requested_by_instance: "yano-cli",
				requested_by_role: "operator",
				reason,
				timestamp: new Date().toISOString(),
			}), { qos: 1 });
			sent.push(card.scope + "/" + card.instance);
		}
		await client.endAsync();
		return { ok: true, sent };
	} catch (error) {
		try { if (client) await client.endAsync(); } catch { /* best effort */ }
		return { ok: false, sent: [], error: error instanceof Error ? error.message : String(error) };
	}
}

async function waitForOffline(scopes, broker, expected, timeoutMs) {
	if (!expected.size) return { ok: true, remaining: [] };
	const deadline = Date.now() + timeoutMs;
	let last = [];
	while (Date.now() < deadline) {
		const discovered = await discoverPresence(scopes, broker);
		last = discovered.cards;
		const live = last.filter((card) => expected.has(card.scope + "/" + card.instance) && isLivePresenceCard(card));
		if (!live.length) return { ok: true, remaining: [] };
		await sleep(250);
	}
	return {
		ok: false,
		remaining: last.filter((card) => expected.has(card.scope + "/" + card.instance) && isLivePresenceCard(card)).map((card) => card.scope + "/" + card.instance),
	};
}

function sendPaneKeys(paneId, keys) {
	if (!paneId || !commandExists("herdr")) return false;
	return spawnSync("herdr", ["pane", "send-keys", paneId, ...keys], { encoding: "utf8" }).status === 0;
}

function ensureProjectWorkspace(snapshot, info) {
	const label = path.basename(info.root) || info.name;
	const existing = snapshot?.workspaces?.find((item) => item.label === info.name || item.label === label);
	if (existing) return existing;
	if (!commandExists("herdr")) return null;
	const result = spawnSync("herdr", ["workspace", "create", "--cwd", info.root, "--label", info.name, "--no-focus"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const refreshed = herdrSnapshot();
	return refreshed?.workspaces?.find((item) => item.label === info.name || item.label === label) || null;
}

function ensurePlannerPane(snapshot, info, workspace) {
	if (!workspace || !commandExists("herdr")) return null;
	// A pane that looks blank/unknown in the snapshot may still contain a
	// dead shell and be rejected by `herdr agent start`. Always allocate a
	// fresh project tab for a missing Planner; the duplicate cleanup below
	// closes the retained legacy tab once the new agent is ready.
	const label = `planner-01-new-${Date.now().toString(36)}`.slice(0, 60);
	const result = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", label, "--no-focus"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const refreshed = herdrSnapshot();
	const tab = refreshed?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === label);
	return tab ? (refreshed.panes || []).find((pane) => pane.tab_id === tab.tab_id) || null : null;
}

function createProjectAgentPane(info, workspace, role) {
	if (!workspace?.workspace_id || !commandExists("herdr")) return null;
	const label = `${canonicalTabLabel(info, role) || role}-new-${Date.now().toString(36)}`.slice(0, 60);
	const result = spawnSync("herdr", ["tab", "create", "--workspace", workspace.workspace_id, "--cwd", info.root, "--label", label, "--no-focus"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const refreshed = herdrSnapshot();
	const tab = refreshed?.tabs?.find((item) => item.workspace_id === workspace.workspace_id && item.label === label);
	return tab ? (refreshed.panes || []).find((pane) => pane.tab_id === tab.tab_id) || null : null;
}

function roleFromInstance(instance, label) {
	const text = String(instance || label || "").toLowerCase();
	if (text.includes("architect")) return "architect";
	if (text.includes("yano-watcher") || text.startsWith("watcher")) return "watcher";
	if (text.includes("auto-improver")) return "auto-improver";
	if (text.includes("suggester")) return "suggester";
	if (text.includes("debugger")) return "debugger";
	if (text.startsWith("planner")) return "planner";
	if (text.startsWith("frontend-developer") || text.startsWith("frontend_developer")) return "frontend-developer";
	if (text.startsWith("frontend-reviewer") || text.startsWith("frontend_reviewer")) return "frontend-reviewer";
	if (text.startsWith("reviewer")) return "reviewer";
	if (text.startsWith("coder")) return "coder";
	if (text.startsWith("docs")) return "docs-sync";
	if (text.startsWith("tdd")) return "tdd-agent";
	if (text.startsWith("e2e")) return "e2e-simulator";
	if (text.startsWith("schema")) return "schema-migrator";
	return null;
}

function canonicalInstance(info, oldPane, role) {
	const slug = slugifyProject(info.name);
	if (role === "architect") return "architect-" + slug;
	if (role === "watcher") return "watcher-" + slug;
	return oldPane.instance || oldPane.label;
}

function canonicalTabLabel(info, role) {
	const slug = slugifyProject(info.name);
	if (role === "planner") return "planner-01";
	if (role === "architect") return "architect-" + slug;
	if (role === "watcher") return "watcher-" + slug;
	if (["debugger", "auto-improver", "suggester"].includes(role)) return role + "-" + slug;
	return null;
}

function herdrAgentNameForProject(info, instance) {
	// Herdr agent names are globally unique, while Pi's `--instance` is the
	// project-facing identity (for example `planner-01`). A bare planner-01
	// collides as soon as two projects are open. Keep the visible Pi instance
	// unchanged and give Herdr a deterministic project-scoped name.
	const normalized = `${slugifyProject(instance)}-${slugifyProject(info.name)}`;
	if (normalized.length <= 32) return normalized;
	const suffix = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 6);
	return `${normalized.slice(0, 25)}-${suffix}`.slice(0, 32);
}

function composePiArgs(info, instance, role, traceMode, continueSession, packageRoot) {
	const launcher = path.join(packageRoot, "scripts", "launch-planner.mjs");
	if (!fs.existsSync(launcher)) throw new Error("launcher Yano non trovato: " + launcher);
	const launcherArgs = [
		launcher,
		"--instance", instance,
		"--role", role,
		"--project", info.name,
		"--trace-mode", traceMode,
		"--print-only",
		"--json",
	];
	if (continueSession) launcherArgs.push("--continue");
	const result = spawnSync(process.execPath, launcherArgs, { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
	if (result.status !== 0) {
		const output = ((result.stderr || "") + (result.stdout || "")).trim();
		throw new Error("composizione comando agente fallita" + (output ? ": " + output.slice(-1_000) : ""));
	}
	try {
		const composed = JSON.parse(String(result.stdout || "").trim());
		if (!Array.isArray(composed.args) || composed.args.length === 0) throw new Error("args pi assenti");
		return composed.args;
	} catch (error) {
		throw new Error("output JSON del launcher non valido: " + error.message);
	}
}

function launchAgentInPane(info, pane, role, instance, traceMode, continueSession, packageRoot = PACKAGE_ROOT) {
	if (!pane?.pane_id || !role || !instance) return { ok: false, error: "pane, ruolo o istanza mancanti" };
	let piArgs;
	try {
		piArgs = composePiArgs(info, instance, role, traceMode, continueSession, packageRoot);
	} catch (error) {
		return { ok: false, pane_id: pane.pane_id, instance, role, error: error.message };
	}
	// `herdr pane run` submits a shell command and may return 0 before the
	// interactive Pi process is detected. Herdr's agent API instead returns
	// success only after readiness in the requested pane, which prevents repair
	// from claiming a Planner restart when the pane is still just a shell.
	const herdrName = herdrAgentNameForProject(info, instance);
	const command = [
		"herdr", "agent", "start", herdrName, "--kind", "pi", "--pane", pane.pane_id,
		"--timeout", String(Math.min(120_000, Math.max(5_000, Number(process.env.YANO_REPAIR_AGENT_TIMEOUT_MS) || 30_000))),
		"--", ...piArgs,
	];
	const result = spawnSync("herdr", command.slice(1), { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
	if (result.status !== 0) return { ok: false, pane_id: pane.pane_id, instance, role, command: command.join(" "), error: ((result.stderr || result.stdout || "avvio agente fallito")).trim() };
	const label = canonicalTabLabel(info, role);
	if (label && pane.tab_id) spawnSync("herdr", ["tab", "rename", pane.tab_id, label], { encoding: "utf8" });
	let promptSent = false;
	if (["architect", "watcher", "debugger", "auto-improver", "suggester"].includes(role)) {
		const text = role === "watcher"
			? "Riallineamento Yano completato. Il progetto canonico è " + info.name + " alla root " + info.root + ". Opera solo in read-only, usa questo scope e segnala al Planner eventuali contesti/proposte precedenti non più disponibili."
			: role === "architect"
				? "Riallineamento Yano completato. Il progetto canonico è " + info.name + " alla root " + info.root + ". Non modificare il progetto; se la proposta Architect precedente non è disponibile nel catalogo globale, informa il Planner e non inventare un playbook."
				: "Riallineamento Yano completato. Il progetto canonico è " + info.name + " alla root " + info.root + ". Riprendi esclusivamente dal registro persistente, resta read-only sul progetto e comunica al Planner lo stato del worker."
		// Herdr rejects --timeout without --wait. Waiting for `working` confirms
		// that the alignment prompt was accepted without waiting for the LLM
		// response to finish.
		const prompted = spawnSync("herdr", ["agent", "prompt", herdrName, text, "--wait", "--until", "working", "--timeout", "30000"], { cwd: info.root, encoding: "utf8" });
		promptSent = prompted.status === 0;
	}
	return { ok: true, pane_id: pane.pane_id, tab_id: pane.tab_id, instance, herdr_agent_name: herdrName, role, command: command.join(" "), launch_method: "herdr-agent-start", label, prompt_sent: promptSent };
}

function launchPlanner(info, pane, traceMode, continueSession = false, packageRoot = PACKAGE_ROOT) {
	if (!pane?.pane_id) return { ok: false, error: "nessuna pane Herdr disponibile per il Planner" };
	return launchAgentInPane(info, pane, "planner", "planner-01", traceMode, continueSession, packageRoot);
}

function restartObservedAgents(info, beforePanes, traceMode, projectWorkspace, packageRoot = PACKAGE_ROOT) {
	const results = [];
	let snapshot = herdrSnapshot();
	const ordered = [...beforePanes].sort((a, b) => (a.instance === "planner-01" ? -1 : b.instance === "planner-01" ? 1 : 0));
	const singletonRoles = new Set(["planner", "architect", "watcher"]);
	const selectedRoles = new Set();
	for (const oldPane of ordered) {
		const role = roleFromInstance(oldPane.instance, oldPane.label);
		if (!role) continue;
		// Only one Planner, Architect and Watcher may exist for a project. A
		// previous repair could restart every duplicate pane, creating several
		// visible copies. Keep one deterministic candidate and clean up the
		// remaining stale tabs after the canonical agent is live.
		if (singletonRoles.has(role) && selectedRoles.has(role)) continue;
		if (singletonRoles.has(role)) selectedRoles.add(role);
		const isExternal = ["architect", "watcher", "debugger", "auto-improver", "suggester"].includes(role);
		let pane = allProjectPanes(snapshot, info.root).find((candidate) => candidate.pane_id === oldPane.pane_id && (!candidate.agent || candidate.agent_status === "unknown"));
		// A project agent must never be relaunched into a global Yano workspace.
		// This happened when repair reused the first blank pane matching the cwd:
		// the Planner ended up inside yano-watcher and blocked its real watcher.
		if (!isExternal && projectWorkspace?.workspace_id && oldPane.workspace_id !== projectWorkspace.workspace_id) pane = null;
		if (!pane && !isExternal && projectWorkspace?.workspace_id) pane = blankProjectPaneInWorkspace(snapshot, info.root, projectWorkspace.workspace_id);
		if (!pane && !isExternal && projectWorkspace?.workspace_id) {
			const created = spawnSync("herdr", ["tab", "create", "--workspace", projectWorkspace.workspace_id, "--cwd", info.root, "--label", canonicalTabLabel(info, role) || role, "--no-focus"], { encoding: "utf8" });
			if (created.status === 0) pane = blankProjectPaneInWorkspace(herdrSnapshot(), info.root, projectWorkspace.workspace_id);
		}
		if (!pane) {
			results.push({ ok: false, old_instance: oldPane.instance, role, error: "pane non libera dopo lo stop" });
			continue;
		}
		const instance = canonicalInstance(info, oldPane, role);
		let launched = launchAgentInPane(info, pane, role, instance, traceMode, true, packageRoot);
		if (!launched.ok && projectWorkspace?.workspace_id && /busy|available shell|non disponibile/i.test(launched.error || "")) {
			const freshPane = createProjectAgentPane(info, projectWorkspace, role);
			if (freshPane) launched = launchAgentInPane(info, freshPane, role, instance, traceMode, true, packageRoot);
		}
		results.push({ ...launched, old_instance: oldPane.instance });
		snapshot = herdrSnapshot();
	}
	return results;
}

async function closeDuplicateProjectTabs(info, restarted, force) {
	const snapshot = herdrSnapshot();
	if (!snapshot) return [];
	const singletonRoles = new Set(["planner", "architect", "watcher"]);
	const keepByRole = new Map();
	for (const item of restarted.filter((candidate) => candidate.ok && candidate.pane_id)) {
		if (singletonRoles.has(item.role) && !keepByRole.has(item.role)) keepByRole.set(item.role, item.pane_id);
	}
	const current = allProjectPanes(snapshot, info.root);
	for (const role of singletonRoles) {
		if (keepByRole.has(role)) continue;
		const canonical = canonicalTabLabel(info, role);
		const preferred = current.find((pane) => roleFromInstance(pane.instance, pane.label) === role && pane.label === canonical);
		if (preferred) keepByRole.set(role, preferred.pane_id);
	}
	const closed = [];
	for (const pane of current) {
		const role = roleFromInstance(pane.instance, pane.label);
		if (!singletonRoles.has(role) || keepByRole.get(role) === pane.pane_id || !pane.tab_id) continue;
		let live = pane.agent === "pi" && !["unknown", "offline", "done", "completed"].includes(String(pane.agent_status || "").toLowerCase());
		if (live) {
			sendPaneKeys(pane.pane_id, ["ctrl-c"]);
			await sleep(300);
			const refreshed = allProjectPanes(herdrSnapshot(), info.root).find((candidate) => candidate.pane_id === pane.pane_id);
			live = refreshed?.agent === "pi" && !["unknown", "offline", "done", "completed"].includes(String(refreshed.agent_status || "").toLowerCase());
			if (live && !force) continue;
			if (live && force) sendPaneKeys(pane.pane_id, ["ctrl-c", "ctrl-d"]);
		}
		const result = spawnSync("herdr", ["tab", "close", pane.tab_id], { encoding: "utf8" });
		if (result.status === 0) closed.push({ role, pane_id: pane.pane_id, tab_id: pane.tab_id, label: pane.label });
	}
	return closed;
}

function stopExternalWorkerPanes(beforeSnapshot, workers, projectPanes) {
	const projectPaneIds = new Set(projectPanes.map((pane) => pane.pane_id));
	const stopped = [];
	for (const worker of workers) {
		const pane = findWorkerPane(beforeSnapshot, worker);
		if (!pane || projectPaneIds.has(pane.pane_id) || pane.agent !== "pi" || ["unknown", "offline", "done"].includes(pane.agent_status)) continue;
		if (sendPaneKeys(pane.pane_id, ["ctrl-c"])) stopped.push({ ...worker, pane_id: pane.pane_id });
	}
	return stopped;
}

function restartExternalWorkers(info, workers, traceMode, packageRoot = PACKAGE_ROOT) {
	const results = [];
	let snapshot = herdrSnapshot();
	for (const worker of workers) {
		let pane = findWorkerPane(snapshot, worker);
		if (!pane || (pane.agent && !["unknown", "offline", "done"].includes(pane.agent_status))) {
			pane = ensureWorkerPane(snapshot, info, worker);
			snapshot = herdrSnapshot();
			pane ||= findWorkerPane(snapshot, worker);
		}
		if (!pane) {
			results.push({ ok: false, role: worker.role, instance: worker.instance, error: "workspace/tab/pane dell'agente esterno non disponibile", source: worker.source });
			continue;
		}
		const instance = canonicalTabLabel(info, worker.role) || worker.instance || `${worker.role}-${slugifyProject(info.name)}`;
		let launched = launchAgentInPane(info, pane, worker.role, instance, traceMode, true, packageRoot);
		if (!launched.ok && /busy|available shell|non disponibile/i.test(launched.error || "")) {
			const workspace = snapshot?.workspaces?.find((item) => item.workspace_id === pane.workspace_id || item.label === workerWorkspaceLabel(worker.role));
			const freshPane = createProjectAgentPane(info, workspace, worker.role);
			if (freshPane) launched = launchAgentInPane(info, freshPane, worker.role, instance, traceMode, true, packageRoot);
		}
		results.push({ ...launched, source: worker.source, registry_status: worker.status });
		snapshot = herdrSnapshot();
	}
	return results;
}

function packageVersion(packageRoot) {
	try { return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version; } catch { return null; }
}

function checkUpdate() {
	const result = spawnSync("yano", ["update", "--check"], { encoding: "utf8", shell: process.platform === "win32" });
	const output = ((result.stdout || "") + (result.stderr || "")).trim();
	if (result.status !== 0) throw new Error("controllo aggiornamento fallito: " + (output || "errore sconosciuto"));
	return {
		ok: true,
		needed: /disponibile un aggiornamento|copia .* indietro/i.test(output),
		output,
	};
}

function applyUpdate(updateCheck, cwd) {
	if (!updateCheck?.needed) return { ok: true, checked: true, updated: false, output: updateCheck?.output || "" };
	const result = spawnSync("yano", ["update"], { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) throw new Error("aggiornamento Yano fallito; gli agenti restano fermi e lo snapshot è disponibile");
	return { ok: true, checked: true, updated: true };
}

function persistedArchitectProposals(info) {
	const dbPath = path.join(traceRoot(), "architect", "architect.sqlite");
	if (!fs.existsSync(dbPath)) return [];
	try {
		const sqlite = process.getBuiltinModule?.("node:sqlite");
		if (!sqlite?.DatabaseSync) return [];
		const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
		const rows = db.prepare("SELECT proposal_id, project_key, project_root, project_name, task, status, version, base_playbook, playbook_id, role_id, ephemeral_dir, playbook_path, manifest_path, architect_instance, watcher_workspace_id, watcher_tab_id, watcher_pane_id, validation_run_id, created_at, updated_at FROM architect_proposals WHERE project_root = ? ORDER BY updated_at DESC").all(info.root);
		db.close();
		return rows;
	} catch { return []; }
}

function migrateArchitectProposal(info, proposal) {
	const architectRoot = path.join(traceRoot(), "architect");
	const targetDir = path.join(architectRoot, "proposals", proposal.proposal_id);
	const canonicalArchitectInstance = "architect-" + slugifyProject(info.name);
	const sourceDir = proposal.ephemeral_dir ? path.resolve(proposal.ephemeral_dir) : null;
	if (sourceDir && sourceDir !== targetDir && fs.existsSync(sourceDir) && !fs.existsSync(targetDir)) {
		fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
		fs.cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true });
	}
	const playbookPath = fs.existsSync(path.join(targetDir, "playbook.yaml")) ? path.join(targetDir, "playbook.yaml") : proposal.playbook_path;
	const manifestPath = fs.existsSync(path.join(targetDir, "manifest.json")) ? path.join(targetDir, "manifest.json") : proposal.manifest_path;
	let manifest = null;
	if (manifestPath && fs.existsSync(manifestPath)) {
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			manifest.project = { ...(manifest.project || {}), name: info.name, root: info.root, key: info.key };
			fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
		} catch { /* malformed legacy manifest is reported by Architect itself */ }
	}
	// The manifest is the durable source of truth for a proposal's generated
	// playbook. Older registries could contain stale playbook/role fields even
	// though the generated manifest was already correct.
	const manifestPlaybook = manifest?.playbook_id || manifest?.playbook || null;
	const manifestRole = manifest?.role_id || manifest?.roles?.[0] || manifest?.role_manifests?.[0]?.id || null;
	const basePlaybook = manifest?.base_playbook || manifestPlaybook || proposal.base_playbook || null;
	const playbookId = manifestPlaybook || proposal.playbook_id || basePlaybook;
	const roleId = manifestRole || proposal.role_id || null;
	const sqlite = sqliteClass();
	if (!sqlite) return { ...proposal, project_name: info.name, project_key: info.key, architect_instance: canonicalArchitectInstance, ephemeral_dir: targetDir, playbook_path: playbookPath, manifest_path: manifestPath, base_playbook: basePlaybook, playbook_id: playbookId, role_id: roleId };
	let db = null;
	try {
		// This is the global Architect registry. `projectInfo().dbPath` is the
		// project orchestrator DB and is intentionally absent in projects that
		// only have an Architect proposal.
		const architectDbPath = path.join(traceRoot(), "architect", "architect.sqlite");
		db = new sqlite(architectDbPath);
		db.prepare("UPDATE architect_proposals SET project_key=?,project_root=?,project_name=?,base_playbook=?,playbook_id=?,role_id=?,architect_instance=?,ephemeral_dir=?,playbook_path=?,manifest_path=?,updated_at=? WHERE proposal_id=?").run(info.key, info.root, info.name, basePlaybook, playbookId, roleId, canonicalArchitectInstance, targetDir, playbookPath, manifestPath, new Date().toISOString(), proposal.proposal_id);
		return db.prepare("SELECT proposal_id,status,project_root,project_name,project_key,base_playbook,playbook_id,role_id,ephemeral_dir,playbook_path,manifest_path,architect_instance,watcher_workspace_id,watcher_tab_id,watcher_pane_id,validation_run_id,updated_at FROM architect_proposals WHERE proposal_id=?").get(proposal.proposal_id) || { ...proposal, project_name: info.name, project_key: info.key, architect_instance: canonicalArchitectInstance, ephemeral_dir: targetDir, playbook_path: playbookPath, manifest_path: manifestPath, base_playbook: basePlaybook, playbook_id: playbookId, role_id: roleId };
	} catch {
		return { ...proposal, project_name: info.name, project_key: info.key, architect_instance: canonicalArchitectInstance, ephemeral_dir: targetDir, playbook_path: playbookPath, manifest_path: manifestPath, base_playbook: basePlaybook, playbook_id: playbookId, role_id: roleId };
	} finally { try { db?.close(); } catch { /* best effort */ } }
}

function reprovisionArchitectProposals(info, proposals, packageRoot = PACKAGE_ROOT) {
	const results = [];
	const reprovisionable = new Set(["blocked", "provisioning", "provisioned", "ready", "operational", "ready_ephemeral", "promotion_candidate"]);
	for (const original of proposals.filter((proposal) => reprovisionable.has(proposal.status)).slice(0, 3)) {
		const proposal = migrateArchitectProposal(info, original);
		// Use the same package that is executing repair. Calling `yano` through
		// PATH could silently invoke an older global installation and recreate
		// the very Herdr prompt bug that repair is meant to fix.
		const result = spawnSync(process.execPath, [path.join(packageRoot, "bin", "yano.mjs"), "architect", "provision", "--proposal-id", proposal.proposal_id, "--install", "--json"], { cwd: info.root, encoding: "utf8", maxBuffer: 2_000_000 });
		const output = ((result.stdout || "") + (result.stderr || "")).trim();
		let provisioned = null;
		try { provisioned = JSON.parse(String(result.stdout || "").trim()); } catch { /* output is retained below */ }
		const watcherStarted = provisioned?.watcher && (provisioned.watcher.started === true || provisioned.watcher.already_running === true);
		const architectStarted = provisioned?.architect && (provisioned.architect.started === true || provisioned.architect.already_running === true);
		const operational = provisioned?.status === "ready_ephemeral" && provisioned?.operational === true && watcherStarted && architectStarted;
		results.push({
			proposal_id: proposal.proposal_id,
			ok: result.status === 0 && operational,
			status: provisioned?.status || proposal.status,
			operational,
			output,
		});
	}
	return results;
}

function usage() {
	console.log([
		"Uso: yano repair [opzioni]",
		"",
		"  yano repair                         anteprima read-only",
		"  yano repair --yes                   snapshot + stop controllato + riavvio di tutti gli agenti osservati",
		"  yano repair --yes --update          aggiorna anche Yano e pi update --extensions",
		"  yano repair --all-projects --dry-run inventario globale senza modifiche",
		"  yano repair --all-projects --yes   ripara sequenzialmente tutti i progetti attivi",
		"  yano repair --yes --force           forza i processi Herdr rimasti dopo il primo stop",
		"  yano repair --yes --init-db         crea in modo non distruttivo il DB orchestrator.db se manca",
		"  yano repair --json                  output machine-readable",
		"",
		"Non vengono cancellati codice, trace, worktree o database; solo copie di tab agente stale vengono chiuse dopo il riavvio canonico.",
	].join("\n"));
}

export async function runRepair({ cwd = process.cwd(), argv = [], packageRoot = PACKAGE_ROOT, quiet = false } = {}) {
	if (has(argv, "--help") || has(argv, "-h")) { usage(); return { help: true }; }
	if (has(argv, "--all-projects")) return runRepairAll({ cwd, argv, packageRoot, quiet });
	const info = projectInfo(cwd, argv);
	const broker = value(argv, "--broker") || process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
	const timeoutMs = Math.max(5_000, Number(value(argv, "--timeout") || DEFAULT_TIMEOUT_MS));
	const traceMode = value(argv, "--trace-mode") || process.env.YANO_TRACE_MODE || "full";
	const dryRun = !has(argv, "--yes") || has(argv, "--dry-run");
	const before = herdrSnapshot();
	const panes = activeProjectPanes(before, info.root);
	const aliases = aliasesFromSnapshot(before, panes, info.name);
	const presence = await discoverPresence(aliases, broker);
	const externalWorkers = externalWorkersForProject(info, before);
	const proposals = persistedArchitectProposals(info);
	const updateCheck = has(argv, "--update") ? checkUpdate() : null;
	const plan = {
		project: { name: info.name, root: info.root, key: info.key },
		aliases,
		package_version: packageVersion(packageRoot),
		database: { path: info.dbPath, exists: fs.existsSync(info.dbPath) },
		database_initialization: { requested: has(argv, "--init-db"), will_create: has(argv, "--init-db") && !fs.existsSync(info.dbPath) },
		herdr: { reachable: !!before, panes },
		presence,
		external_workers: externalWorkers,
		architect_proposals: proposals,
		architect_reprovision_candidates: proposals.filter((proposal) => ["blocked", "provisioning", "provisioned", "ready", "operational", "ready_ephemeral", "promotion_candidate"].includes(proposal.status)),
		will_update: has(argv, "--update"),
		update_check: updateCheck ? { ok: updateCheck.ok, needed: updateCheck.needed } : null,
		will_restart_agents: true,
		dry_run: dryRun,
	};
	if (dryRun) {
		if (!quiet && has(argv, "--json")) console.log(JSON.stringify(plan, null, 2));
		else if (!quiet) {
			console.log("yano repair: anteprima progetto \"" + info.name + "\"");
			console.log("   root: " + info.root);
			console.log("   alias MQTT: " + aliases.join(", "));
			console.log("   database: " + (fs.existsSync(info.dbPath) ? "presente" : "assente"));
			if (has(argv, "--init-db")) console.log("   inizializzazione DB: " + (fs.existsSync(info.dbPath) ? "nessuna, già presente" : "verrà creato con --yes"));
			console.log("   agenti Herdr: " + (panes.map((pane) => pane.instance || pane.pane_id).join(", ") || "nessuno"));
			console.log("   presence MQTT: " + (presence.cards.map((card) => card.scope + "/" + card.instance).join(", ") || "nessuna"));
			console.log("   proposte Architect: " + proposals.length);
			console.log("   proposte Architect da ri-provisionare: " + plan.architect_reprovision_candidates.length);
			console.log("   piano: snapshot -> stop controllato -> " + (has(argv, "--update") ? "update -> " : "") + "riavvio agenti -> verifica");
			console.log("   nessuna modifica eseguita: aggiungi --yes per applicare.");
		}
		return plan;
	}

	if (!before) throw new Error("Herdr non raggiungibile; avvia Herdr prima di riparare il progetto");
	if (!commandExists("herdr")) throw new Error("Herdr non trovato sul PATH");
	const snapshot = writeRepairSnapshot(info, {
		aliases,
		herdr: before,
		presence,
		packageVersion: packageVersion(packageRoot),
		options: { update: has(argv, "--update"), force: has(argv, "--force"), timeout_ms: timeoutMs },
	});
	if (!quiet) console.log("yano repair: snapshot salvato in " + snapshot.directory);
	const databaseInitialization = has(argv, "--init-db")
		? ensureProjectDatabase({ projectRoot: info.root, project: info.name, packageRoot })
		: null;

	const livePresence = presence.live_cards || presence.cards.filter(isLivePresenceCard);
	const termination = await terminatePresence(livePresence, broker, "yano repair: riallineamento progetto " + info.name + "; snapshot " + snapshot.directory);
	const expectedOffline = new Set(livePresence.map((card) => card.scope + "/" + card.instance));
	const offline = await waitForOffline(aliases, broker, expectedOffline, timeoutMs);
	if (!offline.ok && !has(argv, "--force")) {
		throw new Error("agenti ancora online dopo lo stop controllato: " + offline.remaining.join(", ") + ". Usa --force solo per interromperli.");
	}

	let afterStop = herdrSnapshot();
	let remaining = activeProjectPanes(afterStop, info.root);
	if (remaining.length) {
		for (const pane of remaining) sendPaneKeys(pane.pane_id, ["ctrl-c"]);
		await sleep(500);
		remaining = activeProjectPanes(herdrSnapshot(), info.root);
		if (remaining.length && !has(argv, "--force")) {
			throw new Error("Herdr non ha liberato le pane " + remaining.map((pane) => pane.pane_id).join(", ") + "; usa --force per forzare.");
		}
		if (remaining.length && has(argv, "--force")) for (const pane of remaining) sendPaneKeys(pane.pane_id, ["ctrl-c", "ctrl-d"]);
	}
	const stoppedExternal = stopExternalWorkerPanes(before, externalWorkers, panes);
	if (stoppedExternal.length) {
		await sleep(500);
		const stillRunningExternal = stoppedExternal.filter((worker) => {
			const pane = findWorkerPane(herdrSnapshot(), worker);
			return pane?.agent === "pi" && !["unknown", "offline", "done"].includes(pane.agent_status);
		});
		if (stillRunningExternal.length && !has(argv, "--force")) {
			throw new Error("worker esterni ancora attivi dopo lo stop controllato: " + stillRunningExternal.map((worker) => worker.instance).join(", ") + ". Usa --force solo per interromperli.");
		}
		if (stillRunningExternal.length && has(argv, "--force")) for (const worker of stillRunningExternal) sendPaneKeys(worker.pane_id, ["ctrl-c", "ctrl-d"]);
	}

	const update = has(argv, "--update") ? applyUpdate(updateCheck, info.root) : null;

	const projectWorkspace = ensureProjectWorkspace(herdrSnapshot(), info);
	let restarted = restartObservedAgents(info, panes, traceMode, projectWorkspace, packageRoot);
	// Workers already observed in a project pane are restarted by the same
	// canonical path as Planner/Architect/Watcher. Do not run them a second
	// time through the registry path: that used to relaunch into an already
	// active pane and was a source of duplicate tabs.
	const restartedRoles = new Set(restarted.filter((item) => item.ok).map((item) => item.role));
	const unobservedWorkers = externalWorkers.filter((worker) => !restartedRoles.has(worker.role));
	const restartedExternal = restartExternalWorkers(info, unobservedWorkers, traceMode, packageRoot);
	restarted = [...restarted, ...restartedExternal];
	let launched = restarted.find((item) => item.ok && item.role === "planner") || null;
	if (!launched) {
		const pane = ensurePlannerPane(herdrSnapshot(), info, projectWorkspace);
		launched = launchPlanner(info, pane, traceMode, false, packageRoot);
		restarted.push(launched);
	}
	if (!launched.ok) throw new Error("Planner non rilanciato (" + (launched.error || "errore sconosciuto") + "); snapshot: " + snapshot.directory);
	const duplicateTabs = await closeDuplicateProjectTabs(info, restarted, has(argv, "--force"));

	const expectedInstances = new Set(restarted.filter((item) => item.ok).map((item) => item.instance));
	let verification = await discoverPresence([info.name], broker);
	if (verification.ok) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && ![...expectedInstances].every((instance) => verification.cards.some((card) => card.instance === instance && isLivePresenceCard(card)))) {
			await sleep(500);
			verification = await discoverPresence([info.name], broker);
		}
	} else {
		verification.skipped = "broker_unavailable";
	}
	const reprovision = has(argv, "--no-reprovision") ? [] : reprovisionArchitectProposals(info, proposals, packageRoot);
	const result = { ...plan, dry_run: false, snapshot: snapshot.directory, database_initialization: databaseInitialization || { requested: false, created: false, exists: fs.existsSync(info.dbPath), path: info.dbPath }, termination, offline, update, restarted, launched, duplicate_tabs_closed: duplicateTabs, verification, reprovision };
	result.stopped_external = stoppedExternal;
	if (!quiet && has(argv, "--json")) console.log(JSON.stringify(result, null, 2));
	else if (!quiet) {
		console.log("yano repair: " + restarted.filter((item) => item.ok).length + " agente/i rilanciato/i; Planner nella pane " + launched.pane_id + ".");
		console.log("   scope verificato: " + info.name);
		console.log("   agenti live: " + (verification.live_cards || verification.cards.filter(isLivePresenceCard)).map((card) => card.instance).join(", "));
		if (reprovision.length) console.log("   Architect: " + reprovision.filter((item) => item.ok).length + "/" + reprovision.length + " proposte ri-provisionate.");
		console.log("   copie duplicate chiuse: " + duplicateTabs.length + "; nessun file applicativo, trace o database è stato cancellato.");
	}
	return result;
}

async function runRepairAll({ cwd = process.cwd(), argv = [], packageRoot = PACKAGE_ROOT, quiet = false } = {}) {
	const broker = value(argv, "--broker") || process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
	const before = herdrSnapshot();
	const workers = externalWorkerRows(before);
	const allPresence = await discoverAllPresence(broker);
	const presenceSummary = {
		ok: allPresence.ok,
		broker: allPresence.broker,
		cards: allPresence.live_cards || [],
		live_count: (allPresence.live_cards || []).length,
		stale_count: (allPresence.stale_cards || []).length,
		error: allPresence.error || null,
	};
	const roots = collectRepairProjectRoots(before, workers);
	const projects = roots.map((root) => {
		const info = projectInfo(root, ["--project-root", root]);
		const architectProposals = persistedArchitectProposals(info);
		return {
			name: info.name,
			root: info.root,
			key: info.key,
			database: { path: info.dbPath, exists: fs.existsSync(info.dbPath) },
			database_initialization: { requested: has(argv, "--init-db"), will_create: has(argv, "--init-db") && !fs.existsSync(info.dbPath) },
			external_workers: workers.filter((worker) => worker.root === info.root),
			architect_proposals: architectProposals,
			architect_reprovision_candidates: architectProposals.filter((proposal) => ["blocked", "provisioning", "provisioned", "ready", "operational", "ready_ephemeral", "promotion_candidate"].includes(proposal.status)),
		};
	});
	const dryRun = !has(argv, "--yes") || has(argv, "--dry-run");
	const updateCheck = has(argv, "--update") ? checkUpdate() : null;
	const plan = {
		mode: "all-projects",
		broker,
		herdr_reachable: !!before,
		projects,
		presence: presenceSummary,
		update_check: updateCheck ? { ok: updateCheck.ok, needed: updateCheck.needed } : null,
		dry_run: dryRun,
		safety: "projects are processed sequentially; each project gets its own repair snapshot; only stale duplicate agent tabs may be closed after canonical restart",
	};
	if (dryRun) {
		if (!quiet && has(argv, "--json")) console.log(JSON.stringify(plan, null, 2));
		else if (!quiet) {
			console.log("yano repair: anteprima globale");
			console.log("   progetti attivi rilevati: " + (projects.map((project) => project.name + " (" + project.root + ")").join(", ") || "nessuno"));
			console.log("   agenti esterni registrati: " + (workers.map((worker) => worker.instance + " -> " + worker.name).join(", ") || "nessuno"));
			const proposals = projects.flatMap((project) => project.architect_reprovision_candidates.map((proposal) => project.name + "/" + proposal.proposal_id + " (" + proposal.status + ")"));
			console.log("   proposte Architect da ri-provisionare: " + (proposals.join(", ") || "nessuna"));
			console.log("   presence MQTT live: " + presenceSummary.live_count + " (stale/offline ignorate: " + presenceSummary.stale_count + ")");
			console.log("   nessuna modifica eseguita: aggiungi --yes per applicare.");
		}
		return plan;
	}
	if (!before) throw new Error("Herdr non raggiungibile; avvia Herdr prima di riparare tutti i progetti");
	const update = has(argv, "--update") ? applyUpdate(updateCheck, cwd) : null;
	const childArgv = argv.filter((arg) => !["--all-projects", "--update", "--json"].includes(arg));
	const repaired = [];
	for (const project of projects) {
		const result = await runRepair({ cwd: project.root, argv: [...childArgv, "--project-root", project.root], packageRoot, quiet: true });
		repaired.push(result);
	}
	const result = { ...plan, dry_run: false, update, repaired };
	if (!quiet && has(argv, "--json")) console.log(JSON.stringify(result, null, 2));
	else if (!quiet) console.log("yano repair: ripristino globale completato per " + repaired.length + " progetto/i.");
	return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runRepair({ cwd: process.cwd(), argv: process.argv.slice(2) }).catch((error) => { console.error("yano repair: " + error.message); process.exit(1); });
