#!/usr/bin/env node

// Catalog view and lifecycle commands for built-in and user-promoted
// playbooks/roles. Built-ins are immutable; user entries are soft-removable.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { configSpec, resolveYanoConfig } from "./yano-config.mjs";
import { loadPlaybook } from "./playbook-loader.mjs";
import { traceRoot } from "./yano-trace-storage.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = path.join(traceRoot(), "catalog");
function has(argv, flag) { return argv.includes(flag); }
function value(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; }
function json(valueToParse, fallback = null) { try { return JSON.parse(valueToParse); } catch { return fallback; } }
function print(valueToPrint, machine) { console.log(machine ? JSON.stringify(valueToPrint, null, 2) : JSON.stringify(valueToPrint, null, 2)); }

function requirementCredentialStatus(document) {
	const configured = resolveYanoConfig({ packageRoot: PACKAGE_ROOT });
	return (document.requirements?.credentials || []).map((item) => {
		const key = typeof item === "string" ? item : item.key;
		const spec = configSpec(key);
		const value = configured[key];
		const ready = Boolean(value && String(value).trim() && !/^<(your|set|insert)|changeme|replace[-_ ]?me$/i.test(String(value).trim()));
		return { key, status: ready ? "ready" : "missing", description: item.description || spec?.description || "credenziale playbook", install_command: spec?.secret ? `yano config set ${key} --stdin` : `yano config set ${key} <valore>`, configure_at: "yano config path" };
	});
}

function builtinPlaybooks() {
	const dir = path.join(PACKAGE_ROOT, "playbooks");
	return fs.readdirSync(dir).filter((file) => file.endsWith(".yaml")).sort().map((file) => {
		const filePath = path.join(dir, file);
		try { const playbook = loadPlaybook(filePath); return { id: playbook.id, label: playbook.label, source: "builtin", version: playbook.schema_version, path: filePath, checksum: playbook.metadata.checksum }; }
		catch (error) { return { id: path.basename(file, ".yaml"), source: "builtin", path: filePath, status: "invalid", detail: error.message }; }
	});
}

function persistentPlaybooks({ includeRemoved = false } = {}) {
	const root = path.join(catalogRoot, "playbooks");
	if (!fs.existsSync(root)) return [];
	const result = [];
	for (const id of fs.readdirSync(root)) {
		const current = path.join(root, id, "current.json");
		const pointer = fs.existsSync(current) ? json(fs.readFileSync(current, "utf8"), {}) : {};
		const filePath = pointer.path || path.join(root, id, `v${pointer.version || "0.1.0"}`, "playbook.yaml");
		if (!includeRemoved && pointer.status === "removed") continue;
		if (!fs.existsSync(filePath)) continue;
		try { const playbook = loadPlaybook(filePath); result.push({ id: playbook.id, label: playbook.label, source: "user", version: pointer.version || playbook.schema_version, path: filePath, checksum: playbook.metadata.checksum }); }
		catch (error) { result.push({ id, source: "user", path: filePath, status: "invalid", detail: error.message }); }
	}
	return result;
}

function persistentEntry(id) {
	const entry = persistentPlaybooks({ includeRemoved: true }).find((candidate) => candidate.id === id);
	if (!entry || entry.source !== "user") throw new Error(`yano playbook: il playbook personale non esiste: ${id}`);
	return entry;
}

function pointerPath(id) { return path.join(catalogRoot, "playbooks", id, "current.json"); }
function readPointer(id) { return fs.existsSync(pointerPath(id)) ? json(fs.readFileSync(pointerPath(id), "utf8"), {}) : {}; }
function writePointer(id, pointer) {
	const file = pointerPath(id);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 });
}

function removePlaybook(id, yes) {
	if (!yes) throw new Error("yano playbook remove: conferma con --yes; l'operazione è reversibile ma disattiva il playbook nel catalogo");
	const entry = persistentEntry(id);
	const pointer = readPointer(id);
	if (pointer.status === "removed") return { id, status: "removed", already_removed: true, path: entry.path };
	const next = { ...pointer, id, status: "removed", removed_at: new Date().toISOString(), previous_status: pointer.status || "persistent" };
	writePointer(id, next);
	return { id, status: "removed", reversible: true, path: entry.path, restore_hint: `ripristinare current.json da ${pointerPath(id)} rimuovendo status=removed` };
}

function purgePlaybook(id, yes) {
	if (!yes) throw new Error("yano playbook purge: conferma con --yes");
	const entry = persistentEntry(id);
	const pointer = readPointer(id);
	if (pointer.status !== "removed") throw new Error(`yano playbook purge: ${id} è ancora attivo; esegui prima yano playbook remove ${id} --yes`);
	const root = path.join(catalogRoot, "playbooks", id);
	if (!fs.existsSync(root)) return { id, status: "purged", already_purged: true };
	// Roles are only removed when they explicitly belong to this playbook. A
	// role shared by another playbook is preserved.
	const removedRoles = [];
	const agentsRoot = path.join(catalogRoot, "agents");
	if (fs.existsSync(agentsRoot)) for (const roleId of fs.readdirSync(agentsRoot)) {
		const roleRoot = path.join(agentsRoot, roleId);
		const versions = fs.readdirSync(roleRoot, { withFileTypes: true }).filter((item) => item.isDirectory());
		const belongs = versions.some((version) => {
			const file = path.join(roleRoot, version.name, "role.yaml");
			try { return YAML.parse(fs.readFileSync(file, "utf8"))?.playbook === id; } catch { return false; }
		});
		if (belongs) { fs.rmSync(roleRoot, { recursive: true, force: true }); removedRoles.push(roleId); }
	}
	fs.rmSync(root, { recursive: true, force: true });
	return { id, status: "purged", removed_roles: removedRoles, path: root, irreversible: true };
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
			try {
				const role = YAML.parse(fs.readFileSync(filePath, "utf8"));
				if (role?.playbook && readPointer(role.playbook).status === "removed") continue;
				result.push({ id, source: "user", ...role, path: filePath });
			} catch { /* invalid roles are ignored by the read-only view */ }
		}
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

