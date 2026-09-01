// Regression coverage for two Pi auto-load boundaries:
// - an automatic global skill must not also be passed through --skill;
// - a bare `pi` session must remain human, rather than failing because the
//   globally installed Yano extension did not receive --instance.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { explicitSkillPathsWithoutPiConflicts, piAutomaticSkillNames } from "./launch-planner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(path.join(os.tmpdir(), "yano-pi-autoload-"));
const piHome = path.join(home, ".pi", "agent");
const claudeSkills = path.join(home, ".claude", "skills");

function installSkill(root, name) {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
}

installSkill(claudeSkills, "wayfinder");
installSkill(claudeSkills, "yano-cli");
mkdirSync(piHome, { recursive: true });
writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ skills: ["~/.claude/skills"] }));

const automatic = piAutomaticSkillNames({ home, env: { HOME: home, PI_CODING_AGENT_DIR: piHome } });
assert.deepEqual([...automatic].sort(), ["wayfinder", "yano-cli"]);

const wayfinder = path.join(repoRoot, "skills-vendor", "mattpocock", "wayfinder");
const toSpec = path.join(repoRoot, "skills-vendor", "mattpocock", "to-spec");
const yanoCli = path.join(repoRoot, "skills-vendor", "yano", "yano-cli");
const explicit = explicitSkillPathsWithoutPiConflicts([wayfinder, toSpec, yanoCli], automatic);
assert.deepEqual(explicit, [toSpec], "Pi must receive only skills it will not auto-discover already");

const hooks = new Map();
const notifications = [];
const fakePi = {
	registerFlag() {},
	getFlag() { return undefined; },
	registerTool() {},
	registerCommand() {},
	on(event, handler) { hooks.set(event, handler); },
	appendEntry() {},
	sendMessage() {},
};
const extensionUrl = `${pathToFileURL(path.join(repoRoot, "extensions", "orchestrator.ts")).href}?human-session=${Date.now()}`;
const extension = await import(extensionUrl);
extension.default(fakePi);
await hooks.get("session_start")({}, {
	cwd: repoRoot,
	hasUI: true,
	ui: { notify(message, level) { notifications.push({ message, level }); } },
});
assert.deepEqual(notifications, [], "bare pi must not report a missing --instance error");

console.log("smoke-test-pi-human-and-skill-conflicts: ok");
