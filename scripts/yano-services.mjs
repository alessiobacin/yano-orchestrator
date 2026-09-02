#!/usr/bin/env node

// `yano services` — declarative registry of external services Yano depends on
// operationally but does not own: a local LLM router (llmProxy), the Docker
// daemon itself, an MQTT broker container, a pm2-managed process, or any
// other command/container the operator wants supervised. `yano watcher
// supervise` (the same one-minute cron loop that already heals dead Herdr
// panes and unfinalized SQLite runs — see yano-watcher-registry.mjs) health-
// checks every registered, enabled service on each pass and restarts it
// deterministically when the check fails, with bounded exponential backoff.
//
// This is what makes the fleet recover on its own after a computer restart
// or a crashed container/pm2 process, instead of silently degrading (see
// .env.example on yano-model-advisor: llmProxy unreachable today just
// degrades every role to "auto" with no attempt to bring it back).
//
// Uso:
//   yano services add --name <nome> \
//     --healthcheck-http <url> | --healthcheck-command "<comando>" \
//     --restart-docker <container> | --restart-pm2 <app> | --restart-command "<comando>" \
//     [--timeout-ms 2000] [--backoff-base-ms 5000] [--backoff-max-ms 300000] [--max-attempts 6] [--json]
//   yano services list [--json]
//   yano services remove --name <nome> [--json]
//   yano services enable|disable --name <nome> [--json]
//   yano services check [--name <nome>] [--json]       # sola lettura, nessun restart
//   yano services supervise [--json]                   # health-check + restart deterministico (chiamato anche da `yano watcher supervise`)

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { globalDataPath } from "./yano-config.mjs";

const REGISTRY_VERSION = 1;
const VALID_HEALTHCHECK_TYPES = new Set(["http", "command"]);
const VALID_RESTART_TYPES = new Set(["docker", "pm2", "command"]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const BUILTIN_DEPENDENCIES = [
	{ name: "llmproxy", containerEnv: "YANO_LLMPROXY_CONTAINER", defaultContainer: "llmproxy-production" },
	{ name: "mqtt", containerEnv: "YANO_MQTT_CONTAINER", defaultContainer: "pi-orchestrator-mqtt-dev" },
];

export function servicesRegistryPath() {
	return path.join(globalDataPath({ env: process.env }), "services", "services.json");
}

function readRegistry() {
	try {
		const value = JSON.parse(fs.readFileSync(servicesRegistryPath(), "utf8"));
		return { version: REGISTRY_VERSION, services: Array.isArray(value.services) ? value.services : [] };
	} catch {
		return { version: REGISTRY_VERSION, services: [] };
	}
}

function writeRegistry(registry) {
	const file = servicesRegistryPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(temporary, 0o600);
	fs.renameSync(temporary, file);
}

function defaultState() {
	return { status: "unknown", last_check_at: null, last_ok_at: null, consecutive_failures: 0, last_restart_at: null, restart_attempts_since_ok: 0, last_restart_result: null };
}

function dockerContainerExists(container) {
	const result = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", container], { encoding: "utf8", timeout: 3000 });
	return result.status === 0;
}

function builtinServices(registry) {
	if (String(process.env.YANO_DISABLE_BUILTIN_DEPENDENCY_SUPERVISION || "0") === "1") return [];
	if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 3000 }).status !== 0) return [];
	return BUILTIN_DEPENDENCIES.map((definition) => {
		const container = process.env[definition.containerEnv] || definition.defaultContainer;
		return dockerContainerExists(container) ? {
			name: definition.name,
			builtin: true,
			healthcheck: { type: "command", target: `docker inspect --format '{{.State.Running}}' ${JSON.stringify(container)} | grep -q true`, timeout_ms: 3000 },
			restart: { type: "docker", target: container },
			enabled: true,
			backoff: { base_ms: 5000, max_ms: 300000, max_attempts: 6 },
			created_at: new Date().toISOString(),
			state: defaultState(),
		} : null;
	}).filter(Boolean).filter((service) => !registry.services.some((existing) => existing.name === service.name));
}

