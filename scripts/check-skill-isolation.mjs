// Verifica che le skill vendorizzate in skills-vendor/mattpocock/ (wayfinder,
// to-spec, grilling, domain-modeling, setup-matt-pocock-skills — Revisione
// 22, vedi docs/development-notes.md) siano cablate SOLO per il ruolo planner, mai
// per coder/reviewer/specialisti. Controlli statici (file di config, testo
// dei prompt, comportamento di scripts/launch-planner.mjs) — non lancia un
// vero `pi` (non installato in questo sandbox, vedi Revisione 22 in
// docs/development-notes.md per il limite dichiarato: verificato solo a livello di
// logica/lettura del codice, mai contro un binario pi reale).
//
// Revisione 49 — stessi identici controlli (7-11 sotto), seconda skill
// vendorizzata: skills-vendor/awesome-copilot/chrome-devtools/, cablata SOLO
// per i ruoli reviewer e frontend-developer (vedi VERSION.md lì dentro).
//
// Usage: node scripts/check-skill-isolation.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const MATT_POCOCK_SKILLS = ["wayfinder", "to-spec", "grilling", "domain-modeling", "setup-matt-pocock-skills"];
const CHROME_DEVTOOLS_SKILL = "chrome-devtools";
const CHROME_DEVTOOLS_SKILL_ROLES = ["frontend-reviewer", "frontend-developer"];

function read(relPath) {
	return readFileSync(path.join(repoRoot, relPath), "utf8");
}

console.log("1. skills-vendor/mattpocock/ è fuori dalle directory di discovery automatica di Pi...");
for (const forbidden of [".pi/skills", path.join("agents", "skills"), ".agents/skills"]) {
	const p = path.join(repoRoot, forbidden, "wayfinder");
	assert.equal(existsSync(p), false, `${forbidden}/wayfinder non dovrebbe esistere (discovery automatica non voluta)`);
}
console.log("   OK");

console.log("2. agents/roles.yaml: SOLO planner ha le skill mattpocock dichiarate...");
const roles = YAML.parse(read("agents/roles.yaml")).roles;
for (const [roleName, cfg] of Object.entries(roles)) {
	const declared = (cfg.skills ?? []).filter((s) => MATT_POCOCK_SKILLS.includes(s));
	if (roleName === "planner") {
		assert.ok(declared.includes("wayfinder"), "planner deve dichiarare 'wayfinder' in roles.yaml");
		assert.ok(declared.includes("to-spec"), "planner deve dichiarare 'to-spec' in roles.yaml");
	} else {
		assert.equal(
			declared.length,
			0,
			`il ruolo '${roleName}' NON deve dichiarare skill mattpocock in roles.yaml, trovate: ${declared.join(", ")}`,
		);
	}
}
console.log("   OK");

console.log("3. scripts/launch-planner.mjs esiste, referenzia tutte e 5 le skill mattpocock (attaccate solo quando il ruolo risolto è planner)...");
const launcherSrc = read("scripts/launch-planner.mjs");
assert.match(launcherSrc, /MATT_POCOCK_SKILLS/, "launch-planner.mjs deve referenziare la lista delle skill mattpocock");
for (const name of MATT_POCOCK_SKILLS) {
	assert.ok(launcherSrc.includes(`"${name}"`), `launch-planner.mjs deve elencare la skill '${name}'`);
}
console.log("   OK");

console.log("4. launch-planner.mjs --print-only produce un comando con --role planner e i 5 --skill (skill mattpocock reali)...");
const printed = execFileSync("node", ["scripts/launch-planner.mjs", "--instance", "planner-check", "--print-only"], {
	cwd: repoRoot,
	encoding: "utf8",
});
assert.match(printed, /--role planner/, "il comando composto deve includere --role planner");
for (const name of MATT_POCOCK_SKILLS) {
	const expectedPath = path.join(repoRoot, "skills-vendor", "mattpocock", name);
	assert.ok(printed.includes(expectedPath), `il comando composto deve includere --skill ${expectedPath}`);
}
console.log("   OK");

console.log("5. launch-planner.mjs (Revisione 44) ACCETTA un --role diverso da planner (es. coder), ma senza NESSUN --skill mattpocock...");
const printedCoder = execFileSync("node", ["scripts/launch-planner.mjs", "--instance", "coder-check", "--role", "coder", "--print-only"], {
	cwd: repoRoot,
	encoding: "utf8",
});
assert.match(printedCoder, /--role coder/, "il comando composto per --role coder deve includere --role coder");
assert.ok(!printedCoder.includes("--skill"), "il comando composto per --role coder NON deve includere alcun flag --skill");
console.log("   OK");

console.log("6. nessun altro script/prompt referenzia skills-vendor/mattpocock con un ruolo diverso da planner...");
// Cerca ogni occorrenza di "skills-vendor/mattpocock" fuori da: la cartella
// stessa, launch-planner.mjs, check-skill-isolation.mjs (questo file),
// README.md, docs/development-notes.md, AGENTS.md, docs/agents/*.md, e la sezione
// "planner" di prompts/planner.md (l'unico prompt che deve nominarle).
const { execFileSync: exec2 } = await import("node:child_process");
let grepOut = "";
try {
	grepOut = exec2("grep", ["-rl", "skills-vendor/mattpocock", repoRoot, "--include=*.md", "--include=*.mjs", "--include=*.yaml"], {
		encoding: "utf8",
	});
} catch (err) {
	// grep exits 1 if no matches — treat as empty
	if (err.status !== 1) throw err;
	grepOut = "";
}
const allowedFiles = new Set(
	[
		"scripts/launch-planner.mjs",
		"scripts/check-skill-isolation.mjs",
		"README.md",
		"docs/development-notes.md",
		"AGENTS.md",
		"docs/agents/issue-tracker.md",
		"docs/agents/domain.md",
		"prompts/planner.md",
	].map((p) => path.join(repoRoot, p)),
);
const offenders = grepOut
	.split("\n")
	.filter(Boolean)
	.filter((f) => !f.startsWith(path.join(repoRoot, "skills-vendor")))
	.filter((f) => !allowedFiles.has(f))
	.filter((f) => !f.startsWith(path.join(repoRoot, "docs", "agents"))); // seed-derived docs, informational only
