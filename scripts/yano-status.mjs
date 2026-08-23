#!/usr/bin/env node
// `yano status` / `yano logs` / `yano fleet` / `yano mcp` / `yano skills` /
// `yano doctor --network` — informazioni di sola lettura sul progetto e
// sull'orchestrazione, senza aprire una sessione `pi` (Ticket 12).
//
// Tutti sono read-only: non modificano DB, ticket, worktree o file. Dove serve
// un broker MQTT (fleet, e le health) lo fanno in modo best-effort: se il
// broker non è raggiungibile lo dicono, non falliscono.
//
// Uso:
//   yano status                   stato run/ticket del progetto (SQLite)
//   yano status --run <id>        dettaglio di un singolo run
//   yano status --project <scope> stato per uno scope MQTT esplicito
//   yano logs [instance]          ultime righe del log JSONL di un'istanza
//   yano logs --project <scope>   log per uno scope MQTT esplicito
//   yano fleet [--project <scope>] lista agenti live dal broker (retained presence)
//   yano mcp [role]               MCP dichiarati per ruolo/istanza (mcp.json + roles)
//   yano skills [role]            skill dichiarate per ruolo/istanza (roles.yaml/agents.yaml)
//   yano doctor --network         verifica raggiungibilità broker + git + pi
//
// (in locale: node scripts/yano-status.mjs <sub> [opzioni])

import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import mqtt from "mqtt";
import { slugify, tracePaths } from "./yano-trace-storage.mjs";
import { projectConfig, projectDbPath, resolveYanoWorkspaceDir } from "./yano-project.mjs";

const yanoRequire = createRequire(import.meta.url);

function workspaceDir(cwd) {
	return resolveYanoWorkspaceDir(cwd);
}

function optionValue(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}

function applyDataDir(argv) {
	const dataDir = optionValue(argv, "--data-dir");
	if (dataDir) process.env.YANO_DATA_DIR = path.resolve(dataDir);
}

function positionalArg(argv) {
	const valueFlags = new Set(["--project", "--run", "--data-dir"]);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (valueFlags.has(arg)) { index++; continue; }
		if (!arg.startsWith("-")) return arg;
	}
	return null;
}

function resolveProject(cwd, argv = []) {
	const explicit = optionValue(argv, "--project");
	if (explicit?.trim()) return explicit.trim();
	try {
		const cfg = projectConfig(cwd).config;
		if (cfg.project) return slugify(cfg.project);
	} catch { /* fallthrough */ }
	try {
		const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8"));
		if (pkg.name && !String(pkg.name).startsWith("@otomatik/yano-")) return slugify(pkg.name);
	} catch { /* fallthrough */ }
	return slugify(path.basename(cwd));
}

function loadYamlOrNull(file) { try { if (!existsSync(file)) return null; return parseYaml(readFileSync(file, "utf-8")); } catch { return null; } }

function runStatus(cwd, argv) {
	const dbPath = projectDbPath(cwd, optionValue(argv, "--project"));
	if (!existsSync(dbPath)) { console.log("yano status: nessun orchestrator.db per questo progetto — niente da mostrare."); return; }
	let DatabaseSync;
	try { ({ DatabaseSync } = yanoRequire("node:sqlite")); } catch (e) { console.error(`yano status: node:sqlite non disponibile (${e.message})`); process.exit(1); }
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const runId = optionValue(argv, "--run");
	const project = resolveProject(cwd, argv);
	const runs = runId
		? (db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) ? [db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)] : [])
		: db.prepare("SELECT * FROM runs WHERE project = ? ORDER BY created_at DESC").all(project);
	if (!runs.length) { console.log(`yano status: nessun run ${runId ? `"${runId}"` : "per questo progetto"}.`); db.close(); return; }
	for (const r of runs) {
		const tickets = db.prepare("SELECT * FROM tickets WHERE run_id = ? ORDER BY created_at ASC").all(r.id);
		const counts = tickets.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
		const holds = db.prepare("SELECT * FROM decision_holds WHERE run_id = ? AND status = 'open'").all(r.id);
		console.log(`\n${r.id} "${r.title || r.objective}" [${r.status}]`);
		console.log(`   tickets: ${tickets.length} (${["done","running","pending","blocked","failed","cancelled"].filter((s) => counts[s]).map((s) => `${s}:${counts[s]}`).join(" ") || "0"})`);
		if (holds.length) console.log(`   ⚠️ ${holds.length} decision hold aperte: ${holds.map((h) => `"${h.question}"`).join(", ")}`);
	}
	db.close();
}