export function listServices({ includeBuiltIns = false } = {}) {
	const registry = readRegistry();
	return includeBuiltIns ? [...registry.services, ...builtinServices(registry)] : registry.services;
}

export function getService(name) {
	return readRegistry().services.find((service) => service.name === name) || null;
}

// Deliberately trusts the target the operator declares (an arbitrary shell
// command for `--restart-command`/`--healthcheck-command`, exactly like
// `yano config set` already trusts arbitrary env values): this registry is
// local, per-user configuration, not input from a watched project or the
// network. `yano watcher supervise` executes these commands unattended on a
// one-minute cadence, so only register services/commands you trust.
export function addService({ name, healthcheck, restart, enabled = true, backoff = {} }) {
	if (!name || !NAME_PATTERN.test(name)) throw new Error("yano services: nome non valido (lettere/numeri/-/_ , non può iniziare con - o _)");
	if (!healthcheck || !VALID_HEALTHCHECK_TYPES.has(healthcheck.type) || !String(healthcheck.target || "").trim()) throw new Error("yano services: serve --healthcheck-http <url> oppure --healthcheck-command \"<comando>\"");
	if (!restart || !VALID_RESTART_TYPES.has(restart.type) || !String(restart.target || "").trim()) throw new Error("yano services: serve --restart-docker <container>, --restart-pm2 <app> oppure --restart-command \"<comando>\"");
	const registry = readRegistry();
	if (registry.services.some((service) => service.name === name)) throw new Error(`yano services: "${name}" esiste già — usa "yano services remove --name ${name}" prima di ricrearlo`);
	const service = {
		name,
		healthcheck: { timeout_ms: 2000, ...healthcheck },
		restart,
		enabled,
		backoff: { base_ms: 5000, max_ms: 300000, max_attempts: 6, ...backoff },
		created_at: new Date().toISOString(),
		state: defaultState(),
	};
	registry.services.push(service);
	writeRegistry(registry);
	return service;
}

export function removeService(name) {
	const registry = readRegistry();
	const before = registry.services.length;
	registry.services = registry.services.filter((service) => service.name !== name);
	const removed = registry.services.length < before;
	if (removed) writeRegistry(registry);
	return { removed };
}

export function setServiceEnabled(name, enabled) {
	const registry = readRegistry();
	const service = registry.services.find((item) => item.name === name);
	if (!service) throw new Error(`yano services: "${name}" non trovato — vedi "yano services list"`);
	service.enabled = enabled;
	writeRegistry(registry);
	return service;
}

async function runHealthcheck(service) {
	const timeoutMs = service.healthcheck.timeout_ms || 2000;
	if (service.healthcheck.type === "http") {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(service.healthcheck.target, { signal: controller.signal });
			return { ok: response.ok, detail: `http_${response.status}` };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}
	// `command`: exit code 0 is healthy. Runs through the shell so the operator
	// can declare a pipeline (`docker inspect -f {{.State.Running}} x | grep true`)
	// without a second wrapper script; `timeout` here is best-effort (Node kills
	// the process but a grandchild can outlive it, same caveat as any spawnSync timeout).
	const result = spawnSync(service.healthcheck.target, { shell: true, timeout: timeoutMs, encoding: "utf8" });
	return { ok: result.status === 0, detail: result.error?.code === "ETIMEDOUT" ? "timeout" : `exit_${result.status ?? "unknown"}` };
}

function restartCommandFor(service) {
	if (service.restart.type === "docker") return { command: "docker", args: ["restart", service.restart.target] };
	if (service.restart.type === "pm2") return { command: "pm2", args: ["restart", service.restart.target] };
	return { command: service.restart.target, args: [], shell: true };
}

function runRestart(service) {
	const { command, args = [], shell = false } = restartCommandFor(service);
	const result = spawnSync(command, args, { shell, encoding: "utf8", timeout: 30_000 });
	const detail = result.status === 0
		? "restarted"
		: String(result.error?.code === "ETIMEDOUT" ? "timeout" : (result.stderr || result.stdout || `exit_${result.status ?? "unknown"}`)).slice(0, 500).trim();
	return { ok: result.status === 0, detail };
}

