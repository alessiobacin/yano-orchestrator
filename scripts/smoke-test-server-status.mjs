import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAndProbeServers, discoverServerEndpoints, probeServer } from "./yano-server-status.mjs";
import { writeCapabilities } from "./yano-capabilities.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-"));
const config = path.join(root, ".pi", "extensions", "yano-orchestrator", "config");
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, "e2e-environment.json"), JSON.stringify({ frontend_url: "http://localhost:14200", backend_url: "http://localhost:13200" }));
fs.writeFileSync(path.join(root, ".env.local"), "APP_URL=http://localhost:18000\n# PORT=ignored\n");
try {
	const endpoints = discoverServerEndpoints(root, {});
	assert.deepEqual(endpoints, { frontend: { url: "http://localhost:14200" }, backend: { url: "http://localhost:13200" } });
	const envOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-env-"));
	try {
		fs.writeFileSync(path.join(envOnlyRoot, ".env.local"), "APP_URL=http://localhost:18000\n");
		assert.deepEqual(discoverServerEndpoints(envOnlyRoot, {}), { backend: { url: "http://localhost:18000" } });
	} finally { fs.rmSync(envOnlyRoot, { recursive: true, force: true }); }
	const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-worktree-"));
	try {
		fs.mkdirSync(path.join(worktreeRoot, ".worktrees", "task", ".pi", "extensions", "yano-orchestrator", "config"), { recursive: true });
		fs.writeFileSync(path.join(worktreeRoot, ".worktrees", "task", ".pi", "extensions", "yano-orchestrator", "config", "e2e-environment.json"), JSON.stringify({ frontend_url: "http://localhost:19000" }));
		assert.deepEqual(discoverServerEndpoints(worktreeRoot, {}), { frontend: { url: "http://localhost:19000" } });
	} finally { fs.rmSync(worktreeRoot, { recursive: true, force: true }); }
	const inferredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-inferred-"));
	try {
		fs.mkdirSync(path.join(inferredRoot, ".worktrees", "task", "app", "gui"), { recursive: true });
		fs.writeFileSync(path.join(inferredRoot, ".worktrees", "task", "app", "main.py"), "from fastapi import FastAPI\n");
		fs.writeFileSync(path.join(inferredRoot, ".worktrees", "task", "app", "gui", "streamlit_app.py"), "import streamlit\n");
		assert.deepEqual(discoverServerEndpoints(inferredRoot, {}), { frontend: { url: "http://localhost:8501" }, backend: { url: "http://localhost:8000" } });
	} finally { fs.rmSync(inferredRoot, { recursive: true, force: true }); }
	const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-next-"));
	try {
		fs.mkdirSync(path.join(nextRoot, "src", "app"), { recursive: true });
		fs.writeFileSync(path.join(nextRoot, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
		fs.writeFileSync(path.join(nextRoot, ".env.local"), "PORT=3014\nPORT_DEV=3013\n");
		assert.deepEqual(discoverServerEndpoints(nextRoot, {}), { frontend: { url: "http://localhost:3013" } });
	} finally { fs.rmSync(nextRoot, { recursive: true, force: true }); }
	// Regression: a project detected as "frontend" ONLY through the generic
	// signals (a "frontend" dir, src/App.tsx, src/app, ...) with no recognized
	// framework config file and no env/config override used to fall back to a
	// blind "http://localhost:3000" guess — routinely wrong (Angular's 4200, a
	// custom port, or simply nothing at all), producing a confidently-wrong
	// traffic light instead of no light. It must now report nothing for that
	// kind rather than a guessed URL.
	const ambiguousRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-ambiguous-"));
	try {
		fs.mkdirSync(path.join(ambiguousRoot, "frontend"), { recursive: true });
		assert.deepEqual(discoverServerEndpoints(ambiguousRoot, {}), {}, "an unrecognized frontend structure with no other signal must not guess a port");
	} finally { fs.rmSync(ambiguousRoot, { recursive: true, force: true }); }
	// A real next.config.* file is a strong, framework-specific signal (unlike
	// the generic src/app dir the -next- fixture above already covers via its
	// own env override) — 3000 is Next.js's own documented dev default, so
	// this specific inference is still legitimate and must still work.
	const nextConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-next-config-"));
	try {
		fs.writeFileSync(path.join(nextConfigRoot, "next.config.js"), "module.exports = {};\n");
		assert.deepEqual(discoverServerEndpoints(nextConfigRoot, {}), { frontend: { url: "http://localhost:3000" } });
	} finally { fs.rmSync(nextConfigRoot, { recursive: true, force: true }); }
	const declaredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-declared-"));
	try {
		fs.mkdirSync(path.join(declaredRoot, "src", "app"), { recursive: true });
		writeCapabilities(declaredRoot, { project: "declared", components: {
			frontend: { present: true, url: "http://localhost:19100", source: "planner", confidence: "confirmed" },
			backend: { present: false, source: "planner", confidence: "confirmed" },
		} });
		assert.deepEqual(discoverServerEndpoints(declaredRoot, {}), { frontend: { url: "http://localhost:19100", source: "capabilities" } });
	} finally { fs.rmSync(declaredRoot, { recursive: true, force: true }); }
	// Regression: an explicit per-project config entry must win even over a
	// capabilities record that says the component is NOT present. That record
	// is a point-in-time detector guess that can go stale (e.g. detected once
	// before a frontend/backend existed, never re-run since — this project's
	// own real capabilities.json) — it must never silently and permanently
	// block an explicit, deliberate override with no visible error.
	const staleAbsentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-stale-absent-"));
	try {
		const staleConfig = path.join(staleAbsentRoot, ".pi", "extensions", "yano-orchestrator", "config");
		fs.mkdirSync(staleConfig, { recursive: true });
		fs.writeFileSync(path.join(staleConfig, "e2e-environment.json"), JSON.stringify({ frontend_url: "http://localhost:19200" }));
		writeCapabilities(staleAbsentRoot, { project: "stale-absent", components: {
			frontend: { present: false, source: "detector", confidence: "unknown" },
			backend: { present: false, source: "detector", confidence: "unknown" },
		} });
		assert.deepEqual(discoverServerEndpoints(staleAbsentRoot, {}), { frontend: { url: "http://localhost:19200" } }, "an explicit config entry must win over a stale capabilities.present=false record");
	} finally { fs.rmSync(staleAbsentRoot, { recursive: true, force: true }); }
	assert.equal(await probeServer("http://localhost:1", 20), "stopped");
	// Regression: a dev server that is genuinely up but slow to answer its
	// FIRST request (Vite/Next/CRA all compile-on-first-request; routinely
	// well over the old 800ms default) must not be reported as "stopped".
	// Uses probeServer's actual shipped default timeout (no override) so this
	// proves the real default, not just a generously-configured call site.
	const slowButAlive = async () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 1200));
	assert.equal(await probeServer("http://localhost:19999", undefined, slowButAlive), "running", "a slow-but-live server must not be misreported as stopped within the default timeout");
	const result = await discoverAndProbeServers(root, {}, 20, async (url) => url.includes("14200") ? ({ status: 200 }) : ({ status: 503 }));
	assert.deepEqual(result, { frontend: { url: "http://localhost:14200", state: "running", running: true }, backend: { url: "http://localhost:13200", state: "error", running: false } });
	console.log("smoke-test-server-status: ok (opt-in discovery, bounded probe, frontend/backend state)");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
