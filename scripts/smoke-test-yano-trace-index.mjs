#!/usr/bin/env node

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { appendTraceRecord, ensureTraceProject, tracePaths } from "./yano-trace-storage.mjs";
import { clearTraceIndexData, indexTraceRecords, searchTraceRecords, traceIndexPath } from "./yano-trace-index.mjs";

function ok(condition, message) {
	if (!condition) throw new Error(`TRACE INDEX SMOKE FAILED: ${message}`);
	console.log(`ok - ${message}`);
}

async function fakeOllama() {
	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			let body = {};
			try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* handled by deterministic fallback */ }
			if (request.url === "/api/embed") {
				const inputs = Array.isArray(body.input) ? body.input : [body.input || ""];
				const embeddings = inputs.map((value) => {
					const text = String(value).toLowerCase();
					return text.includes("database") ? [1, 0, 0] : text.includes("timeout") ? [0, 1, 0] : [0, 0, 1];
				});
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

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-trace-index-"));
	const cwd = path.join(root, "focusboard");
	fs.mkdirSync(cwd, { recursive: true });
	const oldDataDir = process.env.YANO_DATA_DIR;
	const oldOllamaUrl = process.env.YANO_OLLAMA_URL;
	const oldModel = process.env.YANO_EMBEDDING_MODEL;
	const { server, url } = await fakeOllama();
	process.env.YANO_DATA_DIR = path.join(root, "yano-temp");
	process.env.YANO_OLLAMA_URL = url;
	process.env.YANO_EMBEDDING_MODEL = "nomic-embed-text";
	try {
		const project = "focusboard-index-smoke";
		const paths = ensureTraceProject({ cwd, project });
		const runId = "run-index-smoke";
		fs.appendFileSync(path.join(paths.eventsDir, "coder-01.jsonl"), `${JSON.stringify({
			project, project_key: paths.projectKey, instance: "coder-01", role: "coder", run_id: runId,
			seq: 1, ts: "2026-08-23T10:00:00.000Z", type: "tool_execution_end", tool: "sqlite",
			ok: false, detail: "database migration timeout", task_slug: "trace-index",
		})}\n`);
		appendTraceRecord({ cwd, project, kind: "feedback", record: { status: "rejected", text: "Il database non funziona: la migrazione va in timeout.", run_id: runId, round: "2", task_slug: "trace-index" } });
		appendTraceRecord({ cwd, project, kind: "opinion", record: { text: "La causa è un timeout nella migrazione database.", root_cause: "database timeout", run_id: runId, round: "2", task_slug: "trace-index" } });

		const first = await indexTraceRecords({ cwd, project, run: runId, batchSize: 2 });
		ok(first.ok && first.indexed === 3 && first.failed === 0, "indicizza eventi e record di analisi in SQLite");
		ok(fs.existsSync(traceIndexPath()), "crea il database semantico nella temp globale");
		const second = await indexTraceRecords({ cwd, project, run: runId });
		ok(second.indexed === 0 && second.skipped === 3, "l'indicizzazione successiva è incrementale");
		const search = await searchTraceRecords({ cwd, project, query: "problemi del database", run: runId, limit: 1 });
		ok(search.ok && search.results.length === 1 && search.results[0].text.toLowerCase().includes("database"), "ricerca semantica restituisce l'evidenza pertinente");
		const removed = clearTraceIndexData({ cwd, project, run: runId });
		ok(removed.documents === 3, "clear rimuove anche i documenti indicizzati del run");
		console.log("YANO TRACE INDEX SMOKE TEST PASSED");
	} finally {
		await new Promise((resolve) => server.close(resolve));
		if (oldDataDir === undefined) delete process.env.YANO_DATA_DIR; else process.env.YANO_DATA_DIR = oldDataDir;
		if (oldOllamaUrl === undefined) delete process.env.YANO_OLLAMA_URL; else process.env.YANO_OLLAMA_URL = oldOllamaUrl;
		if (oldModel === undefined) delete process.env.YANO_EMBEDDING_MODEL; else process.env.YANO_EMBEDDING_MODEL = oldModel;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
