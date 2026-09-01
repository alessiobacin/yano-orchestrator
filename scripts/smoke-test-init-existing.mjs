// Existing projects must be adoptable in-place without overwriting their
// package manager metadata, application agents/ directory or local settings.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCreateProject } from "./create-project.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = fs.mkdtempSync(path.join(os.tmpdir(), "yano-init-existing-"));
const noGitProject = fs.mkdtempSync(path.join(os.tmpdir(), "yano-init-no-git-"));
const packageJson = {
	name: "existing-application",
	private: true,
	type: "module",
	scripts: { build: "framework build" },
};
fs.writeFileSync(path.join(project, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "src", "keep-me.ts"), "export const untouched = true;\n");
fs.mkdirSync(path.join(project, "agents"), { recursive: true });
fs.writeFileSync(path.join(project, "agents", "application-agent.md"), "application-owned file\n");
fs.writeFileSync(path.join(project, ".env.example"), "APP_ENV=test\n");
fs.writeFileSync(path.join(project, ".gitignore"), "dist/\n");

try {
	const preflightTools = {
		ensureCodeMem: () => ({ ok: true }),
		initializeCodeMem: (targetDir) => {
			fs.mkdirSync(path.join(targetDir, "memory"), { recursive: true });
			fs.mkdirSync(path.join(targetDir, ".pi", "skills", "cm"), { recursive: true });
			fs.writeFileSync(path.join(targetDir, ".pi", "skills", "cm", "SKILL.md"), "---\nname: cm\n---\n");
			return { ok: true };
		},
		ensurePlaywright: () => ({ ok: true }),
		ensureCore: () => ({ ok: true, skills: [], mcp: {} }),
		ensureEmbeddings: async () => ({ ok: true }),
		doctor: async () => ({ ok: true }),
	};
	await runCreateProject({
		packageRoot: root,
		cwd: project,
		argv: ["--name", "Existing Application"],
		preflightTools,
	});

	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8")), packageJson, "existing package.json is preserved byte-for-byte semantically");
	assert.equal(fs.readFileSync(path.join(project, "src", "keep-me.ts"), "utf8"), "export const untouched = true;\n", "application source is untouched");
	assert.equal(fs.readFileSync(path.join(project, ".env.example"), "utf8"), "APP_ENV=test\n", "existing environment template is untouched");
	assert.equal(fs.readFileSync(path.join(project, "agents", "application-agent.md"), "utf8"), "application-owned file\n", "application agents directory is untouched");
	assert.ok(fs.existsSync(path.join(project, ".pi", "agents", "roles.yaml")), "Yano roster uses .pi/agents when root agents/ belongs to the application");
	assert.ok(fs.existsSync(path.join(project, ".pi", "extensions", "yano-orchestrator", "config", "project.json")), "Yano project workspace is initialized");
	assert.ok(fs.existsSync(path.join(project, "memory")), "Code Mem è inizializzato come prerequisito");
	assert.ok(fs.existsSync(path.join(project, ".pi", "skills", "cm", "SKILL.md")), "la skill locale Code Mem per Pi è installata");
	const gitignore = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
	assert.match(gitignore, /dist\//, "existing .gitignore entry is preserved");
	assert.match(gitignore, /\.pi\//, "Yano runtime is ignored");
	assert.ok(fs.existsSync(path.join(project, "mqtt", "compose.yaml")), "missing Yano MQTT infrastructure is added");
	assert.doesNotThrow(() => execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: project, stdio: "ignore" }), "a new Git repository gets a baseline commit so worktree-based playbooks have a real HEAD");

	await runCreateProject({ packageRoot: root, cwd: noGitProject, argv: ["--name", "Conversation Test", "--no-git"], preflightTools });
	assert.equal(fs.existsSync(path.join(noGitProject, ".git")), false, "--no-git leaves a conversation test without a Git repository");
	assert.ok(fs.existsSync(path.join(noGitProject, ".pi", "extensions", "yano-orchestrator", "config", "project.json")), "--no-git still scaffolds Yano config");
	assert.ok(fs.existsSync(path.join(noGitProject, "memory")), "--no-git inizializza comunque Code Mem");
	console.log("YANO INIT EXISTING PROJECT SMOKE TEST PASSED (non-destructive adoption)");
} finally {
	fs.rmSync(project, { recursive: true, force: true });
	fs.rmSync(noGitProject, { recursive: true, force: true });
}