function runLogs(cwd, argv) {
	const instance = positionalArg(argv);
	const logsDir = tracePaths({ cwd, project: resolveProject(cwd, argv) }).eventsDir;
	if (!existsSync(logsDir)) { console.log("yano logs: nessuna directory logs per questo progetto."); return; }
	const files = fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")).sort();
	if (!instance) {
		console.log(files.length ? `yano logs: ${files.length} log disponibili:` : "yano logs: nessun log.");
		files.forEach((f) => console.log(`   ${f}`));
		return;
	}
	const file = path.join(logsDir, instance.endsWith(".jsonl") ? instance : `${instance}.jsonl`);
	if (!existsSync(file)) { console.log(`yano logs: nessun log per "${instance}".`); return; }
	const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-50);
	console.log(lines.join("\n"));
}

function runFleet(cwd, argv) {
	const project = resolveProject(cwd, argv);
	const broker = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
	const staleAfterMs = Number(process.env.PI_ORCH_STALE_AFTER_MS) || 45_000;
	return new Promise((resolve) => {
		const client = mqtt.connect(broker, { clean: true, reconnectPeriod: 0 });
		const timeout = setTimeout(() => { console.error(`yano fleet: broker ${broker} non raggiungibile.`); try { client.end(true); } catch { /* ignore */ } resolve(); }, 3000);
		client.once("connect", () => {
			clearTimeout(timeout);
			const agents = new Map();
			client.on("message", (_t, payload) => { try { const c = JSON.parse(payload.toString()); if (c?.instance) agents.set(c.instance, c); } catch { /* ignore */ } });
			client.subscribe(`pi/${project}/agents/+/status`, { qos: 0 }, () => {
				setTimeout(() => {
					const now = Date.now();
					const live = [...agents.values()].filter((a) => {
						if (a.status === "offline") return false;
						const heartbeat = Date.parse(a.last_heartbeat || "");
						return Number.isFinite(heartbeat) && now - heartbeat <= staleAfterMs;
					});
					const ignored = agents.size - live.length;
					if (!live.length) {
						console.log(`yano fleet: nessun agente live per il progetto "${project}"${ignored ? ` (${ignored} card retained offline/stale ignorate)` : ""}.`);
					} else {
						console.log(`yano fleet: ${live.length} agente/i live nel progetto "${project}":`);
						live.forEach((a) => console.log(`   ${a.instance} (${a.role}) ${a.status} team=[${(a.team || []).join(",")}]`));
						if (ignored) console.log(`   (${ignored} card retained offline/stale ignorate)`);
					}
					try { client.end(true); } catch { /* ignore */ }
					resolve();
				}, 600);
			});
		});
	});
}

