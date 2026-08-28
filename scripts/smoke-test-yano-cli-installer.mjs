// Verifies deterministic harness selection, shared Pi discovery, idempotent
// installation and safe quarantine of identical duplicates.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installYanoCliSkill, inspectYanoCliSkill, YANO_CLI_SKILL_NAME } from "./install-yano-cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "skills-vendor", "yano", YANO_CLI_SKILL_NAME);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yano-harness-skill-"));
const env = { YANO_DATA_DIR: path.join(home, "data") };
const commandAvailability = { claude: true, codex: true, pi: true };

try {
	const piDir = path.join(home, ".pi", "agent");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "settings.json"), `${JSON.stringify({ skills: ["~/.claude/skills"] }, null, 2)}\n`);

	const plan = inspectYanoCliSkill({ packageRoot: repoRoot, home, env, commandAvailability });
	assert.deepEqual(plan.targets.map((target) => target.harness), ["claude", "codex"], "Pi deve riusare il catalogo Claude configurato");
	assert.equal(plan.targets.some((target) => target.harness === "pi"), false, "non deve essere creata una copia Pi duplicata");
	assert.ok(plan.duplicate_roots.includes(path.join(home, ".pi", "agent", "skills")), "la root Pi deve essere analizzata per duplicati");

	const installed = installYanoCliSkill({ packageRoot: repoRoot, home, env, commandAvailability });
	assert.equal(installed.ok, true);
	assert.ok(fs.existsSync(path.join(home, ".claude", "skills", YANO_CLI_SKILL_NAME, "SKILL.md")));
	assert.ok(fs.existsSync(path.join(home, ".codex", "skills", YANO_CLI_SKILL_NAME, "SKILL.md")));
	assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "skills", YANO_CLI_SKILL_NAME)), false);

	const duplicate = path.join(home, ".pi", "agent", "skills", YANO_CLI_SKILL_NAME);
	fs.mkdirSync(path.dirname(duplicate), { recursive: true });
	fs.cpSync(source, duplicate, { recursive: true });
	const pruned = installYanoCliSkill({ packageRoot: repoRoot, home, env, commandAvailability });
	assert.equal(pruned.ok, true);
	assert.equal(fs.existsSync(duplicate), false, "il duplicato identico deve uscire dal catalogo Pi");
	assert.equal(pruned.duplicates[0]?.action, "quarantined");
	assert.ok(fs.existsSync(pruned.duplicates[0].backup), "il duplicato deve restare recuperabile nel backup");

	const legacy = path.join(home, ".pi", "agent", "skills", "yano-cli-skill");
	fs.cpSync(source, legacy, { recursive: true });
	const migrated = installYanoCliSkill({ packageRoot: repoRoot, home, env, commandAvailability });
	assert.equal(migrated.ok, true);
	assert.equal(fs.existsSync(legacy), false, "la cartella legacy deve essere migrata fuori dal catalogo Pi");
	assert.ok(migrated.duplicates.some((item) => item.path === legacy && item.action === "quarantined"));

	const conflicting = path.join(home, ".pi", "agent", "skills", YANO_CLI_SKILL_NAME);
	fs.mkdirSync(conflicting, { recursive: true });
	fs.cpSync(source, conflicting, { recursive: true });
	fs.appendFileSync(path.join(conflicting, "SKILL.md"), "\nlocal edit\n");
	const conflict = installYanoCliSkill({ packageRoot: repoRoot, home, env, commandAvailability });
	assert.equal(conflict.ok, false, "una copia modificata non deve essere rimossa automaticamente");
	assert.equal(fs.existsSync(conflicting), true);

	const piOnlyHome = fs.mkdtempSync(path.join(os.tmpdir(), "yano-pi-only-"));
	const piOnly = installYanoCliSkill({
		packageRoot: repoRoot,
		home: piOnlyHome,
		env: { YANO_DATA_DIR: path.join(piOnlyHome, "data") },
		commandAvailability: { claude: false, codex: false, pi: true },
	});
	assert.equal(piOnly.ok, true);
	assert.equal(piOnly.targets[0].harness, "pi", "con il solo Pi il target deve essere il catalogo Pi");
	assert.ok(fs.existsSync(path.join(piOnlyHome, ".pi", "agent", "skills", YANO_CLI_SKILL_NAME, "SKILL.md")));
	fs.rmSync(piOnlyHome, { recursive: true, force: true });

	console.log("smoke-test-yano-cli-installer: ok");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
