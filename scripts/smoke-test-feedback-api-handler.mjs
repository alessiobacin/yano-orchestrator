#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-api-handler-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";

const { openDatabase, handleFeedbackApi } = await import("./yano-feedback.mjs");

const db = openDatabase();

function serve(options) {
	return http.createServer((req, res) => handleFeedbackApi(db, req, res, options).catch((error) => { res.writeHead(500); res.end(String(error)); }));
}

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function requestJson(port, urlPath, { method = "GET", body = null, headers = {} } = {}) {
	const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: response.status, body: await response.json() };
}

console.log("=== requireCredentials defaults to true for bug creation ===");
{
	const server = serve();
	const port = await listen(server);
	const missingCreds = await requestJson(port, "/demo-project/bugs", { method: "POST", body: { message: "il pulsante non funziona" } });
	assert.equal(missingCreds.status, 400);
	assert.match(missingCreds.body.error, /username e password/);
	server.close();
}
console.log("   OK");

console.log("=== requireCredentials:false lets the dashboard create a bug without credentials ===");
{
	const server = serve({ requireCredentials: false });
	const port = await listen(server);
	const created = await requestJson(port, "/demo-project/bugs", { method: "POST", body: { message: "il pulsante non funziona" } });
	assert.equal(created.status, 201);
	assert.equal(created.body.type, "bug");
	assert.equal(created.body.project_id, "demo-project");
	server.close();
}
console.log("   OK");

console.log("=== GET a single item includes the audit trail ===");
{
	const server = serve({ requireCredentials: false });
	const port = await listen(server);
	const created = await requestJson(port, "/demo-project/suggestions", { method: "POST", body: { message: "aggiungere filtro per data" } });
	const fetched = await requestJson(port, `/demo-project/suggestions/${created.body.id}`);
	assert.equal(fetched.status, 200);
	assert.ok(Array.isArray(fetched.body.audit));
	assert.equal(fetched.body.audit[0].action, "created");
	server.close();
}
console.log("   OK");

db.close();
console.log("\nAll handleFeedbackApi tests passed.");
