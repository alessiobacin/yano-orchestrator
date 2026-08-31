#!/usr/bin/env node

// Real CLI smoke test for the `conversation` catalog playbook: the honest
// default that `candidateForTask()` in scripts/yano-architect.mjs now
// returns for a task with no clear delivery/execution intent, instead of
// silently assuming coding work (`backend-change`). Covers:
//  (a) a genuinely ambiguous/non-actionable message routes to `conversation`
//  (b) a clearly actionable coding request still routes to a delivery
//      playbook (no regression from the fallback change)
//  (c) `playbooks/conversation.yaml` is discovered by the catalog and
//      `yano architect assess`/`yano playbook show` both resolve it with
//      `catalog.action: reuse`

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { inspectConversationPolicy } from "./watch-stalls.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yano-conversation-playbook-"));
const projectRoot = path.join(root, "project");
const dataDir = path.join(root, "yano-temp");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({ name: "conversation-smoke", private: true }, null, 2)}\n`);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "bin", "yano.mjs");
const env = { ...process.env, YANO_DATA_DIR: dataDir };

const roles = parseYaml(fs.readFileSync(path.join(packageRoot, "agents", "roles.yaml"), "utf8"))?.roles || {};
const conversationResearcher = roles["conversation-researcher"];
const researcherPrompt = fs.readFileSync(path.join(packageRoot, "prompts", "conversation-researcher.md"), "utf8");
const conversationPlaybook = fs.readFileSync(path.join(packageRoot, "playbooks", "conversation.yaml"), "utf8");

function runCli(args) {
	const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, env, encoding: "utf8", maxBuffer: 20_000_000 });
	assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
	try { return JSON.parse(result.stdout); }
	catch (error) { throw new Error(`Output JSON non valido per ${args.join(" ")}: ${error.message}\n${result.stdout}`); }
}

try {
	// (0) The assisted conversation contract is deliberately narrower than a
	// delivery team: Yano may initialize its metadata DB, but the consultant
	// must not create development state in the project.
	assert.equal(conversationResearcher?.playbook, "conversation");
	assert.deepEqual(conversationResearcher?.teams, ["conversation", "research"]);
	assert.deepEqual(conversationResearcher?.cli, ["yano"]);
	assert.match(conversationResearcher?.brief || "", /read-only/i);
	assert.match(researcherPrompt, /esclusivamente read-only/i);
	for (const forbidden of ["worktree_create", "worktree_finalize", "run_create", "spec_create", "ticket_create", "plan_set", "report_append"]) {
		assert.match(researcherPrompt, new RegExp("`" + forbidden + "`"), `researcher prompt must forbid ${forbidden}`);
	}
	assert.match(conversationPlaybook, /id: consulting/);
	assert.match(conversationPlaybook, /id: start_consultation/);
	assert.match(conversationPlaybook, /id: receive_consultation/);
	assert.match(conversationPlaybook, /conversation-researcher via agent_send\/agent_await/);
	const plannerPrompt = fs.readFileSync(path.join(packageRoot, "prompts", "planner.md"), "utf8");
	const watcherSource = fs.readFileSync(path.join(packageRoot, "scripts", "watch-stalls.mjs"), "utf8");
	assert.match(plannerPrompt, /orchestrator_init/);
	assert.match(plannerPrompt, /conversation-researcher-01/);
	assert.match(plannerPrompt, /agent_send.*senza `slug`.*agent_await/s);
	assert.match(watcherSource, /planner_task_completed/);
	assert.match(watcherSource, /run_completed/);
	assert.match(watcherSource, /yano_watcher_final_scan_requested/);
	const cleanTrace = inspectConversationPolicy([
		{ type: "session_start", instance: "planner-01", role: "planner" },
		{ type: "session_start", instance: "conversation-researcher-01", role: "conversation-researcher" },
		{ type: "agent_send_out", target: "conversation-researcher-01" },
		{ type: "tool_execution_start", tool_call_id: "init-1", tool: "orchestrator_init", instance: "planner-01", role: "planner" },
		{ type: "tool_execution_end", tool_call_id: "init-1", tool: "orchestrator_init", ok: true, instance: "planner-01", role: "planner" },
		{ type: "tool_execution_start", tool_call_id: "read-1", tool: "bash", instance: "conversation-researcher-01", role: "conversation-researcher" },
		{ type: "tool_execution_start_payload", tool_call_id: "read-1", args: { command: "curl -sL https://example.test/docs | grep -i transaction" } },
		{ type: "tool_execution_end", tool_call_id: "read-1", tool: "bash", ok: true, instance: "conversation-researcher-01", role: "conversation-researcher" },
	]);
	assert.equal(cleanTrace.conversationEvidence, true);
	assert.deepEqual(cleanTrace.findings, [], "watcher accepts a read-only conversation consultation");
	const badTrace = inspectConversationPolicy([
		{ type: "session_start", instance: "planner-01", role: "planner" },
		{ type: "agent_send_out", target: "conversation-researcher-01" },
		{ type: "tool_execution_start", tool_call_id: "launch-1", tool: "bash", instance: "planner-01", role: "planner" },
		{ type: "tool_execution_start_payload", tool_call_id: "launch-1", args: { command: "herdr agent start bad-name --kind pi" } },
		{ type: "tool_execution_end", tool_call_id: "launch-1", tool: "bash", ok: false, instance: "planner-01", role: "planner" },
	]);
	assert.equal(badTrace.findings.length, 1, "watcher detects a failed conversation specialist launch");
	assert.equal(badTrace.findings[0].signal, "conversation_policy_violation");

	// (a) Ambiguous / purely conversational tasks — question, opinion request,
	// options comparison, "help me understand" — must NOT be assumed to be
	// coding work. They fall to the new `conversation` default.
	const conversationalTasks = [
		"cosa ne pensi di usare Postgres invece di Mongo per questo caso?",
		"aiutami a capire come funziona il sistema di ticket di questo repo",
		"secondo te conviene usare Redis per la cache di sessione?",
		"spiegami la differenza tra worktree e playbook",
	];
	for (const task of conversationalTasks) {
		const assessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", task, "--json"]);
		assert.equal(assessment.candidate_playbook, "conversation", `task should route to conversation: "${task}" -> ${assessment.candidate_playbook}`);
		assert.deepEqual(assessment.roles, [], `conversation candidate must not spin up any role for: "${task}"`);
		assert.equal(assessment.catalog.action, "reuse", `conversation.yaml must already be a catalog exact match for: "${task}"`);
	}

	// (b) A clearly actionable, delivery-shaped request — an explicit action
	// verb (implementa/crea/scrivi/...) with no more specific category match
	// — must still land on a real delivery playbook, not conversation. This
	// is the regression the fallback change must not introduce: previously
	// any unmatched text fell to backend-change/coder+reviewer, and text
	// that clearly asks for work must keep doing so.
	const actionableTasks = [
		"implementa un endpoint per il login",
		"Implementa una funzione backend",
		"crea una funzione di validazione per il form di registrazione",
	];
	for (const task of actionableTasks) {
		const assessment = runCli(["architect", "assess", "--project-root", projectRoot, "--task", task, "--json"]);
		assert.equal(assessment.candidate_playbook, "backend-change", `clearly actionable task must not fall into conversation: "${task}" -> ${assessment.candidate_playbook}`);
		assert.deepEqual(assessment.roles, ["coder", "reviewer"]);
	}

	// (c) playbooks/conversation.yaml resolves directly through the catalog.
	const shown = runCli(["playbook", "show", "conversation", "--json"]);
	assert.equal(shown.id, "conversation");
	assert.equal(shown.document.catalog.scope, "global");
	assert.equal(shown.document.catalog.reusable, true);

	const candidates = runCli(["playbook", "candidates", "--task", "cosa ne pensi di questa idea?", "--project-root", projectRoot, "--json"]);
	assert.equal(candidates.recommended.id, "conversation");
	assert.equal(candidates.user_choice_required, false);

	const decision = runCli(["architect", "assess", "--project-root", projectRoot, "--task", "cosa ne pensi di questa idea?", "--json"]);
	assert.equal(decision.catalog.action, "reuse");
	assert.equal(decision.catalog.exact_match.id, "conversation");
	assert.equal(decision.needs_new_playbook, false);

	console.log("smoke-test-yano-conversation-playbook: ok (conversational fallback, actionable-request non-regression, catalog reuse)");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
