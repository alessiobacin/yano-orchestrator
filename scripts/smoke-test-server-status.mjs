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
	const declaredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-server-status-declared-"));
	try {
		fs.mkdirSync(path.join(declaredRoot, "src", "app"), { recursive: true });
		writeCapabilities(declaredRoot, { project: "declared", components: {
			frontend: { present: true, url: "http://localhost:19100", source: "planner", confidence: "confirmed" },
			backend: { present: false, source: "planner", confidence: "confirmed" },
		} });
		assert.deepEqual(discoverServerEndpoints(declaredRoot, {}), { frontend: { url: "http://localhost:19100", source: "capabilities" } });
	} finally { fs.rmSync(declaredRoot, { recursive: true, force: true }); }
	assert.equal(await probeServer("http://localhost:1", 20), "stopped");
	const result = await discoverAndProbeServers(root, {}, 20, async (url) => url.includes("14200") ? ({ status: 200 }) : ({ status: 503 }));
	assert.deepEqual(result, { frontend: { url: "http://localhost:14200", state: "running", running: true }, backend: { url: "http://localhost:13200", state: "error", running: false } });
	console.log("smoke-test-server-status: ok (opt-in discovery, bounded probe, frontend/backend state)");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
