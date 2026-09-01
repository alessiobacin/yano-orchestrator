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
import { inspectDebatePolicy, inspectProjectScope } from "./watch-stalls.mjs";

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
	// (0) The planner contract must put explicit debate intent before the
	// generic conversation fallback and must require a roster/model proposal.
	const plannerPrompt = fs.readFileSync(path.join(packageRoot, "prompts", "planner.md"), "utf8");
	assert.match(plannerPrompt, /Priorità: il dibattito esplicito non è conversation/);
	assert.match(plannerPrompt, /almeno due istanze `debater`/);
	assert.match(plannerPrompt, /yano model-advisor recommend --role-class coordinator --json/);
	assert.match(plannerPrompt, /conversation-researcher già presente ma non pertinente va ignorato/);
	assert.match(plannerPrompt, /Questo è un gate obbligatorio/);
	assert.match(plannerPrompt, /prima di una risposta utente[\s\S]*che confermi il roster e[\s\S]*i modelli non chiamare/);
	assert.match(plannerPrompt, /Recovery di uno specialista offline/);
	assert.match(plannerPrompt, /Preflight obbligatorio di ogni task/);
	assert.match(plannerPrompt, /--provider llmproxy --model 'z-ai\/glm-5\.3-flash@openrouter-glm'/);
	assert.doesNotMatch(plannerPrompt, /lanciare un agente[^\n]*--provider openrouter-glm --model/);

	// The watcher must reject the exact failure seen in the manual run: a
	// debate routed to conversation-researcher and completed with no debaters.
	const badDebateTrace = [
		{ type: "assistant_response", instance: "planner-01", role: "planner", text: "Dibattito strutturato tra due prospettive." },
		{ type: "agent_send_out", instance: "planner-01", role: "planner", target: "conversation-researcher-01", prompt_preview: "DIBATTITO Postgres vs Mongo" },
		{ type: "agent_end", instance: "planner-01", role: "planner" },
	];
	const badPolicy = inspectDebatePolicy(badDebateTrace, { completed: true });
	assert.equal(badPolicy.debateEvidence, true);
	assert.ok(badPolicy.findings.some((finding) => finding.kind === "wrong-specialist"));
	assert.ok(badPolicy.findings.some((finding) => finding.kind === "insufficient-debaters"));
	assert.ok(badPolicy.findings.some((finding) => finding.kind === "missing-user-confirmation"));

	const healthyDebateTrace = [
		{ type: "visible_session_branch", branch: [
			{ message: { role: "assistant", content: [{ type: "text", text: "Piano debate: due debater, stance A/B, model@provider-id proposti. Confermi il roster?" }] } },
			{ message: { role: "user", content: [{ type: "text", text: "Confermo roster e modelli, procedi." }] } },
		] },
		{ type: "assistant_response", instance: "planner-01", role: "planner", text: "Debate framing e roster confermato." },
		{ type: "session_start", instance: "debater-01", role: "debater" },
		{ type: "session_start", instance: "debater-02", role: "debater" },
		{ type: "tool_execution_start_payload", args: { command: "yano model-advisor recommend --role-class coordinator --json" } },
		{ type: "agent_send_out", instance: "planner-01", role: "planner", target: "debater-01", prompt_preview: "Debate opening: stance A" },
		{ type: "agent_send_out", instance: "planner-01", role: "planner", target: "debater-02", prompt_preview: "Debate opening: stance B" },
		{ type: "agent_end", instance: "planner-01", role: "planner" },
	];
	const healthyPolicy = inspectDebatePolicy(healthyDebateTrace, { completed: true });
	assert.equal(healthyPolicy.debateEvidence, true);
	assert.equal(healthyPolicy.findings.length, 0);
	const uninitializedPolicy = inspectDebatePolicy(healthyDebateTrace, { completed: true, initialized: false });
	assert.ok(uninitializedPolicy.findings.some((finding) => finding.kind === "missing-orchestrator-init"), "un debate tracciato senza DB deve essere segnalato dal watcher");
	const fallbackPolicy = inspectDebatePolicy([
		...healthyDebateTrace,
		{ type: "assistant_response", instance: "debater-02", role: "debater", text: "[llmp] provider n.2: openrouter-glm (opencode-bacin:deepseek-v4-flash is returning: 400)" },
	], { completed: true });
	assert.ok(fallbackPolicy.findings.some((finding) => finding.kind === "model-runtime-fallback"), "un fallback runtime del modello deve essere visibile al watcher");
	const informationalPiWarningPolicy = inspectDebatePolicy([
		...healthyDebateTrace,
		{ type: "assistant_response", instance: "debater-02", role: "debater", text: "Warning: Model \"z-ai/glm-5.3-flash@openrouter-glm\" not found for provider \"llmproxy\". Using custom model id.\n[llmproxy] openrouter-glm/z-ai/glm-5.3-flash (200)" },
	], { completed: true });
	assert(!informationalPiWarningPolicy.findings.some((finding) => finding.kind === "model-runtime-fallback"), "il warning catalogo di Pi senza 4xx/5xx non è un fallback e non deve allarmare il watcher");
	const catalogOnlyTrace = [
		{ type: "tool_execution_end", instance: "planner-01", role: "planner", tool: "playbook_candidates", result: { content: [{ type: "text", text: "candidate playbooks: conversation, debate, refactor" }] } },
		{ type: "agent_end", instance: "planner-01", role: "planner" },
	];
	const catalogOnlyPolicy = inspectDebatePolicy(catalogOnlyTrace, { completed: true });
	assert.equal(catalogOnlyPolicy.debateEvidence, false, "il testo del catalogo restituito da un tool non attiva falsamente il controllo debate");
	const scopePolicy = inspectProjectScope([
		{ type: "session_start", instance: "planner-01", role: "planner", project: "refactor-smoke" },
		{ type: "session_start", instance: "coder-01", role: "coder", project: "Manual E2E 08 Refactor Playbook", default_project: "manual-e2e-08-refactor-playbook", project_scope_override: true },
	], "manual-e2e-08-refactor-playbook");
	assert.equal(scopePolicy.findings.length, 1, "il watcher riconosce un agente della root avviato nello scope MQTT esplicito sbagliato");
	assert.equal(scopePolicy.findings[0].signal, "project_scope_mismatch");

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
