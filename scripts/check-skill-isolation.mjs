// Verifica che le skill vendorizzate in skills-vendor/mattpocock/ (wayfinder,
// to-spec, to-tickets, grilling, domain-modeling, setup-matt-pocock-skills — Revisione
// 22, vedi docs/notes/development-notes.md) siano cablate SOLO per il ruolo planner, mai
// per coder/reviewer/specialisti. Controlli statici (file di config, testo
// dei prompt, comportamento di scripts/launch-planner.mjs) — non lancia un
// vero `pi` (non installato in questo sandbox, vedi Revisione 22 in
// docs/notes/development-notes.md per il limite dichiarato: verificato solo a livello di
// logica/lettura del codice, mai contro un binario pi reale).
//
// Revisione 49 — stessi identici controlli (7-11 sotto), seconda skill
// vendorizzata: skills-vendor/awesome-copilot/chrome-devtools/, cablata SOLO
// per i ruoli reviewer e frontend-developer (vedi VERSION.md lì dentro).
// Revisione 50 — l'adapter Yano della skill /code-review è cablato SOLO per
// reviewer e frontend-reviewer; la snapshot originale Matt resta un
// riferimento vendorizzato e non viene iniettata come workflow autonomo.
// Revisione 51 — yano-cli è una skill condivisa: tutti i ruoli devono
// poter interpretare la CLI completa con lo stesso contratto operativo.
//
// Usage: node scripts/check-skill-isolation.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
// The assertions below verify Yano's vendored fallback paths. Do not let the
// developer's globally configured Pi skill roots alter that deterministic
// fixture (the separate conflict smoke test covers that integration).
const isolatedPiHome = mkdtempSync(path.join(os.tmpdir(), "yano-skill-isolation-"));
mkdirSync(isolatedPiHome, { recursive: true });
process.env.PI_CODING_AGENT_DIR = isolatedPiHome;
const MATT_POCOCK_SKILLS = ["wayfinder", "to-spec", "to-tickets", "grilling", "domain-modeling", "setup-matt-pocock-skills"];
const YANO_PLANNER_SKILL = "yano-planner-trace-analysis";
const YANO_CLI_SKILL = "yano-cli";
const YANO_REVIEW_SKILL = "yano-code-review";
const YANO_REVIEW_SKILL_ROLES = ["reviewer", "frontend-reviewer"];
const YANO_DEPLOYMENT_SKILL = "yano-deployment";
const YANO_DEPLOYMENT_SKILL_ROLES = ["deployment-agent"];
const YANO_OBSERVER_SKILL = "yano-observer";
const YANO_OBSERVER_SKILL_ROLES = ["watcher", "auto-improver"];
const YANO_AUTO_IMPROVEMENT_SKILL = "yano-auto-improvement";
const YANO_AUTO_IMPROVEMENT_SKILL_ROLES = ["auto-improver"];
const YANO_ARCHITECT_SKILL = "yano-architect";
const YANO_ARCHITECT_SKILL_ROLES = ["architect"];
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

console.log("3. scripts/launch-planner.mjs esiste, referenzia tutte e 6 le skill mattpocock (attaccate solo quando il ruolo risolto è planner)...");
const launcherSrc = read("scripts/launch-planner.mjs");
assert.match(launcherSrc, /MATT_POCOCK_SKILLS/, "launch-planner.mjs deve referenziare la lista delle skill mattpocock");
for (const name of MATT_POCOCK_SKILLS) {
	assert.ok(launcherSrc.includes(`"${name}"`), `launch-planner.mjs deve elencare la skill '${name}'`);
}
console.log("   OK");

console.log("4. launch-planner.mjs --print-only produce un comando con --role planner e i 6 --skill (skill mattpocock reali)...");
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

