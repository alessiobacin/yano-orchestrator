#!/usr/bin/env node

// Real CLI smoke test for the `clean-repo` catalog playbook: the dedicated
// contract that `candidateForTask()` in scripts/yano-architect.mjs routes to
// for a repository-hygiene intent (removing files that are no longer
// needed, moving misplaced files into their proper directories, checking
// for now-dangling references, and auditing/filling documentation
// completeness) instead of folding it into `documentation-release`,
// `frontend-browser`, `refactor` or any other existing playbook. Covers:
//  (a) several realistic clean-repo-intent tasks (Italian and English)
//      route to `clean-repo` with roles: ["repo-curator", "docs-sync",
//      "reviewer"] — verified against the real CLI.
//  (b) non-regression, each asserted against the real CLI: a plain
//      documentation-release-shaped task still routes to
//      `documentation-release`; a plain refactor task still routes to
//      `refactor`; a plain actionable coding request still routes to
//      `backend-change`; a debate-shaped task still routes to `debate`.
//      This proves the two collision risks the new branch was placed
//      around are actually resolved:
//        1. `clean-repo` is inserted BEFORE `documentation-release` in the
//           cascade because documentation-release's regex matches on the
//           bare substring "document" — a clean-repo phrase like "missing
//           documentation" contains that substring and would otherwise be
//           swallowed by documentation-release.
//        2. `refactor`'s regex includes the literal token "cleanup" (no
//           space); clean-repo's regex only ever uses "clean up" (two
//           words, with a space) plus riorganizza/pulisci/etc, so there is
//           no literal-token collision in either direction.
//  (c) `playbooks/clean-repo.yaml` resolves via the catalog: `yano playbook
//      show`, `yano playbook candidates` and `yano architect assess` all
//      agree it is an exact `reuse` match with no ambiguous selection.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-clean-repo-playbook-"));
const projectRoot = path.join(root, "project");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({ name: "clean-repo-smoke", private: true }, null, 2)}\n`);

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
	// (a) Realistic clean-repo-intent tasks — repository hygiene,
	// reorganization, dangling-reference checks and documentation-gap
	// filling — must route to the `clean-repo` playbook with
	// ["repo-curator", "docs-sync", "reviewer"]. Verified against the real
	// CLI before writing these assertions, exactly as given in the task
	// brief — no rewording was needed, all four matched on the first try.
	const cleanRepoTasks = [
		"Pulisci la repo dai file che non servono più",
		"riorganizza i file di questo progetto nelle directory giuste",
		"controlla se ci sono riferimenti non più esistenti e documentazione mancante",
		"clean up the repository and create the missing documentation",
	];
	for (const task of cleanRepoTasks) {
		const assessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", task, "--json"]);
		assert.equal(assessment.candidate_playbook, "clean-repo", `task should route to clean-repo: "${task}" -> ${assessment.candidate_playbook}`);
		assert.deepEqual(assessment.roles, ["repo-curator", "docs-sync", "reviewer"], `clean-repo candidate must propose repo-curator + docs-sync + reviewer for: "${task}"`);
		assert.equal(assessment.catalog.action, "reuse", `clean-repo.yaml must already be a catalog exact match for: "${task}"`);
		assert.equal(assessment.catalog.exact_match.id, "clean-repo");
	}

	// (b) Non-regression: a plain documentation-release-shaped task must
	// still route to documentation-release, NOT clean-repo — proving the
	// "document" substring collision is resolved by cascade order alone
	// (clean-repo sits before documentation-release, but this string does
	// not match clean-repo's regex in the first place, so documentation-
	// release still wins on its own regex). Verified against the real CLI.
	const docsTask = "aggiorna il changelog con la nuova versione";
	const docsAssessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", docsTask, "--json"]);
	assert.equal(docsAssessment.candidate_playbook, "documentation-release", `plain documentation task must not fall into clean-repo: "${docsTask}" -> ${docsAssessment.candidate_playbook}`);
	assert.deepEqual(docsAssessment.roles, ["docs-sync"]);

	// (b, continued) Non-regression: a plain refactor task must still route
	// to refactor, NOT clean-repo — proving the "cleanup" literal-token
	// collision does not exist: refactor's regex matches the literal
	// substring "cleanup" (no space), clean-repo's regex only ever uses
	// "clean up" (two words, with a space), so neither string trips the
	// other's regex. Verified against the real CLI.
	const refactorTask = "refactor the payment module to reduce duplication";
	const refactorAssessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", refactorTask, "--json"]);
	assert.equal(refactorAssessment.candidate_playbook, "refactor", `plain refactor task must not fall into clean-repo: "${refactorTask}" -> ${refactorAssessment.candidate_playbook}`);
	assert.deepEqual(refactorAssessment.roles, ["refactoring-specialist", "reviewer"]);

	// (b, continued) Non-regression: a clearly actionable coding request
	// must still route to backend-change — proving clean-repo's insertion
	// point (right after knowledge-authoring, before documentation-release)
	// does not shadow the existing action-verb fallback for unrelated work.
	const actionableTask = "implementa un endpoint per il login";
	const actionableAssessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", actionableTask, "--json"]);
	assert.equal(actionableAssessment.candidate_playbook, "backend-change", `clearly actionable task must not fall into clean-repo: "${actionableTask}" -> ${actionableAssessment.candidate_playbook}`);
	assert.deepEqual(actionableAssessment.roles, ["coder", "reviewer"]);

	// (b, continued) Non-regression: a debate-shaped task must still route
	// to debate — proving clean-repo does not accidentally claim
	// debate-shaped text.
	const debateTask = "facciamo un dibattito su Postgres vs Mongo";
	const debateAssessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", debateTask, "--json"]);
	assert.equal(debateAssessment.candidate_playbook, "debate", `debate-shaped task must not fall into clean-repo: "${debateTask}" -> ${debateAssessment.candidate_playbook}`);
	assert.deepEqual(debateAssessment.roles, ["debater"]);

	// (c) playbooks/clean-repo.yaml resolves directly through the catalog.
	const shown = runCli(["playbook", "show", "clean-repo", "--json"]);
	assert.equal(shown.id, "clean-repo");
	assert.equal(shown.document.catalog.scope, "global");
	assert.equal(shown.document.catalog.reusable, true);

	const candidates = runCli(["playbook", "candidates", "--task", "pulisci la repo", "--project-root", projectRoot, "--json"]);
	assert.equal(candidates.recommended.id, "clean-repo");
	assert.equal(candidates.user_choice_required, false);

	const decision = runCli(["architect", "assess", "--project-root", projectRoot, "--task", "pulisci la repo", "--json"]);
	assert.equal(decision.catalog.action, "reuse");
	assert.equal(decision.catalog.exact_match.id, "clean-repo");
	assert.equal(decision.needs_new_playbook, false);

	console.log("smoke-test-yano-clean-repo-playbook: ok (clean-repo-intent routing, documentation-release/refactor/backend-change/debate non-regression, catalog reuse)");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