function exportBundle(id, outFile) {
	const entries = [...builtinPlaybooks(), ...persistentPlaybooks()];
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`yano playbook export: playbook non trovato o rimosso: ${id}`);
	const document = loadPlaybook(entry.path);
	const roleIds = new Set([
		...(document.team?.roles || []).map((role) => role.id),
		...roles().filter((role) => role.playbook === id).map((role) => role.id),
	]);
	const bundle = {
		format: "yano-playbook-bundle",
		bundle_version: 1,
		exported_at: new Date().toISOString(),
		playbook: Object.fromEntries(Object.entries(document).filter(([key]) => key !== "metadata")),
		roles: roles().filter((role) => roleIds.has(role.id)).map((role) => Object.fromEntries(Object.entries(role).filter(([key]) => !["source", "path"].includes(key)))),
		origin: { source: entry.source, version: entry.version, checksum: entry.checksum },
	};
	const target = path.resolve(outFile || `${id}.yano-playbook.json`);
	fs.writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
	return { ...bundle, path: target };
}

function usage() {
	return [
		"Uso: yano playbook <list|show|check|candidates|export|import|remove|purge> [opzioni]",
		"     yano agent <list|show> [opzioni]",
		"",
		"  playbook list [--json]                         elenca built-in e persistenti",
		"  playbook show <id> [--json]                   mostra il playbook risolto",
		"  playbook check <file> [--json]                valida YAML e checksum",
		"  playbook candidates --task <testo> [--json]  propone playbook compatibili e raccomandati",
		"  playbook export <id> [--out <file>]          esporta playbook e ruoli in un bundle JSON",
		"  playbook import <file> [--dry-run]           importa tramite Architect e verifica i requisiti",
		"  playbook remove <id> --yes                   disattiva un playbook personale senza cancellarlo",
		"  playbook purge <id> --yes                    cancella definitivamente un playbook già rimosso",
		"  agent list [--json]                            elenca i ruoli disponibili",
		"  agent show <id> [--json]                       mostra skill, CLI, MCP e playbook",
	].join("\n");
}

export async function runYanoCatalog({ kind, argv = [] } = {}) {
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
			const document = entry.status === "invalid" ? null : loadPlaybook(entry.path);
			const credentialChecks = document ? requirementCredentialStatus(document) : [];
			const result = { ...entry, document, requirements: document?.requirements || {}, credential_checks: credentialChecks, warnings: credentialChecks.filter((check) => check.status === "missing").map((check) => `${check.key} mancante: ${check.install_command}`) };
			print(result, machine); return result;
		}
		if (sub === "check") {
			const filePath = path.resolve(argv[1] || "");
			const playbook = loadPlaybook(filePath);
			const credentialChecks = requirementCredentialStatus(playbook);
			const result = { valid: true, id: playbook.id, path: filePath, checksum: playbook.metadata.checksum, requirements: playbook.requirements || {}, credential_checks: credentialChecks, warnings: credentialChecks.filter((check) => check.status === "missing") };
			print(result, machine); return result;
		}
		if (sub === "candidates") {
			const { runYanoArchitect } = await import("./yano-architect.mjs");
			return runYanoArchitect({ argv: ["candidates", "--task", value(argv, "--task") || argv[1] || "", ...(value(argv, "--project-root") ? ["--project-root", value(argv, "--project-root")] : []), ...(value(argv, "--project") ? ["--project", value(argv, "--project")] : []), ...(machine ? ["--json"] : [])] });
		}
		if (sub === "export") {
			const result = exportBundle(argv[1], value(argv, "--out"));
			print({ format: result.format, bundle_version: result.bundle_version, path: result.path, playbook: result.playbook.id, roles: result.roles.map((role) => role.id), requirements: result.playbook.requirements || {} }, machine);
			return result;
		}
		if (sub === "import") {
			const filePath = path.resolve(argv[1] || value(argv, "--file") || "");
			if (!filePath) throw new Error("yano playbook import: indica il file bundle JSON");
			const { runYanoArchitect } = await import("./yano-architect.mjs");
			const architectArgs = ["import", "--file", filePath, ...(has(argv, "--dry-run") ? ["--dry-run"] : []), ...(has(argv, "--once") ? ["--once"] : []), ...(machine ? ["--json"] : [])];
			return runYanoArchitect({ argv: architectArgs });
		}
		if (sub === "remove") {
			const result = removePlaybook(argv[1], has(argv, "--yes"));
			print(result, machine); return result;
		}
		if (sub === "purge") {
			const result = purgePlaybook(argv[1], has(argv, "--yes"));
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
	runYanoCatalog({ kind, argv }).catch((error) => { console.error(`${kind || "yano catalog"}: ${error.message}`); process.exit(1); });
}
