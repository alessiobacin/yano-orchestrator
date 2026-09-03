#!/usr/bin/env node

// Configuration shared by the global CLI and the Yano development checkout.
// Secrets never belong to the npm package: global values live in a per-user
// config file and are loaded into child processes only when needed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_SPECS = Object.freeze([
	{ key: "YANO_ORCHESTRATOR_REPO", description: "checkout usato per i ticket di manutenzione Yano" },
	{ key: "YANO_DATA_DIR", description: "directory globale per trace, snapshot e indice" },
	{ key: "YANO_TEMP_DIR", description: "alias legacy della directory globale Yano" },
	{ key: "YANO_TRACE_MODE", description: "modalità trace predefinita: off|events|standard|full" },
	{ key: "YANO_FEEDBACK_API_PORT", description: "porta HTTP per l'API REST bug/suggestions (default 20002)" },
	{ key: "YANO_AUTO_IMPROVER_API_PORT", description: "porta HTTP per l'API REST di auto-improver (yano auto-improve serve; default 4178)" },
	{ key: "YANO_AUTO_IMPROVER_API_TOKEN", secret: true, description: "token Bearer opzionale per proteggere l'API REST di auto-improver" },
	{ key: "YANO_LLMPROXY_URL", description: "base URL del servizio llmProxy usato dal model-advisor (default http://127.0.0.1:7045)" },
	{ key: "YANO_LLMPROXY_API_KEY", secret: true, description: "API key opzionale per l'API REST di llmProxy (Authorization: Bearer), se il gate è attivo" },
	{ key: "LLMPROXY_INFERENCE_INFO_INLINE", description: "llmProxy: include inline le informazioni di inferenza" },
	{ key: "LLMPROXY_METERING_INLINE", description: "llmProxy: include inline i dati di metering" },
	{ key: "LLMPROXY_PROVIDER_CREDIT_INLINE", description: "llmProxy: include inline il credito del provider" },
	{ key: "LLMPROXY_SHORT_ANSWER", description: "llmProxy: abilita la risposta breve" },
	{ key: "YANO_OLLAMA_URL", description: "endpoint Ollama per gli embeddings" },
	{ key: "OLLAMA_HOST", description: "endpoint Ollama legacy/compatibilità" },
	{ key: "YANO_EMBEDDING_MODEL", description: "modello Ollama per gli embeddings" },
	{ key: "PI_ORCH_BROKER_URL", description: "broker MQTT" },
	{ key: "PI_ORCH_AWAY", description: "modalità silenziosa del watcher: 1" },
	{ key: "PI_ORCH_MAX_HOPS", description: "massimo numero di hop tra agenti" },
	{ key: "PI_ORCH_TIMEOUT_MS", description: "timeout delle deleghe agente" },
	{ key: "PI_ORCH_HEARTBEAT_MS", description: "intervallo heartbeat agente" },
	{ key: "PI_ORCH_STALE_AFTER_MS", description: "soglia di presenza stale" },
	{ key: "PI_ORCH_WATCHDOG_INTERVAL_MS", description: "intervallo watchdog interno" },
	{ key: "PI_ORCH_WATCHDOG_STALL_MS", description: "soglia ticket stalled" },
	{ key: "PI_ORCH_WATCHDOG_FINALIZE_GRACE_MS", description: "grace period dopo finalize" },
	{ key: "PI_ORCH_WATCHDOG_AUTO_TERMINATE", description: "abilita auto-terminate watchdog: true" },
	{ key: "PI_ORCH_WATCHDOG_AUTO_TERMINATE_MS", description: "soglia auto-terminate watchdog" },
	{ key: "EVOLUTION_API_URL", description: "URL Evolution API" },
	{ key: "EVOLUTION_API_KEY", secret: true, description: "chiave Evolution API" },
	{ key: "EVOLUTION_INSTANCE_NAME", description: "istanza WhatsApp Evolution API" },
	{ key: "DESTINATION_PHONE_NUMBER", description: "numero WhatsApp destinatario" },
	{ key: "TELEGRAM_BOT_TOKEN", secret: true, description: "token del bot Telegram" },
	{ key: "TELEGRAM_DESTINATION_CHAT_ID", description: "chat Telegram destinataria" },
	{ key: "YANO_COMPUTER_LOCAL_ASSEMBLYAI_API_KEY", secret: true, description: "chiave AssemblyAI per il MCP dei memo vocali del Computer locale" },
	{ key: "SENDGRID_API_KEY", secret: true, description: "chiave API SendGrid" },
	{ key: "SENDGRID_FROM_EMAIL", description: "mittente SendGrid verificato" },
	{ key: "SENDGRID_TO_EMAIL", description: "destinatario/i SendGrid separati da virgola" },
	{ key: "SENDGRID_SUBJECT", description: "oggetto opzionale delle email" },
]);

