#!/usr/bin/env node

// Single always-on process serving both the unified bug/suggestion Kanban UI
// and the feedback REST API it talks to. Replaces the old, separately-ported
// bug-dash (11000-11999) and suggest-dash (12000-12999) processes with one
// process on one port range.
// See docs/superpowers/specs/2026-09-07-yano-dash-design.md.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDatabase, handleFeedbackApi, listFeedback, getFeedback, listFeedbackAudit, repairFeedbackScreenshots, createAgentationFeedback, dbPath } from "./yano-feedback.mjs";
import { projectKey, resolveTraceProject } from "./yano-trace-storage.mjs";
import { listWatcherProjectRows, pruneMissingWatcherProjects } from "./yano-watcher-registry.mjs";
import { DASH_PORT, readDashState, writeDashState, processAlive } from "./yano-dash-state.mjs";
import { sendGlobalNotification } from "./yano-notify.mjs";

const UI_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "dash-ui");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] || null : null;
}

function projectRootFrom(cwd) {
	let current = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(current, "agents")) || fs.existsSync(path.join(current, ".yano")) || fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

export function watcherProjectCatalog(rows, { exists = fs.existsSync } = {}) {
	const projects = new Map();
	const temporaryRoot = (root) => {
		const value = path.resolve(root);
		return value.startsWith(`${path.sep}private${path.sep}tmp${path.sep}`)
			|| value.startsWith(`${path.sep}private${path.sep}var${path.sep}folders${path.sep}`)
			|| value.startsWith(`${path.sep}var${path.sep}folders${path.sep}`)
			|| value.includes(`${path.sep}yano-orchestrator${path.sep}temp${path.sep}`)
			|| value.includes(`${path.sep}.worktreesXYZ`);
	};
	const add = (root, name = null) => {
		if (!root || !exists(root)) return;
		const resolvedRoot = path.resolve(root);
		if (temporaryRoot(resolvedRoot)) return;
		const id = projectKey(resolvedRoot, name || resolveTraceProject(resolvedRoot));
		const label = name || resolveTraceProject(resolvedRoot);
		if (!projects.has(id)) projects.set(id, { id, name: label, root: resolvedRoot });
	};
	try {
		for (const item of rows) {
			// The dashboard project switcher represents the projects currently
			// followed by a live watcher, not historical trace/memory projects.
			if (item.worker_status === "running" && item.root) add(item.root, item.name);
		}
	} catch { /* dashboard remains usable if watcher registry is unavailable */ }
	return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function projectCatalog() {
	pruneMissingWatcherProjects();
	return watcherProjectCatalog(listWatcherProjectRows());
}

function send(res, status, data, type = "application/json; charset=utf-8") {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...(type.startsWith("application/json") ? { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-yano-user" } : {}) });
	res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

function serveStatic(res, relativePath) {
	const filePath = path.join(UI_ROOT, relativePath);
	if (!filePath.startsWith(UI_ROOT)) return send(res, 403, { error: "forbidden" });
	try {
		const content = fs.readFileSync(filePath);
		send(res, 200, content, MIME[path.extname(filePath)] || "application/octet-stream");
	} catch {
		send(res, 404, { error: "not found" });
	}
}

// Kept out of handleFeedbackApi on purpose: a raw-file fallback for a
// screenshot whose base64 preview was never hydrated. decodeRow() in
// yano-feedback.mjs already inlines local files as data: URLs on every read,
// so this route only matters as a defensive fallback.
function attachmentFile(id, requestedName) {
	const safeId = path.basename(String(id || ""));
	const safeName = path.basename(String(requestedName || ""));
	if (!safeId || !safeName || safeId !== id || safeName !== requestedName) return null;
	const dir = path.join(path.dirname(dbPath()), "attachments", safeId);
	let entries = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	const match = entries.find((entry) => entry === safeName || entry.endsWith(`-${safeName}`));
	if (!match) return null;
	const file = path.join(dir, match);
	try {
		return fs.statSync(file).isFile() ? file : null;
	} catch {
		return null;
	}
}

function mimeForAttachment(file) {
	return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif" })[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function withChangeBroadcast(res, req, clients) {
	const originalEnd = res.end.bind(res);
	res.end = (...args) => {
		if (req.method !== "GET" && res.statusCode < 400) {
			const payload = `data: ${JSON.stringify({ type: "changed", at: new Date().toISOString() })}\n\n`;
			for (const client of clients) {
				try {
					client.write(payload);
				} catch {
					/* a client that disconnected between write and close is harmless */
				}
			}
		}
		return originalEnd(...args);
	};
	return res;
}

async function handler(db, clients, req, res) {
	const url = new URL(req.url, "http://localhost");
	const parts = url.pathname.split("/").filter(Boolean);
	if (url.pathname === "/healthz") return send(res, 200, { ok: true, service: "yano-dash" });
	if (req.method === "OPTIONS") return send(res, 204, null);
	if (url.pathname === "/api/stream") {
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(":ok\n\n");
		clients.add(res);
		req.on("close", () => clients.delete(res));
		return;
	}
	if (url.pathname === "/api/projects") {
		return send(res, 200, projectCatalog());
	}
	if (req.method === "POST" && parts[0] === "api" && parts[1] === "agentation" && parts[2]) {
		const body = await new Promise((resolve, reject) => { let raw = ""; req.on("data", (chunk) => { raw += chunk; }); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); req.on("error", reject); });
		const result = await createAgentationFeedback(db, decodeURIComponent(parts[2]), body);
		return send(withChangeBroadcast(res, req, clients), result.duplicate ? 200 : 201, { ...result.item, duplicate: result.duplicate });
	}
	if (req.method === "GET" && parts[0] === "attachments" && parts.length === 3) {
		const file = attachmentFile(parts[1], decodeURIComponent(parts[2]));
		if (!file) return send(res, 404, { error: "screenshot non trovato" });
		return send(res, 200, fs.readFileSync(file), mimeForAttachment(file));
	}
	if (url.pathname === "/" || url.pathname === "/index.html") return serveStatic(res, "index.html");
	if (url.pathname === "/app.js") return serveStatic(res, "app.js");
	if (url.pathname === "/api.js") return serveStatic(res, "api.js");
	if (url.pathname === "/columns.js") return serveStatic(res, "columns.js");
	if (parts[0] === "components" && parts.length === 2) return serveStatic(res, path.join("components", parts[1]));
	// GET reads are served here directly (not via handleFeedbackApi) so every
	// board load also opportunistically repairs remote screenshot URLs — the
	// interactive dashboard cares about visual quality on every view, unlike
	// the headless yano-feedback-serve API, which only repairs once at
	// creation time. repairFeedbackScreenshots() is itself a no-op whenever
	// there is nothing to repair (see yano-feedback.mjs).
	if (req.method === "GET" && parts.length >= 2 && ["bugs", "suggestions"].includes(parts[1])) {
		const project = parts[0];
		const type = parts[1] === "bugs" ? "bug" : "suggestion";
		const itemId = parts[2];
		if (!itemId) {
			const rows = await Promise.all(listFeedback(db, { type, project_id: project }).reverse().map((item) => repairFeedbackScreenshots(db, item)));
			return send(res, 200, rows);
		}
		const found = await repairFeedbackScreenshots(db, getFeedback(db, itemId));
		if (!found || found.project_id !== project) return send(res, 404, { error: "not found" });
		return send(res, 200, { ...found, audit: listFeedbackAudit(db, itemId) });
	}
	return handleFeedbackApi(db, req, withChangeBroadcast(res, req, clients), { requireCredentials: false });
}

function listen(server, requestedPort = null) {
	return new Promise((resolve, reject) => {
		const candidates = requestedPort === null
			? [DASH_PORT.default, ...Array.from({ length: DASH_PORT.max - DASH_PORT.min + 1 }, (_, i) => DASH_PORT.min + i).filter((port) => port !== DASH_PORT.default)]
			: [requestedPort];
		let index = 0;
		const attempt = () => {
			const fail = (error) => {
				server.removeListener("error", fail);
				if (error.code === "EADDRINUSE" && index < candidates.length) return attempt();
				reject(error);
			};
			server.once("error", fail);
			server.listen(candidates[index++], "127.0.0.1", () => {
				server.removeListener("error", fail);
				resolve(server.address().port);
			});
		};
		attempt();
	});
}

function openBrowser(url) {
	const opener = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
	spawnSync(opener[0], opener.slice(1), { stdio: "ignore" });
}

export function stopYanoDash() {
	const state = readDashState();
	if (!state?.pid || !processAlive(state.pid)) return { stopped: false, reason: "not_running" };
	try {
		process.kill(state.pid, "SIGTERM");
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
	writeDashState({ ...state, pid: null, stopped_at: new Date().toISOString() });
	return { stopped: true, pid: state.pid };
}

export async function runYanoDash({ argv = [], cwd = process.cwd() } = {}) {
	const sub = argv[0] || "start";
	if (sub === "stop") {
		const result = stopYanoDash();
		console.log(JSON.stringify(result, null, 2));
		if (result.stopped) {
			console.log('Nota: yano-dash è un servizio builtin sempre attivo — "yano watcher supervise" (ogni minuto) lo riavvierà entro ~60s a meno che YANO_DASH_AUTOSTART=0 o YANO_DISABLE_BUILTIN_DEPENDENCY_SUPERVISION=1.');
		}
		return;
	}
	if (sub !== "start") throw new Error("Uso: yano dash start|stop [--no-open] [--project-id ID] [--port N]");
	const existing = readDashState();
	if (existing?.pid && processAlive(existing.pid)) {
		console.log(`yano dash: già attivo su ${existing.url}`);
		if (!argv.includes("--no-open")) openBrowser(existing.url);
		return;
	}
	const root = projectRootFrom(cwd);
	const defaultProjectId = value(argv, "--project-id") || projectKey(root, resolveTraceProject(root) || path.basename(root));
	const db = openDatabase();
	const clients = new Set();
	const server = http.createServer((req, res) => handler(db, clients, req, res).catch((error) => send(res, 400, { error: error.message })));
	const requestedPort = value(argv, "--port") !== null ? Number(value(argv, "--port")) : null;
	const port = await listen(server, requestedPort);
	const url = `http://127.0.0.1:${port}/`;
	const state = { pid: process.pid, port, url, project_id: defaultProjectId, project_root: root, started_at: new Date().toISOString() };
	writeDashState(state);
	console.log(`yano dash: ${url}`);
	if (port !== DASH_PORT.default) {
		await sendGlobalNotification(`yano dash: la porta ${DASH_PORT.default} era occupata, dashboard avviata su ${url}`, { role: "system", task: "yano-dash-fallback-port" }).catch(() => {});
	}
	if (!argv.includes("--no-open")) openBrowser(url);
	const shutdown = () => {
		// An open SSE connection (/api/stream) is a live socket that keeps
		// Node's event loop alive on its own; server.close() only stops NEW
		// connections, so without closing these explicitly (and exiting
		// explicitly) the process would linger forever after SIGTERM whenever
		// a browser tab is still subscribed — exactly what "yano dash stop"
		// must not do for an always-on, supervised service.
		for (const client of clients) {
			try {
				client.end();
			} catch {
				/* client already gone */
			}
		}
		server.close();
		db.close();
		writeDashState({ ...state, pid: null, stopped_at: new Date().toISOString() });
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}
