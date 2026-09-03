#!/usr/bin/env node
// Validates every packaged Playbook using the same parser and immutable
// contract loader used by the runtime. This is intentionally deterministic:
// no network, no external linter, and no project state are required.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadPlaybook } from "./playbook-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "playbooks");
const files = fs.readdirSync(dir).filter((file) => file.endsWith(".yaml")).sort();
const failures = [];
const rolesPath = path.join(root, "agents", "roles.yaml");
const roles = parseYaml(fs.readFileSync(rolesPath, "utf8"))?.roles || {};
const playbookIds = new Set();

for (const file of files) {
	const source = path.join(dir, file);
	try {
		const playbook = loadPlaybook(source);
		if (!playbook.contract) throw new Error("missing standard contract (execution/checkpoint/evidence/report_sections/budgets/verification/recovery)");
		playbookIds.add(playbook.id);
		console.log(`OK ${file} (${playbook.id}, ${playbook.metadata.checksum.slice(0, 12)}…)`);
	} catch (error) {
		failures.push({ file, message: error instanceof Error ? error.message : String(error) });
		console.error(`ERR ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

for (const [roleId, role] of Object.entries(roles)) {
	if (!role?.playbook) continue;
	const resolves = playbookIds.has(role.playbook) || (role.playbook === "default" && playbookIds.has("default-orchestration"));
	if (!resolves) failures.push({ file: `agents/roles.yaml:${roleId}`, message: `references missing playbook ${role.playbook}` });
	if (roleId === "auto-improver") {
		if (!fs.existsSync(path.join(root, "prompts", "auto-improver.md"))) failures.push({ file: "agents/roles.yaml:auto-improver", message: "requires prompts/auto-improver.md" });
		if (!role.skills?.includes("yano-auto-improvement")) failures.push({ file: "agents/roles.yaml:auto-improver", message: "requires yano-auto-improvement skill" });
		if (!Array.isArray(role.cli) || role.cli.length === 0) failures.push({ file: "agents/roles.yaml:auto-improver", message: "requires declared CLI capabilities" });
	}
}

for (const failure of failures.filter((entry) => entry.file.startsWith("agents/roles.yaml:"))) console.error(`ERR ${failure.file}: ${failure.message}`);

if (failures.length) {
	console.error(`Playbook lint failed: ${failures.length}/${files.length} file(s).`);
	process.exit(1);
}
console.log(`Playbook lint passed: ${files.length}/${files.length} file(s).`);