function backoffDueInMs(service, nowMs) {
	const attempts = service.state.restart_attempts_since_ok || 0;
	if (attempts === 0) return 0;
	const { base_ms, max_ms } = service.backoff;
	const delay = Math.min(max_ms, base_ms * 2 ** (attempts - 1));
	const last = Date.parse(service.state.last_restart_at || "");
	if (!Number.isFinite(last)) return 0;
	return Math.max(0, delay - (nowMs - last));
}

// One health-check, and — if unhealthy and the backoff window has elapsed —
// one restart attempt, per registered+enabled service. Exponential backoff
// (base_ms doubling up to max_ms) between restart attempts avoids hammering
// a target that needs time to come up (or never will). After
// `backoff.max_attempts` consecutive failed restarts a service is marked
// `giving_up`: it keeps being health-checked every pass (so an external fix
// is still picked up) but Yano stops trying to restart something that
// structurally cannot come back on its own (Docker not installed at all, a
// typo'd container name, ...) — a durable `unhealthy`/`giving_up` state is
// the deterministic signal an operator or a future alert channel can read
// instead of an infinite silent retry loop.
export async function superviseExternalServices({ now = new Date(), includeBuiltIns = false } = {}) {
	const registry = readRegistry();
	const discovered = includeBuiltIns ? builtinServices(registry) : [];
	if (discovered.length) registry.services.push(...discovered);
	const services = registry.services;
	const results = [];
	let changed = discovered.length > 0;
	for (const service of services) {
		if (!service.enabled) { results.push({ name: service.name, enabled: false, skipped: "disabled" }); continue; }
		service.state ||= defaultState();
		const check = await runHealthcheck(service);
		service.state.last_check_at = now.toISOString();
		changed = true;
		if (check.ok) {
			const recovered = service.state.status !== "healthy" && service.state.last_restart_at != null;
			service.state.status = "healthy";
			service.state.last_ok_at = now.toISOString();
			service.state.consecutive_failures = 0;
			service.state.restart_attempts_since_ok = 0;
			results.push({ name: service.name, healthy: true, recovered });
			continue;
		}
		service.state.consecutive_failures = (service.state.consecutive_failures || 0) + 1;
		if (service.state.status === "giving_up") {
			results.push({ name: service.name, healthy: false, restarted: false, reason: "giving_up", detail: check.detail });
			continue;
		}
		service.state.status = "unhealthy";
		const dueInMs = backoffDueInMs(service, now.getTime());
		if (dueInMs > 0) {
			results.push({ name: service.name, healthy: false, restarted: false, reason: "backoff", retry_in_ms: dueInMs, detail: check.detail });
			continue;
		}
		if ((service.state.restart_attempts_since_ok || 0) >= service.backoff.max_attempts) {
			service.state.status = "giving_up";
			results.push({ name: service.name, healthy: false, restarted: false, reason: "max_attempts_exhausted", detail: check.detail });
			continue;
		}
		const restart = runRestart(service);
		service.state.last_restart_at = now.toISOString();
		service.state.restart_attempts_since_ok = (service.state.restart_attempts_since_ok || 0) + 1;
		service.state.last_restart_result = restart;
		results.push({ name: service.name, healthy: false, restarted: true, restart_ok: restart.ok, restart_detail: restart.detail, attempt: service.state.restart_attempts_since_ok, healthcheck_detail: check.detail });
	}
	if (changed) writeRegistry(registry);
	return { checked_at: now.toISOString(), services: results };
}

// Read-only counterpart of `superviseExternalServices`: never restarts
// anything and never persists state, for a manual/diagnostic check.
export async function checkExternalServices({ name = null, includeBuiltIns = false } = {}) {
	const registry = readRegistry();
	const services = [...registry.services, ...(includeBuiltIns ? builtinServices(registry) : [])]
		.filter((service) => !name || service.name === name);
	const results = [];
	for (const service of services) {
		const check = await runHealthcheck(service);
		results.push({ name: service.name, enabled: service.enabled, ok: check.ok, detail: check.detail });
	}
	return { checked_at: new Date().toISOString(), services: results };
}

