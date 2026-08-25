#!/usr/bin/env node

// Read-only catalog view for built-in and user-promoted playbooks/roles.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadPlaybook } from "./playbook-loader.mjs";
import { traceRoot } from "./yano-trace-storage.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = path.join(traceRoot(), "catalog");
function has(argv, flag) { return argv.includes(flag); }
function value(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; }
function json(valueToParse, fallback = null) { try { return JSON.parse(valueToParse); } catch { return fallback; } }
function print(valueToPrint, machine) { console.log(machine ? JSON.stringify(valueToPrint, null, 2) : JSON.stringify(valueToPrint, null, 2)); }

function builtinPlaybooks() {
	const dir = path.join(PACKAGE_ROOT, "playbooks");
	return fs.readdirSync(dir).filter((file) => file.endsWith(".yaml")).sort().map((file) => {
		const filePath = path.join(dir, file);
		try { const playbook = loadPlaybook(filePath); return { id: playbook.id, label: playbook.label, source: "builtin", version: playbook.schema_version, path: filePath, checksum: playbook.metadata.checksum }; }
		catch (error) { return { id: path.basename(file, ".yaml"), source: "builtin", path: filePath, status: "invalid", detail: error.message }; }
	});
}

function persistentPlaybooks() {
	const root = path.join(catalogRoot, "playbooks");
	if (!fs.existsSync(root)) return [];
	const result = [];
	for (const id of fs.readdirSync(root)) {
		const current = path.join(root, id, "current.json");
		const pointer = fs.existsSync(current) ? json(fs.readFileSync(current, "utf8"), {}) : {};
		const filePath = pointer.path || path.join(root, id, `v${pointer.version || "0.1.0"}`, "playbook.yaml");
		if (!fs.existsSync(filePath)) continue;
		try { const playbook = loadPlaybook(filePath); result.push({ id: playbook.id, label: playbook.label, source: "user", version: pointer.version || playbook.schema_version, path: filePath, checksum: playbook.metadata.checksum }); }
		catch (error) { result.push({ id, source: "user", path: filePath, status: "invalid", detail: error.message }); }
	}
	return result;
}

function roles() {
	let builtin = {};
	try { builtin = YAML.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "agents", "roles.yaml"), "utf8"))?.roles || {}; } catch { /* empty */ }
	const result = Object.entries(builtin).map(([id, role]) => ({ id, source: "builtin", ...role }));
	const root = path.join(catalogRoot, "agents");
	if (fs.existsSync(root)) {
		for (const id of fs.readdirSync(root)) {
			const versions = fs.readdirSync(path.join(root, id), { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort().reverse();
			const filePath = versions[0] && path.join(root, id, versions[0].name, "role.yaml");
			if (!filePath || !fs.existsSync(filePath)) continue;
			try { result.push({ id, source: "user", ...YAML.parse(fs.readFileSync(filePath, "utf8")), path: filePath }); } catch { /* invalid roles are ignored by the read-only view */ }
		}
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

function usage() {
	return [
		"Uso: yano playbook <list|show|check> [opzioni]",
		"     yano agent <list|show> [opzioni]",
		"",
		"  playbook list [--json]                         elenca built-in e persistenti",
		"  playbook show <id> [--json]                   mostra il playbook risolto",
		"  playbook check <file> [--json]                valida YAML e checksum",
		"  agent list [--json]                            elenca i ruoli disponibili",
		"  agent show <id> [--json]                       mostra skill, CLI, MCP e playbook",
	].join("\n");
}

export function runYanoCatalog({ kind, argv = [] } = {}) {
	const sub = argv[0];
	const machine = has(argv, "--json");
	if (!kind || !sub || sub === "--help" || sub === "-h") { console.log(usage()); return; }
	if (kind === "playbook") {
		const entries = [...builtinPlaybooks(), ...persistentPlaybooks()];
		if (sub === "list") { print(entries, machine); return entries; }
		if (sub === "show") {
			const id = argv[1];
			const entry = entries.find((candidate) => candidate.id === id);
			if (!entry) throw new Error(`yano playbook: playbook non trovato: ${id}`);
			const result = { ...entry, document: entry.status === "invalid" ? null : loadPlaybook(entry.path) };
			print(result, machine); return result;
		}
		if (sub === "check") {
			const filePath = path.resolve(argv[1] || "");
			const playbook = loadPlaybook(filePath);
			const result = { valid: true, id: playbook.id, path: filePath, checksum: playbook.metadata.checksum };
			print(result, machine); return result;
		}
	}
	if (kind === "agent") {
		const entries = roles();
		if (sub === "list") { print(entries.map(({ id, source, label, playbook, skills, cli, mcp }) => ({ id, source, label, playbook, skills, cli, mcp })), machine); return entries; }
		if (sub === "show") {
			const id = argv[1];
			const result = entries.find((candidate) => candidate.id === id);
			if (!result) throw new Error(`yano agent: ruolo non trovato: ${id}`);
			print(result, machine); return result;
		}
	}
	throw new Error(`${kind}: comando sconosciuto "${sub}".\n${usage()}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	const [kind, ...argv] = process.argv.slice(2);
	try { runYanoCatalog({ kind, argv }); } catch (error) { console.error(`${kind || "yano catalog"}: ${error.message}`); process.exit(1); }
}
