#!/usr/bin/env node

// Real CLI E2E for catalog-first Architect behavior. It uses the actual Yano
// executable and SQLite storage, while keeping all generated state isolated in
// a temporary YANO_DATA_DIR. No project file may be changed by Architect.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-architect-team-e2e-"));
const projectRoot = path.join(root, "sales-companion");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({ name: "sales-companion", private: true }, null, 2)}\n`);
fs.writeFileSync(path.join(projectRoot, "README.md"), "# E2E fixture\n");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "bin", "yano.mjs");
const env = { ...process.env, YANO_DATA_DIR: dataDir, PI_ORCH_BROKER_URL: "mqtt://127.0.0.1:1883" };

function projectDigest() {
	return crypto.createHash("sha256")
		.update(fs.readFileSync(path.join(projectRoot, "package.json")))
		.update(fs.readFileSync(path.join(projectRoot, "README.md")))
		.digest("hex");
}

function runCli(args) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, env, encoding: "utf8", maxBuffer: 20_000_000 });
	assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}`);
	try { return JSON.parse(result.stdout); }
	catch (error) { throw new Error(`Output JSON non valido per ${args.join(" ")}: ${error.message}\n${result.stdout}`); }
}

try {
	const before = projectDigest();

	const assessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", "Prepara documenti strategici di vendita, ricerca di mercato, SEO e sito", "--json"]);
	assert.equal(assessment.candidate_playbook, "knowledge-authoring");
	assert.equal(assessment.catalog.action, "reuse");
	assert.equal(assessment.needs_new_playbook, false);
	assert.equal(assessment.team.strategy, "planner-selectable");
	assert.deepEqual(assessment.team.variants.find((variant) => variant.id === "full-team").parallel_groups[0], ["market-researcher", "seo-strategist"]);

	const reused = runCli(["architect", "propose", "--project-root", projectRoot, "--task", "Prepara documenti strategici di vendita, ricerca di mercato, SEO e sito", "--json"]);
	assert.equal(reused.reused, true);
	assert.equal(reused.no_project_mutation, true);
	assert.equal(reused.playbook.id, "knowledge-authoring");

	const proposed = runCli(["architect", "propose", "--project-root", projectRoot, "--task", "Crea un nuovo playbook per la consulenza quantistica specialistica", "--json"]);
	assert.equal(proposed.proposal.status, "awaiting_user_input");
	assert.equal(proposed.interview.status, "open");
	assert.equal(proposed.assessment.catalog.action, "create");
	assert.match(proposed.proposal.playbook_id, /^custom-specialization$/);
	assert.equal(proposed.proposal.project_name, "sales-companion");

	const proposalId = proposed.proposal.proposal_id;
	const gated = runCli(["architect", "provision", "--proposal-id", proposalId, "--once", "--json"]);
	assert.equal(gated.reason, "awaiting_user_input");
	assert.equal(gated.operational, false);

	const answered = runCli(["architect", "answer", "--proposal-id", proposalId, "--status", "approved", "--text", "Globale e riutilizzabile; team multi-agente; priorità balanced", "--json"]);
	assert.equal(answered.next_state, "draft");

	const selected = runCli(["architect", "team", "--proposal-id", proposalId, "--variant", "full-team", "--json"]);
	assert.equal(selected.strategy, "planner-selectable");
	assert.deepEqual(selected.roles, ["specialist-researcher", "specialist-author", "specialist-reviewer"]);
	assert.deepEqual(selected.parallel_groups, [["specialist-researcher"], ["specialist-author"], ["specialist-reviewer"]]);

	const provisioned = runCli(["architect", "provision", "--proposal-id", proposalId, "--once", "--json"]);
	assert.equal(provisioned.status, "ready_ephemeral");
	assert.equal(provisioned.ready, true);
	assert.equal(provisioned.operational, true);
	assert.ok(provisioned.checks.every((check) => check.status === "ready"), JSON.stringify(provisioned.checks));

	const status = runCli(["architect", "status", "--proposal-id", proposalId, "--json"]);
	assert.equal(status.interviews[0].status, "answered");
	assert.ok(status.events.some((event) => event.type === "team_variant_selected"));

	const feedback = runCli(["architect", "feedback", "--proposal-id", proposalId, "--status", "changes_requested", "--text", "Aggiungere una revisione del team prima di riprovare", "--actor", "planner", "--json"]);
	assert.equal(feedback.next_state, "revision_required");
	const revised = runCli(["architect", "revise", "--proposal-id", proposalId, "--task", "Crea un nuovo playbook per una competenza specialistica quantistica con review", "--json"]);
	assert.equal(revised.status, "awaiting_user_input");
	const revisedStatus = runCli(["architect", "status", "--proposal-id", proposalId, "--json"]);
	assert.equal(revisedStatus.interviews[0].status, "open");
	assert.equal(projectDigest(), before, "Architect ha modificato il progetto di riferimento");
	console.log("smoke-test-yano-architect-team: ok (catalog reuse, interview gate, team selection, readiness, no project mutation)");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