function value(argv, flag) {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : null;
}
function has(argv, flag) { return argv.includes(flag); }
function print(result, json) {
	if (json) { console.log(JSON.stringify(result, null, 2)); return; }
	console.log(result);
}

function usage() {
	return [
		"Uso: yano services <add|list|remove|enable|disable|check|supervise> [opzioni]",
		"",
		"  yano services add --name <nome> \\",
		"    --healthcheck-http <url> | --healthcheck-command \"<comando>\" \\",
		"    --restart-docker <container> | --restart-pm2 <app> | --restart-command \"<comando>\" \\",
		"    [--timeout-ms 2000] [--backoff-base-ms 5000] [--backoff-max-ms 300000] [--max-attempts 6] [--disabled] [--json]",
		"  yano services list [--json]",
		"  yano services remove --name <nome> [--json]",
		"  yano services enable --name <nome> [--json]",
		"  yano services disable --name <nome> [--json]",
		"  yano services check [--name <nome>] [--json]     sola lettura, nessun restart",
		"  yano services supervise [--json]                 health-check + restart deterministico con backoff",
		"",
		"`yano watcher supervise` (cron ogni minuto) chiama già `supervise` su ogni servizio abilitato: registrarlo qui basta perché il ripristino sia automatico dopo un riavvio del computer o un crash del container/processo.",
	].join("\n");
}

export async function runYanoServices({ argv = [] } = {}) {
	if (!argv.length || has(argv, "--help") || has(argv, "-h")) { console.log(usage()); return { help: true }; }
	const json = has(argv, "--json");
	const sub = argv[0];
	if (sub === "add") {
		const name = value(argv, "--name");
		const healthcheck = value(argv, "--healthcheck-http")
			? { type: "http", target: value(argv, "--healthcheck-http") }
			: value(argv, "--healthcheck-command")
				? { type: "command", target: value(argv, "--healthcheck-command") }
				: null;
		const restart = value(argv, "--restart-docker")
			? { type: "docker", target: value(argv, "--restart-docker") }
			: value(argv, "--restart-pm2")
				? { type: "pm2", target: value(argv, "--restart-pm2") }
				: value(argv, "--restart-command")
					? { type: "command", target: value(argv, "--restart-command") }
					: null;
		if (healthcheck && value(argv, "--timeout-ms")) healthcheck.timeout_ms = Number(value(argv, "--timeout-ms"));
		const backoff = {};
		if (value(argv, "--backoff-base-ms")) backoff.base_ms = Number(value(argv, "--backoff-base-ms"));
		if (value(argv, "--backoff-max-ms")) backoff.max_ms = Number(value(argv, "--backoff-max-ms"));
		if (value(argv, "--max-attempts")) backoff.max_attempts = Number(value(argv, "--max-attempts"));
		const service = addService({ name, healthcheck, restart, enabled: !has(argv, "--disabled"), backoff });
		print(service, json);
		return service;
	}
	if (sub === "list") {
		const result = listServices({ includeBuiltIns: true });
		print(result, json);
		return result;
	}
	if (sub === "remove") {
		const result = removeService(value(argv, "--name"));
		print(result, json);
		return result;
	}
	if (sub === "enable" || sub === "disable") {
		const result = setServiceEnabled(value(argv, "--name"), sub === "enable");
		print(result, json);
		return result;
	}
	if (sub === "check") {
		const result = await checkExternalServices({ name: value(argv, "--name"), includeBuiltIns: true });
		print(result, json);
		return result;
	}
	if (sub === "supervise") {
		const result = await superviseExternalServices();
		print(result, json);
		return result;
	}
	console.error(`yano services: sottocomando sconosciuto "${sub}" (vedi "yano services --help").`);
	process.exitCode = 1;
	return { error: `unknown_subcommand:${sub}` };
}

if (process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1])) {
	runYanoServices({ argv: process.argv.slice(2) }).catch((error) => {
		console.error(`yano services: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
