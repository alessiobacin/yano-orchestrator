#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function assess(task) {
	return JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "yano-architect.mjs"), "assess", "--task", task, "--json"], { cwd: root, encoding: "utf8" }));
}
function expectPlaybook(task, expected) { assert.equal(assess(task).candidate_playbook, expected, `${task} should route to ${expected}`); }

expectPlaybook("audit completo dell'app: test, architettura, comandi, tool, CLI, MCP, script, playbook e UX", "audit-campaign");
expectPlaybook("review dell'architettura: file enormi, duplicazioni e manutenibilità", "architecture-health-audit");
expectPlaybook("verificare se i test coprono tutti gli use case e le regressioni", "test-adequacy-audit");
expectPlaybook("audit della toolchain CLI MCP skill playbook e capability", "toolchain-readiness-audit");
expectPlaybook("analisi dei token e di cosa si può delegare a script deterministici", "ai-delegation-audit");
expectPlaybook("refactor this module without behavior change", "refactor");
console.log("audit routing smoke test passed");
