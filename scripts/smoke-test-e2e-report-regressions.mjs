import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "yano.mjs");
const watchScript = path.join(root, "scripts", "watch-stalls.mjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "yano-e2e-report-regressions-"));
const projectRoot = path.join(fixture, "project");
const dataDir = path.join(fixture, "data");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "report-regression" }));
const env = { ...process.env, YANO_DATA_DIR: dataDir, YANO_ORCHESTRATOR_REPO: root };

function run(args, options = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		cwd: projectRoot,
		env,
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: 2_000_000,
		...options,
	});
}

function assess(task) {
	const result = run(["architect", "assess", "--project-root", projectRoot, "--task", task, "--json"]);
	assert.equal(result.status, 0, `${task}\n${result.stderr}`);
	return JSON.parse(result.stdout);
}

try {
	const helpCases = [
		["watch", "--help"],
		["watcher", "--help"],
		["watcher", "init", "--project-root", projectRoot, "--help"],
		["watcher", "start", "--project-root", projectRoot, "--help"],
	];
	for (const args of helpCases) {
		const result = run(args);
		assert.equal(result.status, 0, `${args.join(" ")} must exit successfully`);
		assert.match(result.stdout, /Uso:/, `${args.join(" ")} must print usage`);
	}
	assert.equal(fs.existsSync(path.join(dataDir, "watcher", "watcher-registry.sqlite")), false, "--help must not create watcher registry state");

	const refactor = assess("Refactor duplicated validation in src/controller-a.js and src/controller-b.js without changing behavior; run baseline, tests, review, and approval gates.");
	assert.equal(refactor.candidate_playbook, "refactor");
	const clean = assess("Clean this repository: audit misplaced files, unused source, and documentation duplicates; propose one unified cleanup and documentation plan and wait for explicit confirmation before applying.");
	assert.equal(clean.candidate_playbook, "clean-repo");
	const best = assess("Use the get-the-best-from playbook. Compare this repository with https://github.com/sindresorhus/p-map, cite files and lines, check license attribution, and do not import changes.");
	assert.equal(best.candidate_playbook, "get-the-best-from");

	const plannerPrompt = fs.readFileSync(path.join(root, "prompts", "planner.md"), "utf8");
	assert.match(plannerPrompt, /nomi Herdr sono globalmente unici/i, "planner must use a project-scoped Herdr name");
	assert.match(plannerPrompt, /--instance <nome>/, "planner must keep the Pi instance identity explicit");

	const child = spawn(process.execPath, [watchScript, "--project-root", projectRoot, "--interval-ms", "100", "--away"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk) => { output += chunk.toString(); });
	await new Promise((resolve, reject) => {
		const deadline = setTimeout(() => resolve(), 4_500);
		child.on("error", reject);
		child.stdout.on("data", (chunk) => {
			if (/in attesa|waiting/i.test(chunk.toString())) {
				clearTimeout(deadline);
				resolve();
			}
		});
		child.on("exit", (code) => {
			if (code !== null) {
				clearTimeout(deadline);
				reject(new Error(`continuous watcher exited early with ${code}: ${output}`));
			}
		});
	});
	assert.equal(child.exitCode, null, `continuous watcher must remain alive without orchestrator.db: ${output}`);
	assert.match(output, /in attesa|waiting/i, `ordinary watcher must wait quietly without orchestrator.db: ${output}`);
	assert.doesNotMatch(output, /validation blocked/i, `ordinary conversation watcher must not report a validation error: ${output}`);
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("close", resolve));

	console.log("smoke-test-e2e-report-regressions: ok");
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