const SPEC_BY_KEY = new Map(CONFIG_SPECS.map((spec) => [spec.key, spec]));

const RESERVED_DYNAMIC_KEYS = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]);

export function isConfigKey(key) {
	const normalized = String(key || "");
	return /^[A-Z][A-Z0-9_]*$/.test(normalized) && !RESERVED_DYNAMIC_KEYS.has(normalized) && !normalized.startsWith("DYLD_");
}

export function configSpec(key) {
	const normalized = String(key || "");
	if (SPEC_BY_KEY.has(normalized)) return SPEC_BY_KEY.get(normalized);
	if (!isConfigKey(normalized)) return undefined;
	return { key: normalized, secret: /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(normalized), description: "variabile richiesta da un playbook o da una capability" };
}

export function globalConfigPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
	if (env.YANO_CONFIG_FILE) return path.resolve(env.YANO_CONFIG_FILE);
	if (env.XDG_CONFIG_HOME) return path.join(path.resolve(env.XDG_CONFIG_HOME), "yano", "config.env");
	if (platform === "darwin") return path.join(home, "Library", "Application Support", "yano", "config.env");
	if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "yano", "config.env");
	return path.join(home, ".config", "yano", "config.env");
}

/** Per-user data root, kept separate from the installed package. */
export function globalDataPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
	if (env.YANO_DATA_DIR) return path.resolve(env.YANO_DATA_DIR);
	if (env.YANO_TEMP_DIR) return path.resolve(env.YANO_TEMP_DIR);
	if (env.XDG_DATA_HOME) return path.join(path.resolve(env.XDG_DATA_HOME), "yano");
	if (platform === "darwin") return path.join(home, "Library", "Application Support", "yano", "data");
	if (platform === "win32") return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(home, "AppData", "Local"), "yano", "data");
	return path.join(home, ".local", "share", "yano");
}

export function parseEnvText(text) {
	const values = {};
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		values[match[1]] = value;
	}
	return values;
}

