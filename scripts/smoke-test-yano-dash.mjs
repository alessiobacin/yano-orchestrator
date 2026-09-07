#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";

const { runYanoDash, stopYanoDash } = await import("./yano-dash.mjs");
const { readDashState } = await import("./yano-dash-state.mjs");

function assertValidModule(source, label) {
	const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
	assert.equal(result.status, 0, `${label}: non è un modulo ES valido — ${result.stderr}`);
}

async function fetchJson(url, options) {
	const response = await fetch(url, options);
	return { status: response.status, body: await response.json() };
}

console.log("=== yano dash start binds a port and writes state ===");
await runYanoDash({ argv: ["start", "--no-open", "--port", "0", "--project-id", "demo"] });
const state = readDashState();
assert.ok(state?.pid, "lo state file deve contenere un pid");
assert.ok(state.port > 0);
console.log("   OK");

console.log("=== GET /healthz ===");
{
	const { status, body } = await fetchJson(`http://127.0.0.1:${state.port}/healthz`);
	assert.equal(status, 200);
	assert.equal(body.ok, true);
}
console.log("   OK");

console.log("=== GET / serves HTML referencing app.js as a module ===");
{
	const response = await fetch(`http://127.0.0.1:${state.port}/`);
	const htmlSource = await response.text();
	assert.equal(response.status, 200);
	assert.match(htmlSource, /<script[^>]*type="module"[^>]*src="\/app\.js"/);
}
console.log("   OK");

console.log("=== every served UI module is valid JavaScript ===");
{
	for (const file of ["app.js", "api.js", "columns.js", "components/Header.js", "components/Board.js", "components/Card.js", "components/Drawer.js", "components/Toasts.js"]) {
		const response = await fetch(`http://127.0.0.1:${state.port}/${file}`);
		assert.equal(response.status, 200, `${file} deve essere servito`);
		assertValidModule(await response.text(), file);
	}
}
console.log("   OK");

console.log("=== dashboard can create a bug without credentials ===");
let bugId;
{
	const { status, body } = await fetchJson(`http://127.0.0.1:${state.port}/demo/bugs`, {
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
	const { status, body } = await fetchJson(`http://127.0.0.1:${state.port}/demo/bugs`);
	assert.equal(status, 200);
	assert.ok(body.some((item) => item.id === bugId));
}
console.log("   OK");

console.log("=== /api/projects lists the demo project ===");
{
	const { status, body } = await fetchJson(`http://127.0.0.1:${state.port}/api/projects`);
	assert.equal(status, 200);
	assert.ok(body.some((project) => project.id === "demo"));
}
console.log("   OK");

console.log("=== /api/stream emits an event when a status changes ===");
{
	const events = [];
	const controller = new AbortController();
	const streamPromise = fetch(`http://127.0.0.1:${state.port}/api/stream`, { signal: controller.signal }).then(async (response) => {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value);
			if (chunk.includes("\"type\":\"changed\"")) { events.push(chunk); break; }
		}
	});
	await new Promise((resolve) => setTimeout(resolve, 200));
	await fetchJson(`http://127.0.0.1:${state.port}/demo/bugs/${bugId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ status: "processing", audit_reason: "presa in carico per il test" }),
	});
	await Promise.race([streamPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout in attesa dell'evento SSE")), 3000))]);
	controller.abort();
	assert.ok(events.length > 0);
}
console.log("   OK");

console.log("=== yano dash stop ===");
{
	const result = stopYanoDash();
	assert.equal(result.stopped, true);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const stopped = readDashState();
	assert.equal(stopped.pid, null);
}
console.log("   OK");

console.log("\nAll yano-dash tests passed.");
process.exit(0);
