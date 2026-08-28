// Static/integration smoke test for the shared yano-cli skill.
// It verifies that the skill is packaged, documented, advertised by every
// role, and actually injected into the command composed for Pi.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills-vendor", "yano", "yano-cli");
const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
const reference = readFileSync(path.join(skillRoot, "references", "command-reference.md"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const roles = YAML.parse(readFileSync(path.join(repoRoot, "agents", "roles.yaml"), "utf8"))?.roles || {};
const installer = readFileSync(path.join(repoRoot, "scripts", "install-yano-cli.mjs"), "utf8");

assert.ok(/^name: yano-cli$/m.test(skill), "la skill deve avere il nome corretto");
assert.match(skill, /natural-language|richieste semantiche|richieste naturali/i, "la skill deve dichiarare l'uso semantico");
assert.ok(existsSync(path.join(skillRoot, "references", "command-reference.md")), "la reference CLI deve esistere");
assert.ok(existsSync(path.join(skillRoot, "evals", "evals.json")), "le eval della skill devono esistere");
assert.ok(packageJson.files.includes("skills-vendor"), "le skill Yano devono essere incluse nel pacchetto npm");
assert.equal(packageJson.scripts.postinstall, "node scripts/install-yano-cli.mjs --if-global --quiet", "l'installazione globale deve usare lo script deterministico");
assert.match(installer, /CLAUDE_CONFIG_DIR|CODEX_HOME|PI_CODING_AGENT_DIR/, "l'installer deve conoscere i cataloghi degli harness");
assert.match(installer, /discoveryRoots|settings\.json/, "l'installer deve leggere le root scoperte da Pi");

for (const command of [
	"yano init", "yano start", "yano doctor", "yano update", "yano repair", "yano trace",
	"yano config", "yano data", "yano playbook", "yano agent", "yano watcher projects",
	"yano architect projects", "yano debugger", "yano auto-improve", "yano suggester", "yano projects",
]) assert.ok(reference.includes(command), `la reference deve documentare ${command}`);

assert.match(skill, /quanti progetti Yano sono attivi adesso/i, "la skill deve mappare il conteggio globale dei progetti");
assert.match(skill, /yano projects --json/, "la skill deve indicare il comando globale dei progetti attivi");

for (const [role, config] of Object.entries(roles)) {
	assert.ok((config.skills || []).includes("yano-cli"), `il ruolo ${role} deve ricevere yano-cli`);
}

function composed(args) {
	return execFileSync("node", ["scripts/launch-planner.mjs", ...args, "--print-only"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

const planner = composed(["--instance", "cli-skill-smoke-planner"]);
const coder = composed(["--instance", "cli-skill-smoke-coder", "--role", "coder"]);
assert.ok(planner.includes(skillRoot), "planner deve ricevere la skill CLI dalla root del pacchetto");
assert.ok(coder.includes(skillRoot), "coder deve ricevere la skill CLI dalla root del pacchetto");

console.log("smoke-test-yano-cli: ok");
