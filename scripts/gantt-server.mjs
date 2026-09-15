#!/usr/bin/env node
// `yano gantt` / `yano web` — live Gantt view of orchestration state (Ticket 11).
//
// A tiny self-contained web server (Node http + a minimal WebSocket upgrade
// handshake — no npm dependencies, no websocket lib) that serves a single-page
// Gantt timeline of this project's runs/tickets/phases from the on-disk
// orchestrator.db, and streams MQTT orchestration events live so the view
// updates as agents publish "something happened".
//
// - GET /            → HTML+JS page that renders the timeline
// - GET /data        → JSON snapshot of runs/tickets/holds from SQLite
// - GET /healthz     → { ok: true }
// - WebSocket /ws    → pushes a fresh snapshot on every MQTT run-event
//
// read-only: never modifies DB/tickets/worktrees. `yano gantt --open` opens the
// browser.
//
// Uso:
//   yano gantt [--port 10000..19999] [--open] [--project <slug>]
//   (in locale: node scripts/gantt-server.mjs [stesse opzioni])

import { readFileSync, existsSync } from "node:fs";
import * as http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import mqtt from "mqtt";
import { projectTimeline } from "./yano-timeline.mjs";
import { projectDbPath } from "./yano-project.mjs";
import { projectKey } from "./yano-trace-storage.mjs";
import { ganttRegistryPath, listGanttsWithStatus, markGanttStopped, registerGantt } from "./gantt-registry.mjs";

const yanoRequire = createRequire(import.meta.url);
export const GANTT_PORT_MIN = 10000;
export const GANTT_PORT_MAX = 19999;

