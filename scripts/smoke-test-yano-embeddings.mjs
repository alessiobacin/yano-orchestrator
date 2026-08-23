// Verifica il contratto del preflight embeddings senza richiedere Ollama reale:
// comando locale, server HTTP, modello presente e vettore restituito da /api/embed.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkEmbeddingPrerequisites, DEFAULT_EMBEDDING_MODEL } from "./doctor.mjs";

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-ollama-bin-"));
const fakeOllama = path.join(binDir, "ollama");
fs.writeFileSync(fakeOllama, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'ollama version is 0.20.2'; fi\n", { mode: 0o755 });

const server = createServer((request, response) => {
	const body = [];
	request.on("data", (chunk) => body.push(chunk));
	request.on("end", () => {
		response.setHeader("content-type", "application/json");
		if (request.url === "/api/version") return response.end(JSON.stringify({ version: "0.20.2" }));
		if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: `${DEFAULT_EMBEDDING_MODEL}:latest` }] }));
		if (request.url === "/api/embed") return response.end(JSON.stringify({ model: DEFAULT_EMBEDDING_MODEL, embeddings: [Array.from({ length: 768 }, () => 0.01)] }));
		response.statusCode = 404;
		return response.end(JSON.stringify({ error: "not found" }));
	});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const previousPath = process.env.PATH;
const previousUrl = process.env.YANO_OLLAMA_URL;
process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
process.env.YANO_OLLAMA_URL = `http://127.0.0.1:${address.port}`;

try {
	const result = await checkEmbeddingPrerequisites();
	assert.equal(result.ok, true);
	assert.equal(result.model, DEFAULT_EMBEDDING_MODEL);
	assert.equal(result.cli.ok, true);
	assert.equal(result.server.ok, true);
	assert.equal(result.modelCheck.ok, true);
	assert.equal(result.probe.ok, true);
	assert.match(result.probe.detail, /768 dimensioni/);
	console.log("YANO EMBEDDINGS SMOKE TEST PASSED");
} finally {
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	if (previousUrl === undefined) delete process.env.YANO_OLLAMA_URL;
	else process.env.YANO_OLLAMA_URL = previousUrl;
	await new Promise((resolve) => server.close(resolve));
	fs.rmSync(binDir, { recursive: true, force: true });
}
