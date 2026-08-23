#!/usr/bin/env node

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { appendTraceRecord, ensureTraceProject } from "./yano-trace-storage.mjs";
import { clearTraceIndexData, consolidateTraceMemories, planTraceRetrieval, searchTraceRecords, traceIndexStatus } from "./yano-trace-index.mjs";

async function fakeOllama() {
	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			let body = {};
			try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* diagnostic input is irrelevant */ }
			if (request.url === "/api/embed") {
				const inputs = Array.isArray(body.input) ? body.input : [body.input || ""];
				const embeddings = inputs.map((value) => String(value).toLowerCase().includes("timeout") ? [0, 1, 0] : [1, 0, 0]);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ model: body.model, embeddings }));
				return;
			}
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models: [{ name: "nomic-embed-text:latest" }] }));
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ version: "smoke" }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-memory-"));
const cwdA = path.join(root, "project-a");
const cwdB = path.join(root, "project-b");
fs.mkdirSync(cwdA, { recursive: true });
fs.mkdirSync(cwdB, { recursive: true });
const previous = { data: process.env.YANO_DATA_DIR, ollama: process.env.YANO_OLLAMA_URL, model: process.env.YANO_EMBEDDING_MODEL };
const { server, url } = await fakeOllama();
process.env.YANO_DATA_DIR = path.join(root, "temp");
process.env.YANO_OLLAMA_URL = url;
process.env.YANO_EMBEDDING_MODEL = "nomic-embed-text";

try {
	const run = "memory-run";
	for (const [cwd, project] of [[cwdA, "memory-a"], [cwdB, "memory-b"]]) {
		const paths = ensureTraceProject({ cwd, project });
		fs.appendFileSync(path.join(paths.eventsDir, "coder-01.jsonl"), `${JSON.stringify({
			project, project_key: paths.projectKey, instance: "coder-01", role: "coder", run_id: run,
			seq: 1, ts: "2026-08-23T10:00:00.000Z", type: "tool_execution_end", tool: "migration", ok: false,
			detail: "database timeout", task_slug: "memory-test",
		})}\n`);
		appendTraceRecord({ cwd, project, kind: "feedback", record: { status: "rejected", text: "La migrazione va in timeout e non funziona.", run_id: run, round: "2", task_slug: "memory-test" } });
	}

	const consolidated = await consolidateTraceMemories({ cwd: cwdA, allProjects: true, run });
	assert.equal(consolidated.ok, true);
	assert.ok(consolidated.memories >= 6, "crea summary, failure e feedback per entrambi i progetti");
	assert.ok(consolidated.patterns >= 1, "crea il pattern globale ricorrente");
	assert.ok(fs.existsSync(path.join(consolidated.projection.directory, "planner-context.json")), "scrive la projection per il planner");

	const search = await searchTraceRecords({ cwd: cwdA, project: "memory-a", query: "database timeout", memoryOnly: true, mode: "hybrid", explain: true });
	assert.equal(search.ok, true);
	assert.ok(search.results.some((item) => item.source === "memory" && item.kind === "trace_failure"), "restituisce una failure memory con provenance");
	assert.match(search.explanation, /semantic/);

	const plan = planTraceRetrieval({ cwd: cwdA, project: "memory-a", query: "timeout", run, budget: 1200 });
	assert.equal(plan.budget_tokens, 1200);
	assert.ok(plan.available.consolidated_memories > 0);
	assert.ok(plan.commands.some((command) => command.includes("--explain")));

	const status = traceIndexStatus();
	assert.ok(status.memories >= consolidated.memories);
	const cleared = clearTraceIndexData({ cwd: cwdA, project: "memory-a", run });
	assert.ok(cleared.memories > 0, "clear rimuove le memorie dello scope");
	console.log("YANO TRACE MEMORY SMOKE TEST PASSED");
} finally {
	server.close();
	if (previous.data === undefined) delete process.env.YANO_DATA_DIR; else process.env.YANO_DATA_DIR = previous.data;
	if (previous.ollama === undefined) delete process.env.YANO_OLLAMA_URL; else process.env.YANO_OLLAMA_URL = previous.ollama;
	if (previous.model === undefined) delete process.env.YANO_EMBEDDING_MODEL; else process.env.YANO_EMBEDDING_MODEL = previous.model;
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
