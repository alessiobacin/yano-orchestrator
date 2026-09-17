#!/usr/bin/env node

// yano dash is spawned as a REAL, SEPARATE child process (not in-process via
// runYanoDash()) so this test exercises the exact same process lifecycle a
// real operator hits: "yano dash stop" sends a real SIGTERM to a real OS
// process. This matters specifically because of one regression a manual
// browser check caught that an in-process test could never catch: an open
// SSE connection (/api/stream) keeps a live socket registered on the event
// loop, and without explicitly closing SSE clients and calling
// process.exit() in the shutdown handler, the process would linger forever
// after "stop" whenever a browser tab was still subscribed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-"));
const env = { ...process.env, YANO_DATA_DIR: dataDir, YANO_FEEDBACK_SKIP_NOTIFY: "1", YANO_TEST_MODE: "1" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

function seedWatcherRegistry() {
	const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") || require("node:sqlite");
	const watcherDir = path.join(dataDir, "watcher");
	fs.mkdirSync(watcherDir, { recursive: true });
	const db = new DatabaseSync(path.join(watcherDir, "watcher-registry.sqlite"));
	db.exec(`
		CREATE TABLE watcher_projects (
			project_key TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			root TEXT NOT NULL UNIQUE,
			workspace_id TEXT,
			worker_tab_id TEXT,
			worker_pane_id TEXT,
			worker_instance TEXT,
			worker_status TEXT NOT NULL DEFAULT 'stopped',
			interval_ms INTEGER NOT NULL DEFAULT 60000,
			lookback_ms INTEGER NOT NULL DEFAULT 3600000,
			last_recovery_at TEXT,
			last_recovery_reason TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	const watchedAt = new Date().toISOString();
	const insert = db.prepare("INSERT INTO watcher_projects(project_key,name,root,worker_status,interval_ms,lookback_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
	const watched = [
		["watcher-yano", "yano-orchestrator", root, "running"],
		["watcher-miodoc", "newMioDOC", path.resolve(root, "../..", "Code", "newMioDOC"), "running"],
		["watcher-stopped", "historical-project", path.resolve(root, "../sales-companion"), "stopped"],
	];
	for (const [key, name, projectRoot, status] of watched) insert.run(key, name, projectRoot, status, 60000, 3600000, watchedAt, watchedAt);
	db.close();
}

function dashStatePath() {
	return path.join(dataDir, "dashboards", "dash.json");
}

async function fetchJson(url, options) {
	const response = await fetch(url, options);
	return { status: response.status, body: await response.json() };
}

async function startDash() {
	const child = spawn("node", [path.join(root, "bin", "yano.mjs"), "dash", "start", "--no-open", "--port", "0", "--project-id", "demo"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(dashStatePath())) {
			try {
				const state = JSON.parse(fs.readFileSync(dashStatePath(), "utf8"));
				if (state.port && state.pid) return { child, port: state.port };
			} catch { /* file mid-write, retry */ }
		}
		if (child.exitCode !== null) throw new Error(`yano dash exited early (code ${child.exitCode}): ${stderr}`);
		await sleep(50);
	}
	throw new Error(`yano dash never wrote its state file within the deadline. stderr: ${stderr}`);
}

let dash = null;

try {
	seedWatcherRegistry();
	console.log("=== yano dash start binds a port and writes state ===");
	dash = await startDash();
	assert.ok(dash.port > 0, "yano dash must report the port it actually bound");
	console.log("   OK");

	console.log("=== GET /healthz ===");
	{
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/healthz`);
		assert.equal(status, 200);
		assert.equal(body.ok, true);
	}
	console.log("   OK");

	console.log("=== API discovery replaces the removed GUI ===");
	{
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/`);
		assert.equal(status, 200);
		assert.equal(body.ui, "provided_by_application");
		assert.equal((await fetch(`http://127.0.0.1:${dash.port}/app.js`)).status, 404);
	}
	console.log("=== generic browser annotations preserve context and screenshot ===");
    {
        const script = await fetch(`http://127.0.0.1:${dash.port}/review.js`);
        assert.equal(script.status, 200);
        assert.match(await script.text(), /yano-review-overlay/);
        const payload = { annotation: { id: "browser-fixture", comment: "Il bottone è fuori posto", elementPath: "#save", element: "button" }, page_url: "http://localhost:8501", browser_context: { viewport: { width: 390, height: 844 } }, screenshots: [{name:"pixel.png",data:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII="}] };
        const {status,body} = await fetchJson(`http://127.0.0.1:${dash.port}/api/annotations/demo`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
        assert.equal(status,201);
        assert.equal(JSON.parse(body.browser_context).viewport.width,390);
        assert.equal(body.screenshots.length,1);
        const duplicate = await fetchJson(`http://127.0.0.1:${dash.port}/api/annotations/demo`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
        assert.equal(duplicate.status,200);
        assert.equal(duplicate.body.id,body.id);
    }
	console.log("=== dashboard can create a bug without credentials ===");
	let bugId;
	{
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/demo/bugs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "il pulsante Salva non risponde" }),
		});
		assert.equal(status, 201);
		bugId = body.id;
	}
	console.log("   OK");

	console.log("=== the created bug appears in the list ===");
	{
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/demo/bugs`);
		assert.equal(status, 200);
		assert.ok(body.some((item) => item.id === bugId));
	}
	console.log("   OK");

	console.log("=== /api/projects lists only live watcher projects ===");
	{
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/api/projects`);
		assert.equal(status, 200);
		assert.deepEqual(body.map((project) => project.name), ["newMioDOC", "yano-orchestrator"]);
		assert.ok(body.every((project) => project.name !== "historical-project" && project.name !== "demo"));
	}
	console.log("   OK");

	console.log("=== /api/stream emits an event when a status changes ===");
	// This SSE connection is deliberately left OPEN — not aborted — going into
	// the "stop" check below, to reproduce the exact regression a manual
	// browser check caught (see the header comment).
	const streamEvents = [];
	const streamController = new AbortController();
	const streamPromise = fetch(`http://127.0.0.1:${dash.port}/api/stream`, { signal: streamController.signal }).then(async (response) => {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value);
			if (chunk.includes("\"type\":\"changed\"")) { streamEvents.push(chunk); break; }
		}
	});
	await sleep(200);
	await fetchJson(`http://127.0.0.1:${dash.port}/demo/bugs/${bugId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ status: "processing", audit_reason: "presa in carico per il test" }),
	});
	await Promise.race([streamPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout in attesa dell'evento SSE")), 3000))]);
	assert.ok(streamEvents.length > 0);
	console.log("   OK");

	console.log("=== yano dash stop actually terminates the process, even with an open SSE connection ===");
	{
		const stopResult = spawnSync("node", [path.join(root, "bin", "yano.mjs"), "dash", "stop"], { cwd: root, env, encoding: "utf8" });
		assert.equal(stopResult.status, 0, `yano dash stop è uscito con codice diverso da zero: ${stopResult.stderr}`);
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && dash.child.exitCode === null && dash.child.signalCode === null) await sleep(50);
		assert.ok(dash.child.exitCode !== null || dash.child.signalCode !== null, "il processo OS di yano dash deve terminare davvero dopo 'stop', anche con una connessione SSE ancora aperta");
		const stopped = JSON.parse(fs.readFileSync(dashStatePath(), "utf8"));
		assert.equal(stopped.pid, null);
	}
	console.log("   OK");
	streamController.abort();

	console.log("\nAll yano-dash tests passed.");
} finally {
	if (dash?.child && dash.child.exitCode === null && dash.child.signalCode === null) {
		try {
			dash.child.kill("SIGKILL");
		} catch { /* already gone */ }
	}
	try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort cleanup */ }
}
