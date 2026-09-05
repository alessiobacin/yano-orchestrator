// Real test for the global notification channel fallback (Fase 0 of the
// cron/watcher/scheduler restructuring): a project with no notification
// channel configured in its own .env must fall back to the global
// `yano config` default (EVOLUTION_*/TELEGRAM_*/SENDGRID_* — already valid
// global config keys, see scripts/yano-config.mjs's CONFIG_SPECS) instead of
// silently sending nothing. A project that DOES configure its own channel
// must never be overridden by the global default.
//
// getEnvVar()'s precedence logic (process.env > project .env > global
// config) is small enough to mirror faithfully here, same convention as
// scripts/smoke-test-whatsapp-notify.mjs — but unlike that test, this one
// exercises the REAL globalConfigPath()/loadConfigFile() from
// scripts/yano-config.mjs (not a reimplementation) and additionally asserts
// the real extensions/orchestrator.ts source still contains the exact
// fallback expression, so the mirror below cannot silently drift from the
// real implementation over time.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigPath, loadConfigFile } from "./yano-config.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors loadEnvFile()/getEnvVar() from extensions/orchestrator.ts exactly.
function loadEnvFile(cwd) {
	const result = {};
	try {
		const raw = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
			result[key] = value;
		}
	} catch { /* no .env — fine */ }
	return result;
}
function getEnvVar(cwd, key, env) {
	return env[key] || loadEnvFile(cwd)[key] || loadConfigFile(globalConfigPath({ env })) [key] || undefined;
}

console.log("Fase 0: global notification channel fallback");
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok — ${name}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-global-notify-"));
const projectWithChannel = path.join(root, "project-with-channel");
const projectWithout = path.join(root, "project-without-channel");
fs.mkdirSync(projectWithChannel, { recursive: true });
fs.mkdirSync(projectWithout, { recursive: true });
fs.writeFileSync(path.join(projectWithChannel, ".env"), "TELEGRAM_BOT_TOKEN=project-own-token\nTELEGRAM_DESTINATION_CHAT_ID=project-own-chat\n");

const globalConfigFile = path.join(root, "config.env");
fs.writeFileSync(globalConfigFile, "TELEGRAM_BOT_TOKEN=global-default-token\nTELEGRAM_DESTINATION_CHAT_ID=global-default-chat\n");
const env = { YANO_CONFIG_FILE: globalConfigFile };

check("a project with its own .env channel is NEVER overridden by the global default", () => {
	assert.equal(getEnvVar(projectWithChannel, "TELEGRAM_BOT_TOKEN", env), "project-own-token");
	assert.equal(getEnvVar(projectWithChannel, "TELEGRAM_DESTINATION_CHAT_ID", env), "project-own-chat");
});

check("a project with NO channel configured falls back to the global default", () => {
	assert.equal(getEnvVar(projectWithout, "TELEGRAM_BOT_TOKEN", env), "global-default-token");
	assert.equal(getEnvVar(projectWithout, "TELEGRAM_DESTINATION_CHAT_ID", env), "global-default-chat");
});

check("with no global config at all, an unconfigured project still resolves to undefined (silent, as before)", () => {
	const noGlobal = { YANO_CONFIG_FILE: path.join(root, "does-not-exist.env") };
	assert.equal(getEnvVar(projectWithout, "TELEGRAM_BOT_TOKEN", noGlobal), undefined);
});

check("process.env still wins over both project .env and the global default", () => {
	assert.equal(getEnvVar(projectWithChannel, "TELEGRAM_BOT_TOKEN", { ...env, TELEGRAM_BOT_TOKEN: "shell-override" }), "shell-override");
});

check("the real extensions/orchestrator.ts source actually implements this fallback (guards the mirror above against drift)", () => {
	const source = fs.readFileSync(path.join(PACKAGE_ROOT, "extensions", "orchestrator.ts"), "utf8");
	assert.match(source, /loadEnvFile\(cwd\)\[key\]\s*\|\|\s*globalYanoConfig\(\)\[key\]/, "getEnvVar() must fall back to globalYanoConfig() after the project .env");
	assert.match(source, /globalConfigPath\(\)/, "globalYanoConfig() must read the same global config file yano-config.mjs / `yano config` uses");
	assert.match(source, /import\s*\{\s*globalConfigPath,\s*loadConfigFile\s*\}\s*from\s*"\.\.\/scripts\/yano-config\.mjs"/, "orchestrator.ts must import the real yano-config.mjs helpers, not reimplement them");
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nsmoke-test-global-notification-fallback: ${passed} passed`);
