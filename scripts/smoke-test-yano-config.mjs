import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSpec, globalConfigPath, loadConfigFile, missingConfigError, resolveYanoConfig, runYanoConfig } from "./yano-config.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-config-"));
const previous = {
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	YANO_ORCHESTRATOR_REPO: process.env.YANO_ORCHESTRATOR_REPO,
	TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
	TELEGRAM_DESTINATION_CHAT_ID: process.env.TELEGRAM_DESTINATION_CHAT_ID,
};
process.env.XDG_CONFIG_HOME = root;
delete process.env.YANO_ORCHESTRATOR_REPO;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_DESTINATION_CHAT_ID;

try {
	const packageRoot = path.join(root, "checkout");
	fs.mkdirSync(packageRoot, { recursive: true });
	fs.writeFileSync(path.join(packageRoot, ".env"), "YANO_ORCHESTRATOR_REPO=/dev/checkout\nTELEGRAM_DESTINATION_CHAT_ID=dev-chat\n");
	await runYanoConfig({ argv: ["set", "TELEGRAM_DESTINATION_CHAT_ID", "global-chat"] });
	await runYanoConfig({ argv: ["set", "TELEGRAM_BOT_TOKEN", "test-token"] });
	const configFile = globalConfigPath();
	const stored = loadConfigFile(configFile);
	assert.equal(stored.TELEGRAM_DESTINATION_CHAT_ID, "global-chat");
	assert.equal(stored.TELEGRAM_BOT_TOKEN, "test-token");
	assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
	assert.equal(configSpec("TELEGRAM_BOT_TOKEN").secret, true);
	const missing = missingConfigError("watch", ["TELEGRAM_BOT_TOKEN", "YANO_ORCHESTRATOR_REPO"]);
	assert.equal(missing.code, "YANO_CONFIG_MISSING");
	assert.match(missing.message, /yano config set TELEGRAM_BOT_TOKEN --stdin/);
	assert.match(missing.message, /yano config set YANO_ORCHESTRATOR_REPO <valore>/);

	const resolved = resolveYanoConfig({ packageRoot });
	assert.equal(resolved.YANO_ORCHESTRATOR_REPO, "/dev/checkout", "dev .env overrides only its own setting");
	assert.equal(resolved.TELEGRAM_DESTINATION_CHAT_ID, "dev-chat", "development checkout remains authoritative in dev mode");
	assert.equal(resolved.TELEGRAM_BOT_TOKEN, "test-token", "global config fills values absent from the dev .env");

	console.log("smoke-test-yano-config: ok");
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
