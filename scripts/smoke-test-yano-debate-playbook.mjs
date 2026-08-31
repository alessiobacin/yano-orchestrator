#!/usr/bin/env node

// Real CLI smoke test for the `debate` catalog playbook: the structured,
// multi-agent, multi-model debate/discussion default that `candidateForTask()`
// in scripts/yano-architect.mjs routes to for a genuinely debate-shaped
// intent (asking for a debate, a second opinion, a pros/cons comparison
// between approaches) instead of the plain `conversation` default. Covers:
//  (a) several realistic debate-intent tasks (Italian and English) route to
//      `debate` with roles: ["debater"]
//  (b) non-regression: a plain conversational question with none of the
//      debate tokens still routes to `conversation` — the new debate
//      branch did not steal `conversation`'s territory
//  (c) non-regression: a clearly actionable coding request still routes to
//      `backend-change` — the new debate branch does not shadow the
//      existing action-verb fallback
//  (d) `playbooks/debate.yaml` resolves via the catalog: `yano playbook
//      show`, `yano playbook candidates` and `yano architect assess` all
//      agree it is an exact `reuse` match with no ambiguous selection

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-debate-playbook-"));
const projectRoot = path.join(root, "project");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({ name: "debate-smoke", private: true }, null, 2)}\n`);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "bin", "yano.mjs");
const env = { ...process.env, YANO_DATA_DIR: dataDir };

function runCli(args) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, env, encoding: "utf8", maxBuffer: 20_000_000 });
	assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
	try { return JSON.parse(result.stdout); }
	catch (error) { throw new Error(`Output JSON non valido per ${args.join(" ")}: ${error.message}\n${result.stdout}`); }
}

try {
	// (a) Realistic debate-intent tasks — asking for a debate, a second
	// opinion, a pros/cons comparison of approaches — must route to the new
	// `debate` playbook with a single `debater` role (the planner launches
	// multiple instances of it, but candidateForTask() only names the role
	// once, same convention as any other multi-instance role).
	const debateTasks = [
		"Facciamo un dibattito su Postgres vs MongoDB per questo caso",
		"Voglio una seconda opinione: conviene REST o GraphQL in questo caso?",
		"confronta le prospettive pro e contro di microservizi vs monolite",
		"which approach is better: optimistic or pessimistic locking here?",
	];
	for (const task of debateTasks) {
		const assessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", task, "--json"]);
		assert.equal(assessment.candidate_playbook, "debate", `task should route to debate: "${task}" -> ${assessment.candidate_playbook}`);
		assert.deepEqual(assessment.roles, ["debater"], `debate candidate must propose exactly the debater role for: "${task}"`);
		assert.equal(assessment.catalog.action, "reuse", `debate.yaml must already be a catalog exact match for: "${task}"`);
		assert.equal(assessment.catalog.exact_match.id, "debate");
	}

	// (b) Non-regression: a plain conversational question with none of the
	// debate tokens (no "dibattito", "second opinion", "pro e contro", ...)
	// must still route to `conversation`, unchanged — this exact string is
	// already asserted as `conversation` in
	// scripts/smoke-test-yano-conversation-playbook.mjs; asserting it again
	// here proves the new debate branch did not steal it.
	const conversationTask = "cosa ne pensi di usare Postgres invece di Mongo per questo caso?";
	const conversationAssessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", conversationTask, "--json"]);
	assert.equal(conversationAssessment.candidate_playbook, "conversation", `plain conversational task must still route to conversation, not debate: "${conversationTask}" -> ${conversationAssessment.candidate_playbook}`);
	assert.deepEqual(conversationAssessment.roles, []);

	// (c) Non-regression: a clearly actionable coding request must still
	// route to backend-change — already asserted elsewhere; asserting it
	// again here proves the new debate branch does not shadow the existing
	// action-verb fallback.
	const actionableTask = "implementa un endpoint per il login";
	const actionableAssessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", actionableTask, "--json"]);
	assert.equal(actionableAssessment.candidate_playbook, "backend-change", `clearly actionable task must not fall into debate: "${actionableTask}" -> ${actionableAssessment.candidate_playbook}`);
	assert.deepEqual(actionableAssessment.roles, ["coder", "reviewer"]);

	// (d) playbooks/debate.yaml resolves directly through the catalog.
	const shown = runCli(["playbook", "show", "debate", "--json"]);
	assert.equal(shown.id, "debate");
	assert.equal(shown.document.catalog.scope, "global");
	assert.equal(shown.document.catalog.reusable, true);

	const candidates = runCli(["playbook", "candidates", "--task", "facciamo un dibattito su Postgres vs Mongo", "--project-root", projectRoot, "--json"]);
	assert.equal(candidates.recommended.id, "debate");
	assert.equal(candidates.user_choice_required, false);

	const decision = runCli(["architect", "assess", "--project-root", projectRoot, "--task", "facciamo un dibattito su Postgres vs Mongo", "--json"]);
	assert.equal(decision.catalog.action, "reuse");
	assert.equal(decision.catalog.exact_match.id, "debate");
	assert.equal(decision.needs_new_playbook, false);

	console.log("smoke-test-yano-debate-playbook: ok (debate-intent routing, conversation/backend-change non-regression, catalog reuse)");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