assert.deepEqual(offenders, [], `file inattesi che referenziano skills-vendor/mattpocock: ${offenders.join(", ")}`);
console.log("   OK");

console.log("\n7. skills-vendor/awesome-copilot/ è fuori dalle directory di discovery automatica di Pi...");
for (const forbidden of [".pi/skills", path.join("agents", "skills"), ".agents/skills"]) {
	const p = path.join(repoRoot, forbidden, CHROME_DEVTOOLS_SKILL);
	assert.equal(existsSync(p), false, `${forbidden}/${CHROME_DEVTOOLS_SKILL} non dovrebbe esistere (discovery automatica non voluta)`);
}
console.log("   OK");

console.log("8. agents/roles.yaml: SOLO frontend-reviewer e frontend-developer hanno la skill chrome-devtools dichiarata...");
for (const [roleName, cfg] of Object.entries(roles)) {
	const hasIt = (cfg.skills ?? []).includes(CHROME_DEVTOOLS_SKILL);
	if (CHROME_DEVTOOLS_SKILL_ROLES.includes(roleName)) {
		assert.ok(hasIt, `il ruolo '${roleName}' deve dichiarare '${CHROME_DEVTOOLS_SKILL}' in roles.yaml`);
	} else {
		assert.equal(hasIt, false, `il ruolo '${roleName}' NON deve dichiarare '${CHROME_DEVTOOLS_SKILL}' in roles.yaml`);
	}
}
console.log("   OK");

console.log("9. scripts/launch-planner.mjs referenzia la skill chrome-devtools e i ruoli a cui è riservata...");
assert.match(launcherSrc, /CHROME_DEVTOOLS_SKILL_ROLES/, "launch-planner.mjs deve referenziare la lista dei ruoli per chrome-devtools");
assert.ok(launcherSrc.includes(`"${CHROME_DEVTOOLS_SKILL}"`), `launch-planner.mjs deve elencare la skill '${CHROME_DEVTOOLS_SKILL}'`);
for (const roleName of CHROME_DEVTOOLS_SKILL_ROLES) {
	assert.ok(launcherSrc.includes(`"${roleName}"`), `launch-planner.mjs deve elencare il ruolo '${roleName}' tra quelli abilitati a chrome-devtools`);
}
console.log("   OK");

console.log("10. launch-planner.mjs --print-only: reviewer/frontend-developer ricevono --skill chrome-devtools, planner/coder mai...");
const chromeDevToolsPath = path.join(repoRoot, "skills-vendor", "awesome-copilot", CHROME_DEVTOOLS_SKILL);
for (const roleName of CHROME_DEVTOOLS_SKILL_ROLES) {
	const printedRole = execFileSync(
		"node",
		["scripts/launch-planner.mjs", "--instance", `${roleName}-check`, "--role", roleName, "--print-only"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	assert.match(printedRole, new RegExp(`--role ${roleName}`), `il comando composto per --role ${roleName} deve includere --role ${roleName}`);
	assert.ok(printedRole.includes(chromeDevToolsPath), `il comando composto per --role ${roleName} deve includere --skill ${chromeDevToolsPath}`);
	for (const name of MATT_POCOCK_SKILLS) {
		assert.ok(!printedRole.includes(path.join(repoRoot, "skills-vendor", "mattpocock", name)), `--role ${roleName} NON deve ricevere la skill mattpocock '${name}'`);
	}
}
assert.ok(!printed.includes(chromeDevToolsPath), "--role planner NON deve includere --skill chrome-devtools");
assert.ok(!printedCoder.includes(chromeDevToolsPath), "--role coder NON deve includere --skill chrome-devtools");
console.log("   OK");

console.log("11. nessun altro script/prompt referenzia skills-vendor/awesome-copilot con un ruolo diverso da reviewer/frontend-developer...");
let grepOut2 = "";
try {
	grepOut2 = exec2("grep", ["-rl", "skills-vendor/awesome-copilot", repoRoot, "--include=*.md", "--include=*.mjs", "--include=*.yaml"], {
		encoding: "utf8",
	});
} catch (err) {
	if (err.status !== 1) throw err;
	grepOut2 = "";
}
const allowedFiles2 = new Set(
	["scripts/launch-planner.mjs", "scripts/check-skill-isolation.mjs", "README.md", "docs/development-notes.md", "AGENTS.md", "prompts/reviewer.md", "prompts/frontend-developer.md"].map(
		(p) => path.join(repoRoot, p),
	),
);
const offenders2 = grepOut2
	.split("\n")
	.filter(Boolean)
	.filter((f) => !f.startsWith(path.join(repoRoot, "skills-vendor")))
	.filter((f) => !allowedFiles2.has(f));
assert.deepEqual(offenders2, [], `file inattesi che referenziano skills-vendor/awesome-copilot: ${offenders2.join(", ")}`);
console.log("   OK");

console.log(
	"\nOK: scripts/check-skill-isolation.mjs — le skill mattpocock risultano cablate SOLO per planner, chrome-devtools SOLO per reviewer/frontend-developer.",
);
