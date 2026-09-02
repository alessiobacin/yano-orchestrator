#!/usr/bin/env node

// Persistent per-agent MCP registry. Values in `env` may reference the
// protected Yano config as `${YANO_CONFIG:KEY}`; secrets are resolved only
// while materialising the runtime config passed to Pi.
import fs from "node:fs";
import path from "node:path";
import { globalDataPath, resolveYanoConfig } from "./yano-config.mjs";

const filePath = () => path.join(globalDataPath(), "mcp", "agents.json");
const configPath = (agent) => path.join(globalDataPath(), "mcp", "agents", `${safe(agent)}.json`);
const runtimePath = (agent) => agent === "computer-locale" ? path.join(globalDataPath(), "computer-local", ".mcp.json") : null;
const safe = (value) => String(value || "agent").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 100);
const json = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; };
const has = (argv, flag) => argv.includes(flag);
function read() { try { return JSON.parse(fs.readFileSync(filePath(), "utf8")); } catch { return { agents: {} }; } }
function write(value) { fs.mkdirSync(path.dirname(filePath()), { recursive: true, mode: 0o700 }); fs.writeFileSync(filePath(), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
function validate(name, value) {
	if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("nome MCP non valido");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config MCP: deve essere un oggetto JSON");
	if (typeof value.command !== "string" || !value.command.trim()) throw new Error("config MCP: command deve essere una stringa non vuota");
	if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((x) => typeof x !== "string"))) throw new Error("config MCP: args deve essere un array di stringhe");
	if (value.env !== undefined && (!value.env || typeof value.env !== "object" || Array.isArray(value.env) || Object.entries(value.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string"))) throw new Error("config MCP: env deve essere una mappa di stringhe");
	return { command: value.command, ...(value.args ? { args: value.args } : {}), ...(value.env ? { env: value.env } : {}) };
}
function resolve(value) {
	const cfg = resolveYanoConfig({});
	return Object.fromEntries(Object.entries(value || {}).map(([k, v]) => [k, v.replace(/^\$\{YANO_CONFIG:([^}]+)\}$/, (_, key) => cfg[key] || "")]));
}
function safeDisplay(value) {
	if (!value || typeof value !== "object") return value;
	return { ...value, ...(value.env ? { env: Object.fromEntries(Object.keys(value.env).map((key) => [key, "[configured]"])) } : {}) };
}
function effectiveMcp(agent, db) {
	const added = db.agents?.[agent] || {};
	let runtime = {};
	try { runtime = JSON.parse(fs.readFileSync(runtimePath(agent), "utf8")).mcpServers || {}; } catch { /* no built-in runtime */ }
	const builtIn = Object.fromEntries(Object.entries(runtime).filter(([name]) => !Object.prototype.hasOwnProperty.call(added, name)).map(([name, value]) => [name, safeDisplay(value)]));
	const addedDisplay = Object.fromEntries(Object.entries(added).map(([name, value]) => [name, safeDisplay(value)]));
	const effective = Object.fromEntries(Object.entries({ ...runtime, ...added }).map(([name, value]) => [name, safeDisplay(value)]));
	return { built_in: builtIn, added: addedDisplay, effective, runtime_config: runtimePath(agent) };
}
export function agentMcpConfigPath(agent) { return configPath(agent); }
export function materializeAgentMcp(agent) {
	const db = read(); const servers = db.agents?.[agent] || {};
	if (!Object.keys(servers).length) return null;
	const output = { mcpServers: Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, { ...value, ...(value.env ? { env: resolve(value.env) } : {}) }])) };
	fs.mkdirSync(path.dirname(configPath(agent)), { recursive: true, mode: 0o700 });
	fs.writeFileSync(configPath(agent), JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
	return configPath(agent);
}
export function agentMcpUsage() { return ["Uso: yano mcp agent <list|show|add|update|remove>", "", "  list [--agent <nome|id>] mostra built-in, aggiunti ed effective", "  --agent <nome|id>   agente destinatario, es. computer-locale", "  add/update --name <server> --config '<JSON>'", "  remove --name <server>", "  --json"].join("\n"); }
export function runYanoAgentMcp({ argv = [] } = {}) {
	const sub = argv[0]; if (!sub || has(argv, "--help") || has(argv, "-h")) { console.log(agentMcpUsage()); return; }
	const agent = json(argv, "--agent") || json(argv, "--instance");
	const db = read(); db.agents ||= {};
	if (sub === "list") {
		const agents = new Set(Object.keys(db.agents));
		if (runtimePath("computer-locale") && fs.existsSync(runtimePath("computer-locale"))) agents.add("computer-locale");
		const result = agent ? { [agent]: effectiveMcp(agent, db) } : Object.fromEntries([...agents].sort().map((name) => [name, effectiveMcp(name, db)]));
		const output = { agent: agent || null, servers: result, note: "built_in = MCP materializzati automaticamente; added = MCP aggiunti con yano mcp agent add/update; effective = configurazione realmente disponibile" };
		if (has(argv, "--json")) console.log(JSON.stringify(output, null, 2)); else console.log(JSON.stringify(output, null, 2));
		return output;
	}
	if (!agent) throw new Error("--agent è obbligatorio");
	db.agents[agent] ||= {};
	const name = json(argv, "--name");
	if (sub === "show") { const result = db.agents[agent][name] || null; if (has(argv, "--json")) console.log(JSON.stringify(result, null, 2)); else console.log(result ? JSON.stringify(result, null, 2) : "MCP non trovato"); return result; }
	if (sub === "remove") { if (!name) throw new Error("--name è obbligatorio"); delete db.agents[agent][name]; write(db); materializeAgentMcp(agent); console.log(JSON.stringify({ agent, removed: name }, null, 2)); return; }
	if (sub !== "add" && sub !== "update") throw new Error(`sottocomando MCP sconosciuto: ${sub}`);
	if (!name) throw new Error("--name è obbligatorio");
	let raw = json(argv, "--config"); if (!raw) throw new Error("--config richiede un oggetto JSON");
	let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error("--config non è JSON valido"); }
	const value = validate(name, parsed); if (sub === "add" && db.agents[agent][name]) throw new Error(`MCP già presente per ${agent}: ${name}; usa update`);
	db.agents[agent][name] = value; write(db); const runtime = materializeAgentMcp(agent);
	const result = { agent, name, config: value, registry: filePath(), runtime_config: runtime }; console.log(JSON.stringify(result, null, 2)); return result;
}
