#!/usr/bin/env node
// Validates every packaged Playbook using the same parser and immutable
// contract loader used by the runtime. This is intentionally deterministic:
// no network, no external linter, and no project state are required.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "./playbook-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "playbooks");
const files = fs.readdirSync(dir).filter((file) => file.endsWith(".yaml")).sort();
const failures = [];

for (const file of files) {
	const source = path.join(dir, file);
	try {
		const playbook = loadPlaybook(source);
		console.log(`OK ${file} (${playbook.id}, ${playbook.metadata.checksum.slice(0, 12)}…)`);
	} catch (error) {
		failures.push({ file, message: error instanceof Error ? error.message : String(error) });
		console.error(`ERR ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (failures.length) {
	console.error(`Playbook lint failed: ${failures.length}/${files.length} file(s).`);
	process.exit(1);
}
console.log(`Playbook lint passed: ${files.length}/${files.length} file(s).`);
