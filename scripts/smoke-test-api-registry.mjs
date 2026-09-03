import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "yano-api-registry-"));
process.env.YANO_DATA_DIR = path.join(data, "global");
process.env.SEARCH_TOKEN = "smoke-secret";
const { runYanoApi, listProjectApis } = await import("./yano-api-registry.mjs");
const project = path.join(data, "project"); fs.mkdirSync(project, { recursive: true });
const collection = path.join(data, "collection.json");
fs.writeFileSync(collection, JSON.stringify({ info: { name: "Smoke" }, variable: [{ key: "base_url", value: "https://api.example.com" }], item: [{ name: "Search", request: { method: "GET", url: "{{base_url}}/search" } }] }));
const originalLog = console.log; const output = []; console.log = (value) => output.push(String(value));
try {
	await runYanoApi({ cwd: project, argv: ["add", "--scope", "global", "--name", "search", "--base-url", "https://api.example.com", "--description", "Search API", "--postman", collection, "--auth-config-key", "SEARCH_TOKEN", "--auth-header", "Authorization"] });
	await runYanoApi({ cwd: project, argv: ["add", "--name", "local", "--base-url", "https://api.example.com", "--description", "Local API", "--postman", collection] });
	const effective = listProjectApis(project);
	assert.deepEqual(effective.map((api) => api.name), ["local", "search"]);
	assert.equal(effective.find((api) => api.name === "search").auth_env, "SEARCH_TOKEN");
	assert.deepEqual(effective.find((api) => api.name === "local").endpoints.map((e) => `${e.method} ${e.path}`), ["GET /search"]);
	await runYanoApi({ cwd: project, argv: ["update", "--name", "local", "--description", "Updated API"] });
	await runYanoApi({ cwd: project, argv: ["delete", "--name", "local"] });
	assert.deepEqual(listProjectApis(project).map((api) => api.name), ["search"]);
	assert.ok(output.some((line) => line.includes("configured variable")));
} finally { console.log = originalLog; fs.rmSync(data, { recursive: true, force: true }); }
console.log("smoke-test-api-registry: ok");