function runMcp(cwd, argv) {
	const project = resolveProject(cwd, argv);
	const dir = path.join(cwd, ".pi");
	const mcpJson = loadYamlOrNull(path.join(cwd, "mcp.json")) || loadYamlOrNull(path.join(dir, "mcp.json")) || {};
	const servers = Object.keys(mcpJson.mcpServers ?? mcpJson);
	const rolesDoc = loadYamlOrNull(path.join(cwd, "agents", "roles.yaml"));
	const agentsDoc = loadYamlOrNull(path.join(cwd, "agents", "agents.yaml"));
	const roleFilter = positionalArg(argv);
	console.log(`yano mcp — server dichiarati per il progetto "${project}":`);
	if (!servers.length) console.log("   (nessun server MCP dichiarato in mcp.json)");
	servers.forEach((s) => console.log(`   • ${s}`));
	// Per-role mcp declarations from roles.yaml/agents.yaml
	if (rolesDoc?.roles) {
		const entries = Object.entries(rolesDoc.roles).filter(([r, c]) => !roleFilter || r === roleFilter);
		entries.forEach(([r, c]) => {
			const mcp = (c?.mcp ?? []).join(", ");
			if (mcp) console.log(`   [${r}] mcp: ${mcp}`);
		});
	}
	if (agentsDoc?.agents) {
		Object.entries(agentsDoc.agents).forEach(([inst, c]) => {
			const mcp = (c?.mcp ?? []).join(", ");
			if (mcp && (!roleFilter || c.role === roleFilter)) console.log(`   [${inst}] mcp: ${mcp}`);
		});
	}
}

function runSkills(cwd, argv) {
	const project = resolveProject(cwd, argv);
	const rolesDoc = loadYamlOrNull(path.join(cwd, "agents", "roles.yaml"));
	const agentsDoc = loadYamlOrNull(path.join(cwd, "agents", "agents.yaml"));
	const roleFilter = positionalArg(argv);
	console.log(`yano skills — skill per ruolo/istanza nel progetto "${project}":`);
	if (rolesDoc?.roles) {
		Object.entries(rolesDoc.roles)
			.filter(([r]) => !roleFilter || r === roleFilter)
			.forEach(([r, c]) => { const s = (c?.skills ?? []).join(", "); if (s) console.log(`   [${r}] ${s}`); });
	}
	if (agentsDoc?.agents) {
		Object.entries(agentsDoc.agents).forEach(([inst, c]) => {
			const s = (c?.skills ?? []).join(", ");
			if (s && (!roleFilter || c.role === roleFilter)) console.log(`   [${inst}] ${s}`);
		});
	}
}

function tcpReachable(host, port, timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (ok) => { socket.destroy(); resolve(ok); };
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

function cmdExists(cmd, args = ["--version"]) {
	try { const r = spawnSync(cmd, args, { stdio: "ignore" }); return !r.error || r.error.code !== "ENOENT"; } catch { return false; }
}

async function runDoctorNetwork(cwd, argv = []) {
	console.log(`yano doctor --network — progetto "${resolveProject(cwd, argv)}"\n`);
	const rows = [];
	const brokerUp = await tcpReachable("127.0.0.1", 1883);
	rows.push(["broker 127.0.0.1:1883", brokerUp]);
	rows.push(["git", cmdExists("git")]);
	rows.push(["pi", cmdExists("pi")]);
	for (const [name, good] of rows) console.log(`   ${good ? "✓" : "✗"} ${name}`);
	console.log(brokerUp ? "\nAmbiente OK." : "\nBroker non raggiungibile sul 1883 (Docker/mosquitto?).");
	return { ok: brokerUp };
}

const SUBCOMMANDS = ["status", "logs", "fleet", "mcp", "skills"];

export async function runYanoStatus({ cwd, argv }) {
	applyDataDir(argv);
	const sub = argv[0];
	const subArgs = argv.slice(1);
	if (sub === "status") return runStatus(cwd, subArgs);
	if (sub === "logs") return runLogs(cwd, subArgs);
	if (sub === "fleet") return await runFleet(cwd, subArgs);
	if (sub === "mcp") return runMcp(cwd, subArgs);
	if (sub === "skills") return runSkills(cwd, subArgs);
	if (sub === "doctor" && subArgs.includes("--network")) return runDoctorNetwork(cwd, subArgs);
	console.log("yano: usa `yano status`, `yano logs`, `yano fleet`, `yano mcp`, `yano skills`, o `yano doctor --network`.");
	process.exit(1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	runYanoStatus({ cwd: process.cwd(), argv: process.argv.slice(2) }).catch((e) => { console.error(e); process.exit(1); });
}
