#!/usr/bin/env node

import net from "node:net";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_RANGE = { start: 14200, end: 14999 };
const BACKEND_RANGE = { start: 13200, end: 13999 };

export function testEnvironmentPath(worktreePath) {
	return path.join(path.resolve(worktreePath), ".pi", "extensions", "yano-orchestrator", "config", "e2e-environment.json");
}

export function portAvailable(port, host = "127.0.0.1") {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		server.listen({ port, host });
	});
}

function slotFor(worktreePath) {
	const digest = crypto.createHash("sha256").update(path.resolve(worktreePath)).digest();
	return digest.readUInt32BE(0) % (FRONTEND_RANGE.end - FRONTEND_RANGE.start + 1);
}

function readEnvironment(worktreePath) {
	const file = testEnvironmentPath(worktreePath);
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export async function allocateTestEnvironment({ worktreePath = process.cwd(), frontendPort, backendPort } = {}) {
	const root = path.resolve(worktreePath);
	const saved = readEnvironment(root);
	if (!frontendPort && !backendPort && saved?.frontend_port && saved?.backend_port && await portAvailable(saved.frontend_port) && await portAvailable(saved.backend_port)) {
		return { ...saved, reused: true, path: testEnvironmentPath(root) };
	}
	const explicit = frontendPort || backendPort;
	if (explicit && (frontendPort == null || backendPort == null || !Number.isInteger(Number(frontendPort)) || !Number.isInteger(Number(backendPort)))) {
		throw new Error("specificare entrambe le porte: --frontend-port e --backend-port");
	}
	const span = FRONTEND_RANGE.end - FRONTEND_RANGE.start + 1;
	const offset = slotFor(root);
	for (let step = 0; step < span; step += 1) {
		const front = Number(frontendPort) || FRONTEND_RANGE.start + ((offset + step) % span);
		const back = Number(backendPort) || BACKEND_RANGE.start + ((offset + step) % span);
		if (front === back) continue;
		if (await portAvailable(front) && await portAvailable(back)) {
			const environment = {
				version: 1,
				worktree_path: root,
				frontend_port: front,
				backend_port: back,
				frontend_url: `http://127.0.0.1:${front}`,
				backend_url: `http://127.0.0.1:${back}`,
				env: { FRONTEND_PORT: String(front), API_PORT: String(back), BACKEND_PORT: String(back), PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${front}` },
				allocated_at: new Date().toISOString(),
			};
			const file = testEnvironmentPath(root);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(environment, null, 2)}\n`, { mode: 0o600 });
			return { ...environment, reused: false, path: file };
		}
		if (explicit) break;
	}
	throw new Error(`nessuna coppia libera trovata per ${root}; intervalli frontend ${FRONTEND_RANGE.start}-${FRONTEND_RANGE.end}, backend ${BACKEND_RANGE.start}-${BACKEND_RANGE.end}`);
}

export function releaseTestEnvironment(worktreePath = process.cwd()) {
	const file = testEnvironmentPath(worktreePath);
	if (!existsSync(file)) return { removed: false, path: file };
	rmSync(file, { force: true });
	return { removed: true, path: file };
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }

export async function runYanoTestEnvironment({ cwd = process.cwd(), argv = [] } = {}) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Uso: yano test-env <allocate|show|release> [--worktree <dir>] [--frontend-port <n> --backend-port <n>] [--json]");
		return;
	}
	const sub = argv[0] || "allocate";
	const root = arg(argv, "--worktree") || cwd;
	if (sub === "release") {
		console.log(JSON.stringify(releaseTestEnvironment(root), null, argv.includes("--json") ? 2 : 0));
		return;
	}
	if (sub === "show") {
		const value = readEnvironment(root);
		if (!value) throw new Error(`nessun ambiente E2E registrato per ${path.resolve(root)}`);
		console.log(JSON.stringify(value, null, argv.includes("--json") ? 2 : 0));
		return value;
	}
	if (sub !== "allocate") throw new Error(`sottocomando test-env sconosciuto: ${sub}`);
	const value = await allocateTestEnvironment({ worktreePath: root, frontendPort: arg(argv, "--frontend-port"), backendPort: arg(argv, "--backend-port") });
	console.log(JSON.stringify(value, null, argv.includes("--json") ? 2 : 0));
	return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
		await runYanoTestEnvironment({ argv: process.argv.slice(2) });
}
