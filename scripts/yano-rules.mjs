#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalDataPath } from "./yano-config.mjs";
import { projectKey, resolveTraceProject } from "./yano-trace-storage.mjs";

function rulesPath() { return path.join(globalDataPath({ env: process.env }), "rules", "rules.json"); }
function readRules() {
	try { return JSON.parse(fs.readFileSync(rulesPath(), "utf8")); } catch { return { version: 1, global: [], projects: {} }; }
}
function writeRules(data) {
	const file = rulesPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}
function projectInfo(root, explicit) {
	const resolved = path.resolve(root || process.cwd());
	const project = String(explicit || resolveTraceProject(resolved)).trim();
	return { root: resolved, project, key: projectKey(resolved, project) };
}

export function loadYanoRules({ root = process.cwd(), project = null } = {}) {
	const data = readRules();
	const info = projectInfo(root, project);
	const scoped = data.projects?.[info.key]?.rules || [];
	return { global: [...(data.global || [])], project: scoped, project_name: info.project, project_root: info.root, project_key: info.key, path: rulesPath() };
}

function usage() {
	return [
		"Uso: yano rule <add|list|remove> [--global|--project-root <dir>] [testo|--id <id>]",
		"  yano rule --add --global \"regola valida per tutti i progetti\"",
		"  yano rule --add --project-root <dir> \"regola del progetto\"",
		"  yano rule --list [--global|--project-root <dir>] [--json]",
		"  yano rule --remove --global --id <id>",
	].join("\n");
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function has(argv, name) { return argv.includes(name); }
function target(argv) {
	return has(argv, "--global") ? { global: true } : { global: false, info: projectInfo(flag(argv, "--project-root") || process.cwd(), flag(argv, "--project")) };
}

export function runYanoRules({ argv = [] } = {}) {
	if (has(argv, "--help") || has(argv, "-h") || !argv.length) { console.log(usage()); return { help: true }; }
	const action = has(argv, "--add") ? "add" : has(argv, "--list") ? "list" : has(argv, "--remove") ? "remove" : argv[0];
	const scope = target(argv);
	const data = readRules();
	if (action === "list") {
		const result = scope.global ? { global: data.global || [], path: rulesPath() } : loadYanoRules({ root: scope.info.root, project: scope.info.project });
		console.log(has(argv, "--json") ? JSON.stringify(result, null, 2) : (scope.global ? result.global : [...result.global, ...result.project]).map((rule) => `${rule.id} — ${rule.text}`).join("\n") || "nessuna regola");
		return result;
	}
	if (action === "add") {
		const text = argv.filter((value, index) => !value.startsWith("--") && argv[index - 1] !== "--project-root" && argv[index - 1] !== "--project" && argv[index - 1] !== "--id" && value !== "add").join(" ").trim();
		if (!text) throw new Error("yano rule: il testo della regola è obbligatorio");
		const rule = { id: `RULE-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, text, created_at: new Date().toISOString(), host: os.hostname() };
		if (scope.global) data.global = [...(data.global || []), rule];
		else {
			data.projects ||= {};
			const current = data.projects[scope.info.key] || { project_name: scope.info.project, project_root: scope.info.root, rules: [] };
			current.rules = [...(current.rules || []), rule]; data.projects[scope.info.key] = current;
		}
		writeRules(data); console.log(JSON.stringify({ added: rule, scope: scope.global ? "global" : scope.info }, null, 2)); return rule;
	}
	if (action === "remove") {
		const id = flag(argv, "--id"); if (!id) throw new Error("yano rule: --id è obbligatorio per rimuovere");
		let removed = false;
		if (scope.global) { const before = data.global || []; data.global = before.filter((rule) => rule.id !== id); removed = before.length !== data.global.length; }
		else if (data.projects?.[scope.info.key]) { const before = data.projects[scope.info.key].rules || []; data.projects[scope.info.key].rules = before.filter((rule) => rule.id !== id); removed = before.length !== data.projects[scope.info.key].rules.length; }
		if (!removed) throw new Error(`yano rule: regola non trovata: ${id}`); writeRules(data); return { removed: id };
	}
	throw new Error(`${usage()}\nComando regola non riconosciuto: ${action}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) runYanoRules({ argv: process.argv.slice(2) });
