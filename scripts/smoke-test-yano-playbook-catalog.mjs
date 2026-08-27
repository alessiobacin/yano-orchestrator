#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-playbook-catalog-"));
const dataDir = path.join(root, "data");
const configHome = path.join(root, "config");
const projectRoot = path.join(root, "project");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "bin", "yano.mjs");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({ name: "catalog-smoke" })}\n`);

const env = { ...process.env, YANO_DATA_DIR: dataDir, XDG_CONFIG_HOME: configHome };
function run(args, expected = 0) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, env, encoding: "utf8", maxBuffer: 20_000_000 });
	assert.equal(result.status, expected, `${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
	return result;
}
function jsonRun(args) { return JSON.parse(run([...args, "--json"]).stdout); }

const document = {
	schema_version: 1,
	id: "imported-credential-smoke",
	label: "Imported credential smoke",
	description: "Verifies imported playbook requirements.",
	requirements: { credentials: [{ key: "SMOKE_IMPORT_API_KEY", description: "API key required by the imported tool", secret: true }] },
	catalog: { scope: "global", reusable: true, intents: ["smoke imported capability"] },
	states: [{ id: "received", owner: "planner", terminal: false }, { id: "completed", owner: "planner", terminal: true }],
	transitions: [],
	failure_routes: [],
	invariants: ["no_project_mutation"],
};

try {
	const source = path.join(root, "playbook.yaml");
	fs.writeFileSync(source, YAML.stringify(document));
	const checked = jsonRun(["playbook", "check", source]);
	assert.equal(checked.valid, true);
	assert.equal(checked.credential_checks[0].status, "missing");
	assert.match(checked.credential_checks[0].install_command, /yano config set SMOKE_IMPORT_API_KEY --stdin/);

	const exportPath = path.join(root, "knowledge-authoring.yano-playbook.json");
	const exported = jsonRun(["playbook", "export", "knowledge-authoring", "--out", exportPath]);
	assert.equal(exported.playbook, "knowledge-authoring");
	assert.ok(fs.existsSync(exportPath));
	const bundle = JSON.parse(fs.readFileSync(exportPath, "utf8"));
	assert.equal(bundle.format, "yano-playbook-bundle");
	assert.ok(bundle.roles.length >= 1);

	const importPath = path.join(root, "import.json");
	fs.writeFileSync(importPath, JSON.stringify({
		format: "yano-playbook-bundle",
		bundle_version: 1,
		playbook: document,
		roles: [{ id: "imported-credential-role", label: "Imported credential role", brief: "Smoke role", playbook: document.id, skills: [], cli: [], mcp: [] }],
	}, null, 2));
	const imported = jsonRun(["playbook", "import", importPath, "--once"]);
	assert.equal(imported.architect_required, true);
	assert.equal(imported.requires_user_decision, true);
	assert.ok(imported.checks.some((check) => check.kind === "credential" && check.status === "missing"));
	assert.equal(imported.proposal.project_name, "yano-global");

	const persistentRoot = path.join(dataDir, "catalog", "playbooks", "personal-smoke", "v1.0.0");
	fs.mkdirSync(persistentRoot, { recursive: true });
	fs.writeFileSync(path.join(persistentRoot, "playbook.yaml"), YAML.stringify({ ...document, id: "personal-smoke" }));
	fs.writeFileSync(path.join(dataDir, "catalog", "playbooks", "personal-smoke", "current.json"), JSON.stringify({ id: "personal-smoke", version: "1.0.0", path: path.join(persistentRoot, "playbook.yaml") }));
	assert.ok(jsonRun(["playbook", "list"]).some((entry) => entry.id === "personal-smoke"));
	const removed = jsonRun(["playbook", "remove", "personal-smoke", "--yes"]);
	assert.equal(removed.status, "removed");
	assert.equal(jsonRun(["playbook", "list"]).some((entry) => entry.id === "personal-smoke"), false);
	const purged = jsonRun(["playbook", "purge", "personal-smoke", "--yes"]);
	assert.equal(purged.status, "purged");
	assert.equal(fs.existsSync(path.join(dataDir, "catalog", "playbooks", "personal-smoke")), false);

	console.log("smoke-test-yano-playbook-catalog: ok");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
