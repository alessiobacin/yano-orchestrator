#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";

function reachable(host, port, timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (value) => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

async function run(label, command, args, env = {}) {
	console.log(`\n=== ${label} ===`);
	const child = spawn(command, args, {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, ...env },
		shell: process.platform === "win32",
	});
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ code: 1, error }));
		child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
	});
}

async function ensureBroker() {
	if (await reachable("127.0.0.1", 1883, 800)) return { started: false };
	try {
		await execFileP(dockerCommand, ["compose", "-f", "mqtt/compose.yaml", "up", "-d"], { cwd: root });
	} catch (error) {
		throw new Error(`Nessun broker MQTT su 127.0.0.1:1883 e Docker non è riuscito ad avviare mqtt/compose.yaml: ${error.message}`);
	}
	for (let attempt = 0; attempt < 30; attempt++) {
		if (await reachable("127.0.0.1", 1883, 800)) return { started: true };
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Il broker MQTT non è diventato raggiungibile su 127.0.0.1:1883.");
}

async function stopBrokerIfStarted(started) {
	if (!started) return;
	try {
		await execFileP(dockerCommand, ["compose", "-f", "mqtt/compose.yaml", "down"], { cwd: root });
	} catch (error) {
		console.warn(`Impossibile fermare il broker MQTT avviato dal test runner: ${error.message}`);
	}
}

async function main() {
	const smokeTests = fs.readdirSync(path.join(root, "scripts"))
		.filter((file) => file.startsWith("smoke-test-") && file.endsWith(".mjs"))
		.sort();
	const targets = [
		["syntax", "node", ["--experimental-strip-types", "scripts/check-syntax.mjs", "extensions/orchestrator.ts"]],
		["documentation sync", npmCommand, ["run", "check:docs"]],
		["capability lint", npmCommand, ["run", "lint:capabilities"]],
		["playbook lint", npmCommand, ["run", "lint:playbooks"]],
		["skill isolation", npmCommand, ["run", "check-skill-isolation"]],
		...smokeTests.map((file) => [file, "node", ["--experimental-strip-types", `scripts/${file}`]]),
		["full e2e", "node", ["--experimental-strip-types", "scripts/e2e-full-flow.mjs"]],
	];

	await run("recreate test stub", "node", ["scripts/setup-dev-stubs.mjs"]);
	const broker = await ensureBroker();
	try {
		for (const [label, command, args] of targets) {
			const result = await run(label, command, args, { PI_ORCH_TEST_NO_EXIT: "1" });
			if (result.code !== 0) throw new Error(`${label} fallito (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ""}).`);
		}
		console.log(`\nALL TESTS PASSED (${targets.length} checks).`);
	} finally {
		await stopBrokerIfStarted(broker.started);
	}
}

main().catch((error) => {
	console.error(`\nTEST SUITE FAILED: ${error.message}`);
	process.exitCode = 1;
});
