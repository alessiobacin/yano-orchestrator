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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-"));
const env = { ...process.env, YANO_DATA_DIR: dataDir, YANO_FEEDBACK_SKIP_NOTIFY: "1" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dashStatePath() {
	return path.join(dataDir, "dashboards", "dash.json");
}

function assertValidModule(source, label) {
	const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
	assert.equal(result.status, 0, `${label}: non è un modulo ES valido — ${result.stderr}`);
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

	console.log("=== GET / serves HTML referencing app.js as a module ===");
	{
		const response = await fetch(`http://127.0.0.1:${dash.port}/`);
		const htmlSource = await response.text();
		assert.equal(response.status, 200);
		assert.match(htmlSource, /<script[^>]*type="module"[^>]*src="\/app\.js"/);
	}
	console.log("   OK");

	console.log("=== every served UI module is valid JavaScript ===");
	{
		for (const file of ["app.js", "api.js", "columns.js", "components/Header.js", "components/Board.js", "components/Card.js", "components/Drawer.js", "components/Toasts.js"]) {
			const response = await fetch(`http://127.0.0.1:${dash.port}/${file}`);
			assert.equal(response.status, 200, `${file} deve essere servito`);
			assertValidModule(await response.text(), file);
		}
	}
	console.log("   OK");

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

	console.log("=== /api/projects lists the demo project ===");
	{
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/api/projects`);
		assert.equal(status, 200);
		assert.ok(body.some((project) => project.id === "demo"));
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
		while (Date.now() < deadline && dash.child.exitCode === null) await sleep(50);
		assert.notEqual(dash.child.exitCode, null, "il processo OS di yano dash deve terminare davvero dopo 'stop', anche con una connessione SSE ancora aperta");
		const stopped = JSON.parse(fs.readFileSync(dashStatePath(), "utf8"));
		assert.equal(stopped.pid, null);
	}
	console.log("   OK");
	streamController.abort();

	console.log("\nAll yano-dash tests passed.");
} finally {
	if (dash?.child && dash.child.exitCode === null) {
		try {
			dash.child.kill("SIGKILL");
		} catch { /* already gone */ }
	}
	try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort cleanup */ }
}
