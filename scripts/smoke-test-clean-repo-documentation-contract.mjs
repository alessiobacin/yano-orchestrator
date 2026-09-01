#!/usr/bin/env node

// Contract smoke test for the documentation-completeness part of clean-repo.
// This is intentionally text-based: the runtime delegates the audit and
// authoring to agents, so these requirements must remain explicit in the
// packaged Playbook and both role instructions.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const playbook = read("playbooks/clean-repo.yaml");
const curator = read("agents/roles.yaml");
const docsSync = read("prompts/docs-sync.md");
const categories = ["architecture", "guides", "quick-guides", "adr", "notes", "postman", "cheat-sheet", "diagram"];

for (const category of categories) {
	assert.match(playbook, new RegExp(category.replace("-", "[-/]?")), `clean-repo must mention ${category}`);
	assert.match(docsSync, new RegExp(category.replace("-", "[-/]?")), `docs-sync must checklist ${category}`);
}

assert.match(playbook, /every_missing_category_gets_a_real_file/);
assert.match(playbook, /Empty\s+directories/);
assert.match(playbook, /not applicable/);
assert.match(curator, /directory\/file equivalente trovato oppure il percorso e il file reale da creare/);
assert.match(curator, /presenza o assenza del backend/);
assert.match(docsSync, /almeno un file utile al suo interno/);
assert.match(docsSync, /collection JSON importabile/);
assert.match(docsSync, /directory\s+creata\s+senza\s+file\s+non\s+soddisfa/);
assert.match(docsSync, /tutte le otto categorie/);

console.log("smoke-test-clean-repo-documentation-contract: ok (canonical categories, real files, backend/Postman applicability, complete inventory)");