function workspaceDir(cwd) { return path.join(cwd, ".pi", "extensions", "yano-orchestrator"); }
function resolveProject(cwd) {
	try { const cfg = JSON.parse(readFileSync(path.join(workspaceDir(cwd), "config", "project.json"), "utf-8")); if (cfg.project) return cfg.project; } catch { /* */ }
	try { const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")); if (pkg.name && !String(pkg.name).startsWith("@otomatik/yano-")) return pkg.name; } catch { /* */ }
	return path.basename(cwd);
}

function requestedPort(argv) {
	const index = argv.indexOf("--port");
	if (index < 0) return null;
	const value = Number(argv[index + 1]);
	if (!Number.isInteger(value) || value < GANTT_PORT_MIN || value > GANTT_PORT_MAX) {
		throw new Error(`la porta Gantt deve essere un intero nel range ${GANTT_PORT_MIN}-${GANTT_PORT_MAX}`);
	}
	return value;
}

// Start from a stable project-specific slot, then wrap through the range. The
// actual server bind is the availability check, so two concurrent invocations
// cannot both claim the same port between a probe and listen().
function candidatePorts(project) {
	const size = GANTT_PORT_MAX - GANTT_PORT_MIN + 1;
	const digest = crypto.createHash("sha256").update(String(project || "gantt")).digest();
	const preferred = digest.readUInt32BE(0) % size;
	return Array.from({ length: size }, (_, offset) => GANTT_PORT_MIN + ((preferred + offset) % size));
}

function listenOnAvailablePort(server, ports, host) {
	return new Promise((resolve, reject) => {
		let index = 0;
		const attempt = () => {
			const port = ports[index++];
			const onError = (error) => {
				server.removeListener("error", onError);
				if (error.code === "EADDRINUSE" && index < ports.length) return attempt();
				reject(error);
			};
			server.once("error", onError);
			server.listen(port, host, () => {
				server.removeListener("error", onError);
				resolve(server.address().port);
			});
		};
		attempt();
	});
}

// ── Snapshot: runs + tickets + open holds from orchestrator.db ───────────
export function buildSnapshot(cwd, explicitProject = null) {
	const project = explicitProject || resolveProject(cwd);
	const dbPath = projectDbPath(cwd, project);
	if (!existsSync(dbPath)) return { project, runs: [], ok: false, db_path: dbPath, hint: "Run `yano repair --yes --init-db`, then let Planner call orchestrator_init/run_create." };
	let DatabaseSync;
	try { ({ DatabaseSync } = yanoRequire("node:sqlite")); } catch { return { project, runs: [], ok: false, db_path: dbPath, error: "node:sqlite unavailable" }; }
	const db = new DatabaseSync(dbPath, { readOnly: true });
	// The project display name is user-facing and may preserve casing
	// (`newMioDOC`), while the orchestrator scope persisted by the planner is
	// normalized (`newmiodoc`). The DB is the authoritative source; matching
	// case-insensitively prevents a valid project dashboard from appearing
	// empty merely because the display casing differs.
	const runs = db.prepare("SELECT * FROM runs WHERE lower(project) = lower(?) ORDER BY created_at ASC").all(project);
	const enriched = runs.map((r) => {
		const tickets = db.prepare("SELECT * FROM tickets WHERE run_id = ? ORDER BY created_at ASC").all(r.id);
		const holds = db.prepare("SELECT * FROM decision_holds WHERE run_id = ? AND status='open'").all(r.id);
		const dependencies = db.prepare("SELECT d.* FROM ticket_dependencies d JOIN tickets t ON t.id=d.ticket_id WHERE t.run_id=?").all(r.id);
		return { ...r, tickets, dependencies, open_holds: holds };
	});
	db.close();
	return { project, runs: enriched, ...projectTimeline(cwd), generated_at: new Date().toISOString(), ok: true };
}

function handleUpgrade(req, socket, head, wss) {
	const url = req.url.split("?")[0];
	if (url !== "/ws") { socket.destroy(); return; }
	const key = req.headers["sec-websocket-key"];
	if (!key) { socket.destroy(); return; }
	const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
	socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
	wss.add(socket);
	// frames are text (opcode 0x81). We only ever SEND; incoming is ignored for
	// this simple view (client may send pings; parse-opcode below is sender-only).
}
function wsSend(socket, obj) {
	try {
		const payload = Buffer.from(JSON.stringify(obj));
		const header = Buffer.alloc(payload.length > 65535 ? 10 : payload.length > 125 ? 4 : 2);
		if (payload.length > 65535) { header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
		else if (payload.length > 125) { header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
		else { header[0] = 0x81; header[1] = payload.length; }
		socket.write(Buffer.concat([header, payload]));
	} catch { /* ignore */ }
}
function wsBroadcast(wss, obj) { for (const s of wss) { if (!s.destroyed) wsSend(s, obj); } }

function projectRootFromArgs(cwd, argv) {
	const value = argv.includes("--project-root") ? argv[argv.indexOf("--project-root") + 1] : (argv.includes("--cwd") ? argv[argv.indexOf("--cwd") + 1] : cwd);
	return path.resolve(value || cwd);
}

async function showGanttLinks({ cwd, argv }) {
	const all = await listGanttsWithStatus();
	const allProjects = argv.includes("--links") || argv.includes("--list");
	if (allProjects) {
		const result = { registry_path: ganttRegistryPath(), instances: all, project_count: all.length };
		if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
		else {
			console.log(`yano gantt: ${all.length} dashboard registrata (${ganttRegistryPath()})`);
			for (const entry of all) console.log(`  ${entry.project} — ${entry.active ? "attivo" : "fermo"} — ${entry.url}`);
			if (!all.length) console.log("  nessun Gantt persistente registrato.");
		}
		return result;
	}

	const useCwd = projectRootFromArgs(cwd, argv);
	const project = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : resolveProject(useCwd);
	const key = projectKey(useCwd, project);
	const entry = all.find((item) => item.project_key === key);
	const result = { registry_path: ganttRegistryPath(), project, root: useCwd, found: !!entry, instance: entry || null };
	if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
	else if (entry) console.log(`yano gantt: ${project} — ${entry.active ? "attivo" : "fermo"} — ${entry.url}`);
	else console.log(`yano gantt: nessun Gantt persistente registrato per ${project} (${useCwd}). Usa yano gantt --persistent --open per avviarlo.`);
	return result;
}

// ── Minimal SPA that renders the timeline ─────────────────────────────────
const PAGE = readFileSync(new URL("./gantt.html", import.meta.url), "utf8");

export async function runGantt({ cwd, argv, packageRoot }) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log([
			"Uso: yano gantt [--project-root <dir>] [--project <nome>] [opzioni]",
			"",
			"  --persistent  registra il link nel data-root globale e impedisce duplicati dello stesso progetto",
			"  --link        mostra il link persistente del progetto corrente senza avviare un server",
			"  --links       elenca tutti i link Gantt persistenti e il loro stato live",
			"  --open         apre il link nel browser",
			`  --port <porta> porta esplicita nel range ${GANTT_PORT_MIN}-${GANTT_PORT_MAX}; senza flag viene scelta automaticamente`,
			"  --once         avvia una verifica HTTP e termina (test/health probe)",
		].join("\n"));
		return { ok: true, help: true };
	}
	const explicitPort = requestedPort(argv);
	if (argv.includes("--link") || argv.includes("--links") || argv.includes("--list")) return showGanttLinks({ cwd, argv });
	const useCwd = projectRootFromArgs(cwd, argv);
	const project = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : resolveProject(useCwd);
	const open = argv.includes("--open");
	const dbg = argv.includes("--once"); // one snapshot + exit (for tests / health probes)
	const persistent = argv.includes("--persistent");
	const identity = projectKey(useCwd, project);
	if (persistent) {
		const existing = (await listGanttsWithStatus()).find((entry) => entry.project_key === identity && entry.active);
		if (existing) {
			console.log(`yano gantt: ${project} è già attivo su ${existing.url} (usa yano gantt --link per recuperarlo).`);
			return { existing: true, project, port: existing.port, base: existing.url, instance: existing };
		}
	}

	let cachedSnapshot, cachedAt = 0;
    const currentSnapshot = () => {
        if (!cachedSnapshot || Date.now() - cachedAt >= 5000) {
            cachedSnapshot = buildSnapshot(useCwd, project);
            cachedAt = Date.now();
        }
        return cachedSnapshot;
    };
	const wss = new Set();
	const mqttClients = new Set();
	const server = http.createServer((req, res) => {
		const url = (req.url || "/").split("?")[0];
		if (url === "/" || url === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
		if (url === "/data") { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(currentSnapshot())); return; }
		if (url === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, project, root: useCwd, port: server.address()?.port || null })); return; }
		res.writeHead(404); res.end("not found");
	});
	server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, wss));
	// Cleanup stray sockets on close
	server.on("close", () => { for (const s of wss) { try { s.destroy(); } catch {} } });

	// Subscribe to MQTT run-events for this project and broadcast snapshots on any.
	const broker = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
	const client = mqtt.connect(broker, { clean: true, reconnectPeriod: 3000 });
	mqttClients.add(client);
	client.on("connect", () => { try { client.subscribe(`pi/${projectKey(useCwd, project)}/runs/+/events`, { qos: 0 }); } catch {} });
	client.on("message", () => { wsBroadcast(wss, currentSnapshot()); });
	client.on("error", () => { /* broker optional; HTTP still serves /data */ });

	const host = "127.0.0.1";
	return new Promise((resolve, reject) => {
		listenOnAvailablePort(server, explicitPort ? [explicitPort] : candidatePorts(project), host).then((port) => {
			const base = `http://${host}:${port}`;
			if (persistent) {
				registerGantt({ projectKey: identity, project, root: useCwd, port, url: base });
				server.once("close", () => markGanttStopped(identity));
			}
			console.log(`yano gantt — orchestrator view: ${base}/   (project: ${project})`);
			if (open) {
				try {
					const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
					const { execFile } = yanoRequire("node:child_process");
					execFile(cmd, [base], () => {});
				} catch { /* best-effort */ }
			}
			// Resolve immediately with handles; the listening server keeps the
			// process alive for a CLI invocation (yano gantt), and an embedded
			// caller (test / probe) can close when it's done. --once makes the
			// CLI variant exit right after one health probe instead of staying up.
			if (dbg) {
				http.get(`${base}/healthz`, () => { server.close(); try { client.end(true); } catch {} });
			}
			resolve({ server, client, base, project, port });
		}).catch((error) => {
			try { client.end(true); } catch { /* best effort */ }
			reject(error);
		});
	});
}

// Direct invocation
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	runGantt({ cwd: process.cwd(), argv: process.argv.slice(2) }).catch((e) => { console.error(e); process.exit(1); });
}
