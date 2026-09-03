#!/usr/bin/env node

// Explicit user REST API registry. An API cannot be loaded by hand: discovery
// must come from Postman/OpenAPI or a verified yano-architect fallback.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { globalDataPath, resolveYanoConfig } from "./yano-config.mjs";
import { parse as parseYaml } from "yaml";

const VERSION = 2;
const NAME = /^[a-z][a-z0-9._-]{1,80}$/i;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const arg = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1] || null; };
const has = (argv, flag) => argv.includes(flag);
const now = () => new Date().toISOString();

export function projectApiRegistryPath(root) { return path.join(path.resolve(root), ".pi", "extensions", "yano-orchestrator", "config", "apis.json"); }
export function globalApiRegistryPath() { return path.join(globalDataPath({ env: process.env }), "apis", "apis.json"); }
function fileFor(scope, root) { return scope === "global" ? globalApiRegistryPath() : projectApiRegistryPath(root); }
function read(file) { try { const v = JSON.parse(fs.readFileSync(file, "utf8")); return { version: VERSION, apis: Array.isArray(v.apis) ? v.apis : [] }; } catch { return { version: VERSION, apis: [] }; } }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }
function clean(value) { return String(value || "").trim(); }
function jsonMaybe(value) { try { return JSON.parse(value); } catch { return null; } }
function resolveTemplate(value, variables = {}) { return String(value || "").replace(/\{\{([^}]+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`); }
function safePath(value) { return new URL(value, "https://placeholder.invalid").pathname || "/"; }

function normalizeEndpoint({ method, url, name, description = "", parameters = [], request_body = null, responses = [] }) {
	const normalizedMethod = String(method || "").toUpperCase(); if (!METHODS.has(normalizedMethod)) return null;
	try { new URL(url); } catch { return null; }
	return { name: clean(name) || `${normalizedMethod} ${safePath(url)}`, method: normalizedMethod, path: safePath(url), description: clean(description), parameters, request_body, responses };
}
function postmanItems(items = [], variables = {}) {
	const endpoints = [];
	for (const item of items) {
		if (Array.isArray(item.item)) endpoints.push(...postmanItems(item.item, variables));
		const request = item.request; if (!request) continue;
		const raw = typeof request.url === "string" ? request.url : request.url?.raw; const url = resolveTemplate(raw, variables); if (!url || url.includes("{{")) continue;
		const headers = Object.fromEntries((request.header || []).map((h) => [String(h.key || "").toLowerCase(), h.value]));
		const parsedBody = request.body?.raw ? jsonMaybe(request.body.raw) : null;
		// Keep request options, never example values: Postman collections can
		// contain tokens/passwords in raw bodies and the registry is persistent.
		const body = request.body ? { mode: request.body.mode || null, content_type: request.header?.find((h) => String(h.key).toLowerCase() === "content-type")?.value || null, fields: parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? Object.keys(parsedBody) : [] } : null;
		const endpoint = normalizeEndpoint({ method: request.method, url, name: item.name, description: request.description, parameters: request.url?.query || [], request_body: body });
		if (endpoint) { endpoint.auth_header = headers["x-api-key"] !== undefined ? "x-api-key" : headers.authorization !== undefined ? "Authorization" : null; endpoints.push(endpoint); }
	}
	return endpoints;
}
function openApiEndpoints(document, baseUrl) {
	const doc = document?.openapi || document?.swagger ? document : null; if (!doc) throw new Error("specifica non riconosciuta: atteso OpenAPI/Swagger");
	const server = baseUrl || doc.servers?.[0]?.url || (doc.host ? `${doc.schemes?.[0] || "https"}://${doc.host}${doc.basePath || ""}` : null); if (!server) throw new Error("OpenAPI valida ma manca --base-url e servers[0].url");
	const endpoints = [];
	for (const [route, operations] of Object.entries(doc.paths || {})) for (const [method, operation] of Object.entries(operations || {})) {
		if (!METHODS.has(method.toUpperCase())) continue;
		const params = [...(operations.parameters || []), ...(operation.parameters || [])].filter((p) => p && typeof p === "object").map((p) => ({ name: p.name, in: p.in, required: !!p.required, schema: p.schema || { type: p.type } }));
		const body = operation.requestBody?.content || (operation.parameters || []).find((p) => p.in === "body")?.schema || null;
		const endpoint = normalizeEndpoint({ method, url: `${server.replace(/\/$/, "")}${route}`, name: operation.operationId || `${method.toUpperCase()} ${route}`, description: operation.summary || operation.description, parameters: params, request_body: body, responses: Object.keys(operation.responses || {}) });
		if (endpoint) endpoints.push(endpoint);
	}
	return { baseUrl: server.replace(/\/$/, ""), endpoints };
}
function parseLocalPcDiscovery(value) {
	const raw = typeof value === "string" ? value : JSON.stringify(value || "");
	const candidates = [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]];
	for (const candidate of candidates.filter(Boolean)) {
		try {
			const parsed = JSON.parse(candidate);
			const base = clean(parsed.base_url);
			const endpoints = Array.isArray(parsed.endpoints) ? parsed.endpoints.map((endpoint) => normalizeEndpoint({ ...endpoint, url: new URL(endpoint.path, `${base.replace(/\/$/, "")}/`).toString() })).filter(Boolean) : [];
			if (!base || !/^https?:\/\//i.test(base) || !endpoints.length) continue;
			return { kind: "local-pc", source: base, base_url: base.replace(/\/$/, ""), endpoints, source_hash: `local-pc:${Date.now()}`, evidence: parsed.evidence || null };
		} catch { /* local-pc may have included a short explanation around the JSON */ }
	}
	return null;
}

function architectTarget(root) {
	const snapshot = spawnSync("herdr", ["api", "snapshot"], { encoding: "utf8", maxBuffer: 8_000_000 });
	if (snapshot.status !== 0) return null;
	try {
		const parsed = JSON.parse(snapshot.stdout || "");
		const state = parsed?.result?.snapshot || parsed?.result || parsed;
		const candidates = [...(state?.agents || []), ...(state?.panes || [])].filter((item) => !["done", "offline", "unknown"].includes(String(item.agent_status || "").toLowerCase()));
		return candidates.find((item) => String(item.name || item.agent || "").startsWith("architect-") && (!item.cwd || path.resolve(item.cwd) === path.resolve(root)))?.name || candidates.find((item) => String(item.name || "").startsWith("architect-"))?.name || null;
	} catch { return null; }
}

async function discoverViaArchitect({ baseUrl, root, timeoutMs = 180000 }) {
	if (!clean(baseUrl)) throw new Error("senza Postman/OpenAPI è obbligatorio fornire --base-url per la discovery tramite yano-architect");
	const target = architectTarget(root);
	if (!target) throw new Error("yano-architect non è attivo nel workspace del progetto: avvialo e ripeti la discovery");
	console.error("yano api: nessuna collection Postman o specifica OpenAPI fornita; sto tentando la discovery tramite yano-architect. Attendi il risultato...");
	const prompt = [
		"Devi fare discovery e test di una REST API per il comando yano api discover.",
		`URL base da verificare: ${clean(baseUrl)}`,
		"Cerca solo documentazione realmente raggiungibile (OpenAPI/Swagger e varianti comuni) o endpoint documentati dall'API. Non inventare endpoint.",
		"Esegui esclusivamente test sicuri e non mutanti, preferibilmente GET/HEAD; non inviare POST, PUT, PATCH o DELETE.",
		"Rispondi con JSON valido e nient'altro, nel formato: {\"base_url\":\"https://...\",\"endpoints\":[{\"name\":\"...\",\"method\":\"GET\",\"path\":\"/path\",\"description\":\"...\"}],\"evidence\":\"URL o file realmente usato\"}. Se non puoi identificare e testare endpoint reali, rispondi {\"error\":\"motivo\"}.",
	].join("\n");
	const sent = spawnSync("herdr", ["agent", "prompt", target, prompt, "--wait", "--until", "idle", "--timeout", String(timeoutMs)], { cwd: root, encoding: "utf8", maxBuffer: 8_000_000, timeout: timeoutMs + 10_000 });
	if (sent.status !== 0) throw new Error(`yano-architect non ha completato la discovery: ${(sent.stderr || sent.stdout || "errore di comunicazione").trim()}`);
	const output = spawnSync("herdr", ["agent", "read", target, "--source", "recent-unwrapped", "--lines", "240", "--format", "text"], { cwd: root, encoding: "utf8", maxBuffer: 8_000_000 });
	const discovery = parseLocalPcDiscovery(output.stdout || output.stderr);
	if (!discovery) {
		throw new Error("yano-architect non ha trovato una specifica o endpoint reali e verificabili");
	}
	return discovery;
}

async function loadSource({ postman, spec, baseUrl, root, timeoutMs }) {
	if (postman && spec) throw new Error("specificare una sola sorgente: --postman oppure --spec"); if (!postman && !spec) return discoverViaArchitect({ baseUrl, root, timeoutMs });
	if (postman) { const file = path.resolve(postman); if (!fs.existsSync(file)) throw new Error(`collection Postman non trovata: ${file}`); const collection = JSON.parse(fs.readFileSync(file, "utf8")); const variables = Object.fromEntries((collection.variable || []).map((v) => [v.key, v.value])); const effectiveBase = clean(baseUrl || variables.base_url_prod || variables.base_url); if (!effectiveBase) throw new Error("collection Postman trovata ma base URL assente: fornire --base-url"); const discovered = postmanItems(collection.item, { ...variables, base_url_prod: effectiveBase, base_url: effectiveBase }); const unique = [...new Map(discovered.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint])).values()]; if (!unique.length) throw new Error("collection Postman valida ma nessun endpoint con URL risolvibile"); const stat = fs.statSync(file); return { kind: "postman", source: file, base_url: effectiveBase.replace(/\/$/, ""), endpoints: unique, source_hash: `${stat.size}:${stat.mtimeMs}` }; }
	let text; let source = spec; if (/^https?:\/\//i.test(spec)) { const response = await fetch(spec, { signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error(`spec URL HTTP ${response.status}`); text = await response.text(); } else { source = path.resolve(spec); if (!fs.existsSync(source)) throw new Error(`specifica OpenAPI non trovata: ${source}`); text = fs.readFileSync(source, "utf8"); }
	let document; try { document = JSON.parse(text); } catch { document = parseYaml(text); } const parsed = openApiEndpoints(document, baseUrl); if (!parsed.endpoints.length) throw new Error("specifica OpenAPI valida ma non contiene endpoint supportati"); return { kind: "openapi", source, base_url: parsed.baseUrl, endpoints: parsed.endpoints, source_hash: String(text.length) };
}
function validateAuth(authEnv, authHeader) { if (authEnv && !/^[A-Z][A-Z0-9_]*$/.test(authEnv)) throw new Error("--auth-config-key deve essere una variabile Yano valida"); if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(authHeader)) throw new Error("--auth-header non valido"); }
export function listProjectApis(root, { includeGlobal = true } = {}) { const project = read(projectApiRegistryPath(root)).apis.map((api) => ({ ...api, scope: "project" })); if (!includeGlobal) return project; const names = new Set(project.map((api) => api.name)); return [...project, ...read(globalApiRegistryPath()).apis.filter((api) => !names.has(api.name)).map((api) => ({ ...api, scope: "global" }))]; }
export function getProjectApi(root, name) { return listProjectApis(root).find((api) => api.name === name) || null; }
export function resolveApiSecret(api) { return api.auth_env ? resolveYanoConfig({})[api.auth_env] || process.env[api.auth_env] || null : null; }
function redacted(api) { return { ...api, auth_env: api.auth_env ? "[configured variable]" : null }; }
async function verifyDiscovered(api) { const secret = resolveApiSecret(api); if (api.auth_env && !secret) return { status: "blocked", reason: `credenziale ${api.auth_env} non configurata`, checks: [] }; const checks = []; for (const endpoint of api.endpoints.filter((e) => e.method === "GET")) { const started = Date.now(); const headers = { accept: "application/json, text/plain, */*" }; if (secret) headers[api.auth_header || "x-api-key"] = secret; try { const response = await fetch(new URL(endpoint.path, `${api.base_url}/`), { method: endpoint.method, headers, signal: AbortSignal.timeout(20_000) }); checks.push({ method: endpoint.method, path: endpoint.path, status: response.status, ok: response.ok, ms: Date.now() - started }); } catch (error) { checks.push({ method: endpoint.method, path: endpoint.path, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }); } } return { status: checks.length && checks.every((c) => c.ok) ? "healthy" : checks.length ? "degraded" : "not_tested", checks, tested_safe_methods_only: true }; }
export function apiUsage() { return ["Uso: yano api <discover|list|show|add|verify|refresh|update|delete> [opzioni]", "", "  discover/add --name <id> --base-url <url> [--postman <file.json> | --spec <file|URL>]", "                 [--auth-config-key <YANO_KEY>] [--auth-header <header>] [--scope project|global]", "  Se manca --postman/--spec, la discovery viene delegata a yano-architect (solo test sicuri).", "  verify --name <id> [--scope project|global] [--project-root <dir>]", "  refresh --name <id> [--scope project|global] [--project-root <dir>]", "  Le chiavi restano in yano config; add registra solo dopo discovery."]; }
export async function runYanoApi({ cwd = process.cwd(), argv = [] } = {}) {
	const sub = argv[0]; if (!sub || has(argv, "--help") || has(argv, "-h")) { console.log(apiUsage().join("\n")); return; } const root = path.resolve(arg(argv, "--project-root") || cwd); const scopeArg = arg(argv, "--scope") || "project"; if (!["project", "global", "effective"].includes(scopeArg)) throw new Error("--scope deve essere project, global o effective"); const scope = scopeArg === "effective" ? "project" : scopeArg; const file = fileFor(scope, root); const registry = read(file); const name = arg(argv, "--name");
	if (sub === "list") { const apis = scopeArg === "effective" ? listProjectApis(root) : registry.apis.map((api) => ({ ...api, scope })); const result = { scope: scopeArg, project_root: root, registry: file, apis: apis.map(redacted) }; console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "discover" || sub === "add") { const source = await loadSource({ postman: arg(argv, "--postman"), spec: arg(argv, "--spec"), baseUrl: arg(argv, "--base-url"), root, timeoutMs: Number(arg(argv, "--timeout-ms") || 180000) }); const api = { name: name || "discovered-api", base_url: source.base_url, description: arg(argv, "--description") || `API discovered from ${source.kind}`, auth_env: arg(argv, "--auth-config-key"), auth_header: arg(argv, "--auth-header") || "x-api-key", methods: [...new Set(source.endpoints.map((e) => e.method))], endpoints: source.endpoints, discovery: { kind: source.kind, source: source.source, source_hash: source.source_hash, evidence: source.evidence || null, discovered_at: now() }, enabled: true }; validateAuth(api.auth_env, api.auth_header); const verification = await verifyDiscovered(api); const result = { ...redacted(api), verification, registered: false, source: source.source }; if (sub === "add") { if (registry.apis.some((item) => item.name === name)) throw new Error(`yano api: ${name} esiste già; usa update o delete`); if (verification.status === "blocked") throw new Error(`yano api: discovery bloccata: ${verification.reason}`); registry.apis.push({ ...api, last_verification: verification, created_at: now(), updated_at: now() }); write(file, registry); result.registered = true; result.registry = file; } console.log(JSON.stringify(result, null, 2)); return result; }
	if (!name) throw new Error("yano api: --name è obbligatorio"); const index = registry.apis.findIndex((api) => api.name === name); if (index < 0) throw new Error(`yano api: ${name} non trovata nello scope ${scope}`); const api = registry.apis[index];
	if (sub === "show") { const result = redacted(api); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "verify") { const verification = await verifyDiscovered(api); api.last_verification = verification; api.updated_at = now(); write(file, registry); console.log(JSON.stringify({ name, verification }, null, 2)); return verification; }
	if (sub === "refresh") { const source = await loadSource({ postman: api.discovery?.kind === "postman" ? api.discovery.source : null, spec: api.discovery?.kind === "openapi" ? api.discovery.source : null, baseUrl: api.base_url, root, timeoutMs: Number(arg(argv, "--timeout-ms") || 180000) }); const refreshed = { ...api, base_url: source.base_url, methods: [...new Set(source.endpoints.map((e) => e.method))], endpoints: source.endpoints, discovery: { kind: source.kind, source: source.source, source_hash: source.source_hash, evidence: source.evidence || null, discovered_at: now() }, updated_at: now() }; refreshed.last_verification = await verifyDiscovered(refreshed); registry.apis[index] = refreshed; write(file, registry); const result = redacted(refreshed); console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "delete") { registry.apis.splice(index, 1); write(file, registry); const result = { deleted: name, scope, registry: file }; console.log(JSON.stringify(result, null, 2)); return result; }
	if (sub === "update") { const description = arg(argv, "--description"); const authEnv = arg(argv, "--auth-config-key"); if (description) api.description = description; if (authEnv) { validateAuth(authEnv, api.auth_header || "x-api-key"); api.auth_env = authEnv; } api.updated_at = now(); write(file, registry); const result = redacted(api); console.log(JSON.stringify(result, null, 2)); return result; }
	throw new Error(`yano api: sottocomando sconosciuto ${sub}`);
}