export function loadConfigFile(file = globalConfigPath()) {
	try { return parseEnvText(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function loadPackageEnv(packageRoot) {
	if (!packageRoot) return {};
	try { return parseEnvText(fs.readFileSync(path.join(packageRoot, ".env"), "utf8")); } catch { return {}; }
}

// Package checkout .env wins in development; global config is the fallback
// for npm-only installations. The process environment is deliberately not
// used to resolve YANO_ORCHESTRATOR_REPO, avoiding accidental cross-project
// routing from a shell variable.
export function resolveYanoConfig({ packageRoot = null, env = process.env } = {}) {
	const global = loadConfigFile(globalConfigPath({ env }));
	const packageEnv = loadPackageEnv(packageRoot);
	// Shell/CI variables remain a normal last-resort override for runtime
	// settings and test seams. YANO_ORCHESTRATOR_REPO is the exception: it is
	// intentionally removed so a random shell value cannot redirect tickets.
	const explicit = { ...env };
	delete explicit.YANO_ORCHESTRATOR_REPO;
	return { ...global, ...packageEnv, ...explicit };
}

export function applyGlobalConfig({ packageRoot = null, env = process.env } = {}) {
	const values = resolveYanoConfig({ packageRoot, env });
	for (const [key, value] of Object.entries(values)) if (isConfigKey(key) && !env[key] && value) env[key] = value;
	return values;
}

function quoteEnvValue(value) {
	const text = String(value);
	return /^[A-Za-z0-9_./:@%+,=-]+$/.test(text) ? text : JSON.stringify(text);
}

function writeConfig(values, file) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const lines = [
		"# Yano global user configuration — chmod 600; never commit this file.",
		"# Set values with: yano config set KEY VALUE (or --stdin for secrets)",
	];
	const keys = new Set([...CONFIG_SPECS.map((spec) => spec.key), ...Object.keys(values).filter(isConfigKey)]);
	for (const key of [...keys].sort()) if (values[key] !== undefined && values[key] !== "") lines.push(`${key}=${quoteEnvValue(values[key])}`);
	lines.push("");
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, lines.join("\n"), { mode: 0o600 });
	fs.chmodSync(temporary, 0o600);
	fs.renameSync(temporary, file);
}

function assertConfigKey(key) {
	if (!configSpec(key)) throw new Error(`nome variabile non valido: ${key}. Usa un nome uppercase come MY_SERVICE_API_KEY.`);
}

function redacted(spec, value, showSecrets = false) {
	if (value === undefined || value === "") return "<non valorizzata>";
	if (spec?.secret && !showSecrets) return "<valorizzata: valore nascosto>";
	return value;
}

export function configUsage() {
	return [
		"Uso: yano config <path|list|get|set|unset> [opzioni]",
		"",
		"  path                         mostra il file globale (mai il contenuto)",
		"  list [--all]                 mostra configurazione, segreti oscurati",
		"  get <KEY> [--show]           legge una variabile; --show rivela un segreto esplicitamente",
		"  set <KEY> <VALUE>            salva una variabile globale (anche per playbook importati)",
		"  set <KEY> --stdin            legge il valore da stdin, consigliato per segreti",
		"  unset <KEY>                  rimuove una variabile globale",
		"",
		"Il file globale non viene inserito nel pacchetto npm e non dipende dal repository di sviluppo.",
		"YANO_DATA_DIR è opzionale: se omesso, Yano sceglie automaticamente la directory dati della piattaforma.",
	].join("\n");
}

export function missingConfigError(command, keys, { packageRoot = null } = {}) {
	const unique = [...new Set(keys)].filter(Boolean);
	const commands = unique.map((key) => configSpec(key)?.secret
		? `  yano config set ${key} --stdin`
		: `  yano config set ${key} <valore>`).join("\n");
	const devHint = packageRoot ? `\nIn sviluppo puoi anche valorizzarle in ${path.join(packageRoot, ".env")} (mai nel pacchetto npm globale).` : "";
	const error = new Error([`yano ${command}: configurazione mancante: ${unique.join(", ")}.`, "Imposta le variabili globali con:", commands, devHint].filter(Boolean).join("\n"));
	error.code = "YANO_CONFIG_MISSING";
	error.missing = unique;
	return error;
}

export async function runYanoConfig({ argv = [] } = {}) {
	const sub = argv[0];
	if (!sub || sub === "--help" || sub === "-h") { console.log(configUsage()); return; }
	const file = globalConfigPath();
	const values = loadConfigFile(file);
	if (sub === "path") { console.log(file); return { path: file }; }
	if (sub === "list") {
		const storedDynamic = Object.keys(values).filter((key) => !SPEC_BY_KEY.has(key) && isConfigKey(key)).map((key) => configSpec(key));
		const specs = argv.includes("--all") ? [...CONFIG_SPECS, ...storedDynamic] : [...CONFIG_SPECS, ...storedDynamic].filter((spec) => values[spec.key]);
		for (const spec of specs) console.log(`${spec.key}=${redacted(spec, values[spec.key])}  # ${spec.description}`);
		return values;
	}
	if (sub === "get") {
		const key = argv[1];
		assertConfigKey(key);
		console.log(redacted(configSpec(key), values[key], argv.includes("--show")));
		return values[key];
	}
	if (sub === "set") {
		const key = argv[1];
		assertConfigKey(key);
		const stdin = argv.includes("--stdin");
		let next = stdin ? fs.readFileSync(0, "utf8").trimEnd() : argv[2];
		if (next === "--stdin") next = undefined;
		if (!next) throw new Error(`config set: manca il valore per ${key}. Per un segreto usa: yano config set ${key} --stdin`);
		values[key] = next;
		writeConfig(values, file);
		console.log(`yano config: ${key} salvata in ${file} (valore ${configSpec(key)?.secret ? "nascosto" : "impostato"}).`);
		return values[key];
	}
	if (sub === "unset") {
		const key = argv[1];
		assertConfigKey(key);
		delete values[key];
		writeConfig(values, file);
		console.log(`yano config: ${key} rimossa da ${file}.`);
		return;
	}
	throw new Error(`sottocomando config sconosciuto \"${sub}\".\n${configUsage()}`);
}
