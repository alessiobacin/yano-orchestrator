// Static/integration smoke test for the shared yano-cli skill.
// It verifies that the skill is packaged, documented, advertised by every
// role, and actually injected into the command composed for Pi.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills-vendor", "yano", "yano-cli");
const codeMemSkillRoot = path.join(repoRoot, "skills-vendor", "yano", "yano-code-mem");
const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
const reference = readFileSync(path.join(skillRoot, "references", "command-reference.md"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const roles = YAML.parse(readFileSync(path.join(repoRoot, "agents", "roles.yaml"), "utf8"))?.roles || {};
const installer = readFileSync(path.join(repoRoot, "scripts", "install-yano-cli.mjs"), "utf8");

assert.ok(/^name: yano-cli$/m.test(skill), "la skill deve avere il nome corretto");
assert.match(skill, /natural-language|richieste semantiche|richieste naturali/i, "la skill deve dichiarare l'uso semantico");
assert.ok(existsSync(path.join(skillRoot, "references", "command-reference.md")), "la reference CLI deve esistere");
assert.ok(existsSync(path.join(skillRoot, "evals", "evals.json")), "le eval della skill devono esistere");
assert.ok(existsSync(path.join(codeMemSkillRoot, "SKILL.md")), "la skill Yano Code Mem deve esistere");
assert.ok(existsSync(path.join(codeMemSkillRoot, "evals", "evals.json")), "la skill Yano Code Mem deve avere eval");
assert.ok(packageJson.files.includes("skills-vendor"), "le skill Yano devono essere incluse nel pacchetto npm");
assert.match(packageJson.scripts.postinstall, /node scripts\/install-yano-cli\.mjs --if-global --quiet/, "l'installazione globale deve usare lo script deterministico");
assert.match(packageJson.scripts.postinstall, /node scripts\/install-yano-watcher-cron\.mjs --if-global --quiet/, "l'installazione globale deve installare anche il supervisore watcher");
assert.ok(existsSync(path.join(repoRoot, "scripts", "install-yano-watcher-cron.mjs")), "lo script lifecycle del supervisore watcher deve essere incluso nel repository");
assert.match(installer, /CLAUDE_CONFIG_DIR|CODEX_HOME|PI_CODING_AGENT_DIR/, "l'installer deve conoscere i cataloghi degli harness");
assert.match(installer, /discoveryRoots|settings\.json/, "l'installer deve leggere le root scoperte da Pi");

for (const command of [
	"yano init", "yano start", "yano doctor", "yano update", "yano repair", "yano trace",
	"yano config", "yano data", "yano playbook", "yano agent", "yano watcher projects",
	"yano architect projects", "yano feedback", "yano auto-improve", "yano feedback", "yano projects", "yano gantt --project-root", "yano gantt --link", "yano gantt --links",
	"yano cron",
]) assert.ok(reference.includes(command), `la reference deve documentare ${command}`);

assert.match(skill, /quanti progetti Yano sono attivi adesso/i, "la skill deve mappare il conteggio globale dei progetti");
assert.match(skill, /yano projects --json/, "la skill deve indicare il comando globale dei progetti attivi");
assert.match(skill, /yano gantt --persistent --open/, "la skill deve indicare il Gantt persistente");
assert.match(skill, /yano gantt --links --json/, "la skill deve indicare il recupero globale dei link Gantt");

for (const [role, config] of Object.entries(roles)) {
	assert.ok((config.skills || []).includes("yano-cli"), `il ruolo ${role} deve ricevere yano-cli`);
}

function composed(args) {
	return execFileSync("node", ["scripts/launch-planner.mjs", ...args, "--print-only"], {
		cwd: repoRoot,
		encoding: "utf8",
		env: isolatedPiEnv,
	});
}

// Keep assertions about Yano's portable fallback independent from skills the
// developer happens to have installed globally in Pi.
const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "yano-skill-test-"));
const isolatedPiHome = path.join(isolatedHome, ".pi", "agent");
mkdirSync(isolatedPiHome, { recursive: true });
const isolatedPiEnv = { ...process.env, HOME: isolatedHome, PI_CODING_AGENT_DIR: isolatedPiHome };

const planner = composed(["--instance", "cli-skill-smoke-planner"]);
const coder = composed(["--instance", "cli-skill-smoke-coder", "--role", "coder"]);
assert.ok(planner.includes(skillRoot), "planner deve ricevere la skill CLI dalla root del pacchetto");
assert.ok(coder.includes(skillRoot), "coder deve ricevere la skill CLI dalla root del pacchetto");
assert.ok(planner.includes(codeMemSkillRoot), "planner deve ricevere la skill Code Mem dalla root del pacchetto");
assert.ok(coder.includes(codeMemSkillRoot), "coder deve ricevere la skill Code Mem dalla root del pacchetto");

console.log("smoke-test-yano-cli: ok");
