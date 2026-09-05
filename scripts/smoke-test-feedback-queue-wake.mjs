#!/usr/bin/env node

// Regression guard for the "suggestions are never woken" bug found on
// 2026-09-06: the planner's idle-catch-up mechanism (wakeNextQueuedFeedback in
// extensions/orchestrator.ts, triggered on every planner_turn_end AND on a
// live MQTT feedback_received command) only ever queried
// listFeedback(db, { type: "bug", ... }) — a suggestion sitting in
// "pending_planner"/"queued" was NEVER dequeued, no matter how long the
// planner stayed idle, because the query itself excluded type="suggestion"
// unconditionally. The bug/suggestion dequeue-and-message logic has been
// extracted to claimNextQueuedFeedback() (yano-feedback.mjs) precisely so it
// can be tested here without spinning up the MQTT/Pi harness.
//
// Each check uses its own project id so ordering assertions never depend on
// leftover state from a previous check, and a tiny sleep separates creates
// whose relative order matters (created_at has millisecond resolution).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-wake-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";
const { openDatabase, createFeedback, claimNextQueuedFeedback, buildQueuedFeedbackWakeMessage, terminalStatusForFeedbackId } = await import("./yano-feedback.mjs");

console.log("Regression: claimNextQueuedFeedback() must dequeue suggestions, not just bugs");
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok — ${name}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const db = openDatabase();

await check("no feedback queued for the project returns null", () => {
	const result = claimNextQueuedFeedback(db, "workspace-empty");
	assert.equal(result, null);
});

await check("a lone SUGGESTION is now claimed and returned (this is the actual regression fix — previously always null)", async () => {
	const project = "workspace-lone-suggestion";
	const suggestion = await createFeedback(db, { type: "suggestion", project_id: project, message: "Aggiungere export CSV" });
	assert.equal(suggestion.status, "pending_planner", "sanity: notify was skipped, so it stayed queued rather than moving to 'queued'");
	const result = claimNextQueuedFeedback(db, project);
	assert.ok(result, "a queued suggestion must be dequeued when it is the only pending item");
	assert.equal(result.type, "suggestion");
	assert.equal(result.claimed.id, suggestion.id);
	assert.equal(result.claimed.status, "processing", "claiming must transition status the same way it always did for bugs");
	assert.equal(claimNextQueuedFeedback(db, project), null, "queue must be empty once the only item was claimed");
});

await check("with both a bug and a suggestion queued, no preferredType still prioritizes the bug (existing FIFO priority preserved)", async () => {
	const project = "workspace-mixed-priority";
	const suggestion = await createFeedback(db, { type: "suggestion", project_id: project, message: "Tema scuro" });
	const bug = await createFeedback(db, { type: "bug", project_id: project, message: "Bottone rotto", resolution: "automatic", test_username: "u", test_password: "p" });
	const result = claimNextQueuedFeedback(db, project);
	assert.equal(result.type, "bug", "a bug must still win over a suggestion when no live signal hints otherwise");
	assert.equal(result.claimed.id, bug.id);
	assert.equal(suggestion.status, "pending_planner", "the suggestion must be untouched — only the bug was claimed");
});

await check("preferredType:'suggestion' (the live feedback_received case) checks the suggestion queue first, in its own FIFO order — even with an older bug also queued", async () => {
	const project = "workspace-preferred-suggestion";
	const olderSuggestion = await createFeedback(db, { type: "suggestion", project_id: project, message: "Prima suggestion in coda" });
	await sleep(2);
	const newerSuggestion = await createFeedback(db, { type: "suggestion", project_id: project, message: "Seconda suggestion in coda" });
	await createFeedback(db, { type: "bug", project_id: project, message: "Un bug anche più vecchio", resolution: "automatic", test_username: "u", test_password: "p" });
	const result = claimNextQueuedFeedback(db, project, { preferredType: "suggestion" });
	assert.equal(result.type, "suggestion", "the live signal was about a suggestion, so the suggestion queue is checked first");
	assert.equal(result.claimed.id, olderSuggestion.id, "FIFO order within the suggestion queue itself must still be respected");
	assert.notEqual(result.claimed.id, newerSuggestion.id);
});

await check("the wake message text differs by type and reflects planner.md's rules (bug: classify impact now; suggestion: always needs user confirmation)", () => {
	const bugMessage = buildQueuedFeedbackWakeMessage({ id: "BUG-x", message: "Il salvataggio fallisce" }, "bug");
	const suggestionMessage = buildQueuedFeedbackWakeMessage({ id: "SUG-x", message: "Aggiungere dark mode" }, "suggestion");
	assert.match(bugMessage, /Classifica prima l'impatto/);
	assert.match(suggestionMessage, /conferma esplicita dell'utente/);
	assert.match(suggestionMessage, /nuova feature/);
	assert.notEqual(bugMessage, suggestionMessage);
});

await check("screenshots, when present, are still embedded in the wake message for both types", () => {
	const message = buildQueuedFeedbackWakeMessage({ id: "SUG-y", message: "Vedi allegato", screenshots: [{ url: "https://example.test/a.png" }] }, "suggestion");
	assert.match(message, /Screenshot allegati/);
	assert.match(message, /example\.test\/a\.png/);
});

await check("terminalStatusForFeedbackId: a BUG- id closes to 'resolved' (bug-dash's own terminal column), a SUG- id closes to 'processed' (suggest-dash's own terminal column) — regression guard for the worktree_finalize fix that used to write 'processed' for bugs, a status bug-dash has no column for", () => {
	assert.equal(terminalStatusForFeedbackId("BUG-abc123"), "resolved");
	assert.equal(terminalStatusForFeedbackId("SUG-abc123"), "processed");
});

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\nsmoke-test-feedback-queue-wake: ${passed} passed`);
