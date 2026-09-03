#!/usr/bin/env node

// Contract check for the documentation surfaces that describe the current
// executable behavior. This is deterministic and offline.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(relative) {
	const file = path.join(root, relative);
	if (!fs.existsSync(file)) {
		failures.push(`${relative}: file mancante`);
		return "";
	}
	return fs.readFileSync(file, "utf8");
}

function requireText(relative, pattern, description = pattern) {
	const content = read(relative);
	if (content && !pattern.test(content)) failures.push(`${relative}: manca ${description}`);
}

const requiredDocs = [
	"README.md",
	"docs/quick-guides/quick-start.md",
	"docs/architecture/architecture.md",
	"docs/architecture/architecture.mmd",
	"docs/diagram/05-trace-db-gantt.mmd",
	"docs/quick-guides/19-inventario-agenti-e-gantt.md",
	"skills-vendor/yano/yano-cli/SKILL.md",
	"skills-vendor/yano/yano-cli/references/command-reference.md",
	"docs/guides/documentation-sync.md",
];

for (const file of requiredDocs) {
	if (!fs.existsSync(path.join(root, file))) failures.push(`${file}: superficie obbligatoria mancante`);
}

requireText("scripts/gantt-server.mjs", /GANTT_PORT_MIN\s*=\s*10000/);
requireText("scripts/gantt-server.mjs", /GANTT_PORT_MAX\s*=\s*19999/);
requireText("scripts/gantt-server.mjs", /registerGantt|ganttRegistryPath/, "registro persistente Gantt");
requireText("scripts/gantt-server.mjs", /--persistent/);
requireText("scripts/gantt-server.mjs", /--link/);
requireText("scripts/gantt-server.mjs", /--links/);

requireText("README.md", /yano gantt --persistent --open/);
requireText("README.md", /yano gantt --link/);
requireText("README.md", /yano gantt --links/);
requireText("README.md", /10000-19999/);
requireText("README.md", /35 optional specialist roles/);
requireText("README.md", /documentation-sync\.md/);
requireText("docs/quick-guides/quick-start.md", /yano gantt --persistent --open/);
requireText("docs/quick-guides/quick-start.md", /yano gantt --links/);
requireText("docs/quick-guides/quick-start.md", /10000-19999/);
requireText("docs/architecture/architecture.md", /10000-19999/);
requireText("docs/architecture/architecture.md", /YANO_DATA_DIR>\/gantt\/instances\.json/);
requireText("docs/architecture/architecture.mmd", /10000-19999/);
requireText("docs/architecture/architecture.mmd", /gantt\/instances\.json/);
requireText("docs/diagram/05-trace-db-gantt.mmd", /10000-19999/);
requireText("docs/diagram/05-trace-db-gantt.mmd", /--persistent/);
requireText("docs/quick-guides/19-inventario-agenti-e-gantt.md", /--persistent --open/);
requireText("docs/quick-guides/19-inventario-agenti-e-gantt.md", /--links/);
requireText("docs/quick-guides/19-inventario-agenti-e-gantt.md", /10000-19999/);
requireText("skills-vendor/yano/yano-cli/SKILL.md", /yano gantt --persistent --open/);
requireText("skills-vendor/yano/yano-cli/SKILL.md", /yano gantt --links --json/);
requireText("skills-vendor/yano/yano-cli/references/command-reference.md", /yano gantt --links/);
requireText("skills-vendor/yano/yano-cli/references/command-reference.md", /10000-19999/);
requireText("docs/guides/documentation-sync.md", /Ogni invocazione di `docs-sync`/);
for (const category of ["docs/architecture/", "docs/guides/", "docs/quick-guides/", "docs/adr/", "docs/notes/", "docs/postman/", "docs/cheat-sheet/", "docs/diagram/"]) {
	requireText("docs/guides/documentation-sync.md", new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), category);
}

const cheatDir = path.join(root, "docs", "cheat-sheet");
if (!fs.existsSync(cheatDir)) failures.push("docs/cheat-sheet: directory mancante");
else {
	const cheatSheets = fs.readdirSync(cheatDir).filter((file) => file.endsWith(".md") && file !== "README.md").sort();
	if (!cheatSheets.includes("00-generale.md")) failures.push("docs/cheat-sheet: manca 00-generale.md");
	const index = read("docs/cheat-sheet/README.md");
	for (const file of cheatSheets) if (!index.includes(`./${file}`)) failures.push(`docs/cheat-sheet/README.md: manca il link a ${file}`);
}

const commandReference = read("skills-vendor/yano/yano-cli/references/command-reference.md");
for (const command of [
	"yano init", "yano start", "yano doctor", "yano update", "yano end", "yano projects",
	"yano gantt", "yano watch", "yano trace", "yano repair", "yano config", "yano data",
	"yano architect", "yano auto-improve", "yano feedback", "yano playbook", "yano agent",
	"yano cron",
]) if (!commandReference.includes(command)) failures.push(`command-reference.md: manca ${command}`);

if (process.env.YANO_DOCS_ENFORCE_DIFF === "1" && fs.existsSync(path.join(root, ".git"))) {
	try {
		const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
		const codeChanged = changed.some((file) => /^(bin|scripts|extensions|agents|prompts|playbooks)\//.test(file) && !file.startsWith("scripts/smoke-test-"));
		const docsChanged = changed.some((file) => /^(README\.md|AGENTS\.md|docs\/|skills-vendor\/yano\/yano-cli\/)/.test(file));
		if (codeChanged && !docsChanged) failures.push("modifica al codice senza alcun aggiornamento documentale (YANO_DOCS_ENFORCE_DIFF=1)");
	} catch (error) {
		failures.push(`impossibile verificare il diff Git: ${error.message}`);
	}
}

if (failures.length) {
	for (const failure of failures) console.error(`ERR ${failure}`);
	console.error(`Documentation sync failed: ${failures.length} finding(s).`);
	process.exit(1);
}

console.log(`Documentation sync passed: ${requiredDocs.length} core surfaces and cheat-sheets are aligned.`);
