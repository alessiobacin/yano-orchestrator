#!/usr/bin/env node
// Keep role capability declarations tied to one canonical probe registry.
// This catches typos before a planner reaches a runtime preflight.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readYaml = (file) => parse(fs.readFileSync(file, "utf8"));
const registry = readYaml(path.join(root, "agents", "capabilities.yaml"));
const roles = readYaml(path.join(root, "agents", "roles.yaml"));
const known = new Set(Object.keys(registry?.capabilities ?? {}));
const failures = [];

if (registry?.schema_version !== 1) failures.push("agents/capabilities.yaml must declare schema_version: 1");
for (const [name, capability] of Object.entries(registry?.capabilities ?? {})) {
	if (!capability?.kind || !capability?.command || !Array.isArray(capability?.probe)) failures.push(`capability ${name}: kind, command and probe are required`);
}
for (const [role, config] of Object.entries(roles?.roles ?? {})) {
	for (const capability of config?.cli ?? []) if (!known.has(capability)) failures.push(`role ${role}: CLI capability "${capability}" is not in the registry`);
}

if (failures.length) {
	for (const failure of failures) console.error(`ERR ${failure}`);
	console.error(`Capability lint failed: ${failures.length} finding(s).`);
	process.exit(1);
}
console.log(`Capability lint passed: ${known.size} registered CLI capabilities; all role declarations resolve.`);
