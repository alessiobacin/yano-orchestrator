// Regression guards for the non-negotiable development-cycle contracts:
// independent coder/reviewer models and documentation inventory at every
// docs-sync invocation.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const roles = YAML.parse(read("agents/roles.yaml")).roles;
const backend = YAML.parse(read("playbooks/backend-change.yaml"));

assert.equal(roles.coder.model_diversity.must_differ_from, "reviewer");
assert.equal(roles.reviewer.model_diversity.must_differ_from, "coder");
assert.ok(backend.invariants.includes("coder_and_reviewer_use_distinct_pinned_llm_models"));
assert.ok(backend.transitions.find((transition) => transition.id === "start_implementation").requires.includes("coder_and_reviewer_have_distinct_pinned_llm_models"));
assert.match(read("prompts/planner.md"), /Indipendenza obbligatoria coder ↔ reviewer/);
assert.match(read("prompts/planner.md"), /due `pinned_id` llmProxy diversi/);

const docsPrompt = read("prompts/docs-sync.md");
assert.match(docsPrompt, /In \*\*ogni\*\* round, non soltanto nel playbook `clean-repo`/i);
for (const category of ["architecture/", "guides/", "quick-guides/", "adr/", "notes/", "postman/", "cheat-sheet/", "diagram/"]) assert.ok(docsPrompt.includes(`\`${category}\``), `docs-sync must cover ${category}`);
assert.match(read("docs/guides/documentation-sync.md"), /Ogni invocazione di `docs-sync`/);

console.log("smoke-test-development-contracts: ok");