console.log("5. launch-planner.mjs (Revisione 44+) accetta un --role diverso da planner: coder riceve la skill trace condivisa, ma non quelle mattpocock...");
const printedCoder = execFileSync("node", ["scripts/launch-planner.mjs", "--instance", "coder-check", "--role", "coder", "--print-only"], {
	cwd: repoRoot,
	encoding: "utf8",
});
assert.match(printedCoder, /--role coder/, "il comando composto per --role coder deve includere --role coder");
assert.ok(printedCoder.includes(path.join(repoRoot, "skills-vendor", "yano", YANO_PLANNER_SKILL)), "il comando composto per --role coder deve includere la skill trace condivisa");
for (const name of MATT_POCOCK_SKILLS) assert.ok(!printedCoder.includes(path.join(repoRoot, "skills-vendor", "mattpocock", name)), `il coder non deve ricevere la skill mattpocock '${name}'`);
console.log("   OK");

console.log("6. nessun altro script/prompt referenzia skills-vendor/mattpocock con un ruolo diverso da planner...");
// Cerca ogni occorrenza di "skills-vendor/mattpocock" fuori da: la cartella
// stessa, launch-planner.mjs, check-skill-isolation.mjs (questo file),
// README.md, docs/notes/development-notes.md, AGENTS.md, docs/notes/agents/*.md, e la sezione
// "planner" di prompts/planner.md (l'unico prompt che deve nominarle).
const { execFileSync: exec2 } = await import("node:child_process");
let grepOut = "";
try {
	// Git worktrees are independent checkouts, not part of this repository's
	// discovery surface. Scanning them made the check fail whenever a live
	// clean-repo planner had a temporary worktree under `.worktrees/`.
	grepOut = exec2("grep", ["-rl", "--exclude-dir=.worktrees", "skills-vendor/mattpocock", repoRoot, "--include=*.md", "--include=*.mjs", "--include=*.yaml"], {
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
		"docs/notes/development-notes.md",
		"AGENTS.md",
		"docs/architecture/architecture.md",
		"docs/notes/agents/issue-tracker.md",
		"docs/notes/agents/domain.md",
		"prompts/planner.md",
	].map((p) => path.join(repoRoot, p)),
);
const offenders = grepOut
	.split("\n")
	.filter(Boolean)
	.filter((f) => !f.startsWith(path.join(repoRoot, "skills-vendor")))
	.filter((f) => !allowedFiles.has(f))
	.filter((f) => !f.startsWith(path.join(repoRoot, "docs", "notes", "agents"))); // seed-derived docs, informational only
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
	grepOut2 = exec2("grep", ["-rl", "--exclude-dir=.worktrees", "skills-vendor/awesome-copilot", repoRoot, "--include=*.md", "--include=*.mjs", "--include=*.yaml"], {
		encoding: "utf8",
	});
} catch (err) {
	if (err.status !== 1) throw err;
	grepOut2 = "";
}
const allowedFiles2 = new Set(
	["scripts/launch-planner.mjs", "scripts/check-skill-isolation.mjs", "README.md", "docs/notes/development-notes.md", "AGENTS.md", "prompts/reviewer.md", "prompts/frontend-developer.md"].map(
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

console.log("12. la skill Yano per l'analisi trace è presente e viene caricata da tutti i ruoli...");
const yanoSkillPath = path.join(repoRoot, "skills-vendor", "yano", YANO_PLANNER_SKILL);
assert.ok(existsSync(path.join(yanoSkillPath, "SKILL.md")), "la skill Yano deve contenere SKILL.md");
assert.ok(existsSync(path.join(yanoSkillPath, "evals", "evals.json")), "la skill Yano deve contenere evals/evals.json");
assert.ok(launcherSrc.includes(`"${YANO_PLANNER_SKILL}"`), "launch-planner.mjs deve referenziare la skill Yano");
assert.ok(printed.includes(yanoSkillPath), "il planner deve ricevere la skill Yano");
assert.ok(printedCoder.includes(yanoSkillPath), "il coder deve ricevere la skill Yano");
assert.ok((roles.planner.skills ?? []).includes(YANO_PLANNER_SKILL), "planner deve dichiarare la skill Yano in roles.yaml");
for (const [roleName, cfg] of Object.entries(roles)) {
	assert.equal((cfg.skills ?? []).includes(YANO_PLANNER_SKILL), true, `il ruolo '${roleName}' deve dichiarare la skill Yano condivisa`);
}
console.log("   OK");

console.log("\n13. l'adapter Yano della skill code-review è presente e riservato a reviewer/frontend-reviewer...");
const yanoReviewSkillPath = path.join(repoRoot, "skills-vendor", "yano", YANO_REVIEW_SKILL);
assert.ok(existsSync(path.join(yanoReviewSkillPath, "SKILL.md")), "l'adapter Yano code-review deve contenere SKILL.md");
assert.ok(launcherSrc.includes(`\"${YANO_REVIEW_SKILL}\"`), "launch-planner.mjs deve referenziare l'adapter Yano code-review");
for (const [roleName, cfg] of Object.entries(roles)) {
	const hasIt = (cfg.skills ?? []).includes(YANO_REVIEW_SKILL);
	if (YANO_REVIEW_SKILL_ROLES.includes(roleName)) {
		assert.equal(hasIt, true, `il ruolo '${roleName}' deve dichiarare '${YANO_REVIEW_SKILL}'`);
	} else {
		assert.equal(hasIt, false, `il ruolo '${roleName}' NON deve dichiarare '${YANO_REVIEW_SKILL}'`);
	}
}
const printedReviewer = execFileSync(
	"node",
	["scripts/launch-planner.mjs", "--instance", "reviewer-check", "--role", "reviewer", "--print-only"],
	{ cwd: repoRoot, encoding: "utf8" },
);
assert.ok(printedReviewer.includes(yanoReviewSkillPath), "reviewer deve ricevere l'adapter Yano code-review");
assert.ok(!printed.includes(yanoReviewSkillPath), "planner non deve ricevere l'adapter Yano code-review");
assert.ok(!printedCoder.includes(yanoReviewSkillPath), "coder non deve ricevere l'adapter Yano code-review");
console.log("   OK");

console.log("\n14. la skill Yano deployment è presente e riservata al deployment-agent...");
const yanoDeploymentSkillPath = path.join(repoRoot, "skills-vendor", "yano", YANO_DEPLOYMENT_SKILL);
assert.ok(existsSync(path.join(yanoDeploymentSkillPath, "SKILL.md")), "la skill Yano deployment deve contenere SKILL.md");
assert.ok(existsSync(path.join(yanoDeploymentSkillPath, "evals", "evals.json")), "la skill Yano deployment deve contenere evals/evals.json");
assert.ok(launcherSrc.includes(`"${YANO_DEPLOYMENT_SKILL}"`), "launch-planner.mjs deve referenziare la skill Yano deployment");
const printedDeployment = execFileSync(
	"node",
	["scripts/launch-planner.mjs", "--instance", "deployment-check", "--role", "deployment-agent", "--print-only"],
	{ cwd: repoRoot, encoding: "utf8" },
);
assert.ok(printedDeployment.includes(yanoDeploymentSkillPath), "deployment-agent deve ricevere la skill Yano deployment");
assert.ok(!printed.includes(yanoDeploymentSkillPath), "planner non deve ricevere la skill Yano deployment");
assert.ok(!printedCoder.includes(yanoDeploymentSkillPath), "coder non deve ricevere la skill Yano deployment");
for (const [roleName, cfg] of Object.entries(roles)) {
	const hasIt = (cfg.skills ?? []).includes(YANO_DEPLOYMENT_SKILL);
	assert.equal(hasIt, YANO_DEPLOYMENT_SKILL_ROLES.includes(roleName), `skill deployment non correttamente isolata per '${roleName}'`);
}
console.log("   OK");

console.log("\n16. la skill Yano architect è presente e riservata all'architect...");
const yanoArchitectSkillPath = path.join(repoRoot, "skills-vendor", "yano", YANO_ARCHITECT_SKILL);
assert.ok(existsSync(path.join(yanoArchitectSkillPath, "SKILL.md")), "la skill architect deve contenere SKILL.md");
assert.ok(existsSync(path.join(yanoArchitectSkillPath, "evals", "evals.json")), "la skill architect deve contenere evals/evals.json");
assert.ok(launcherSrc.includes(`"${YANO_ARCHITECT_SKILL}"`), "launch-planner.mjs deve referenziare la skill architect");
for (const [roleName, cfg] of Object.entries(roles)) {
		assert.equal((cfg.skills ?? []).includes(YANO_ARCHITECT_SKILL), YANO_ARCHITECT_SKILL_ROLES.includes(roleName), `skill architect non correttamente isolata per '${roleName}'`);
}
const printedArchitect = execFileSync("node", ["scripts/launch-planner.mjs", "--instance", "architect-check", "--role", "architect", "--print-only"], { cwd: repoRoot, encoding: "utf8" });
assert.ok(printedArchitect.includes(yanoArchitectSkillPath), "architect deve ricevere la skill yano-architect");
assert.equal(roles.architect.playbook, "architect-provisioning", "architect deve usare architect-provisioning");
assert.match(read("prompts/architect.md"), /capability|provision/i, "il prompt architect deve descrivere il provisioning");
console.log("   OK");

console.log("\n17. yano-cli è presente nel catalogo skill Yano, inclusa nel package e condivisa da ogni ruolo...");
const yanoCliSkillPath = path.join(repoRoot, "skills-vendor", "yano", YANO_CLI_SKILL);
assert.ok(existsSync(path.join(yanoCliSkillPath, "SKILL.md")), "yano-cli deve contenere SKILL.md");
assert.ok(existsSync(path.join(yanoCliSkillPath, "references", "command-reference.md")), "yano-cli deve contenere il riferimento completo alla CLI");
assert.ok(existsSync(path.join(yanoCliSkillPath, "evals", "evals.json")), "yano-cli deve contenere evals/evals.json");
assert.ok(launcherSrc.includes("YANO_CLI_SKILL"), "launch-planner.mjs deve caricare la skill CLI condivisa");
for (const [roleName, cfg] of Object.entries(roles)) {
	assert.ok((cfg.skills ?? []).includes(YANO_CLI_SKILL), `il ruolo '${roleName}' deve dichiarare yano-cli`);
}
const printedCliPlanner = execFileSync("node", ["scripts/launch-planner.mjs", "--instance", "cli-skill-planner-check", "--print-only"], { cwd: repoRoot, encoding: "utf8" });
const printedCliCoder = execFileSync("node", ["scripts/launch-planner.mjs", "--instance", "cli-skill-coder-check", "--role", "coder", "--print-only"], { cwd: repoRoot, encoding: "utf8" });
assert.ok(printedCliPlanner.includes(yanoCliSkillPath), "planner deve ricevere la skill CLI dal catalogo Yano del pacchetto");
assert.ok(printedCliCoder.includes(yanoCliSkillPath), "coder deve ricevere la skill CLI dal catalogo Yano del pacchetto");
assert.ok(existsSync(path.join(repoRoot, "scripts", "install-yano-cli.mjs")), "l'installer globale yano-cli deve essere presente");
assert.match(read("package.json"), /install-yano-cli\.mjs --if-global/, "il package deve eseguire l'installer durante npm install globale");
console.log("   OK");

console.log(
  "\nOK: scripts/check-skill-isolation — skill planner, CLI condivisa, trace, code-review, deployment, observer/auto-improvement, architect e chrome-devtools risultano cablate correttamente.",
);
