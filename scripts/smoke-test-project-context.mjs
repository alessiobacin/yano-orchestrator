import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProjectSummary, projectBootstrapPrompt, scanProject } from "./yano-project-context.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-project-context-"));
try {
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(root, "docs", "guides"), { recursive: true });
	fs.mkdirSync(path.join(root, "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, "agents", "roles.yaml"), "roles: {}\n");
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "context-fixture", description: "fixture", scripts: { test: "node test.js" }, dependencies: { vite: "1" } }));
	fs.writeFileSync(path.join(root, "src", "main.ts"), "export const main = true;\n");
	fs.writeFileSync(path.join(root, "docs", "guides", "existing.md"), "# Existing\n");

	const first = scanProject({ root });
	assert.equal(first.project_name, "context-fixture");
	assert.deepEqual(first.manifests, ["package.json"]);
	assert.ok(first.entrypoints.includes("src/main.ts"));
	assert.equal(first.project_memory.exists, false);
	assert.equal(first.needs_documentation_gate, true);
	const created = ensureProjectSummary(first);
	assert.equal(created.created, true);
	assert.match(fs.readFileSync(created.file, "utf8"), /documentation_setup: pending/);

	const second = scanProject({ root });
	assert.equal(second.project_memory.exists, true);
	assert.equal(ensureProjectSummary(second).created, false);
	assert.match(projectBootstrapPrompt(second), /chiedi esplicitamente/);
	assert.match(projectBootstrapPrompt(second), /potenzialmente obsoleti/);
	console.log("smoke-test-project-context: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
