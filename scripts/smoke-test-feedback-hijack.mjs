#!/usr/bin/env node

// Anti-hijack 2026-09-17 (ticket feedback-hijack-fix, incidente newMioDOC:
// 5 bug FIFO iniettati con triggerTurn in mezzo al filo HACCP; un
// "confermo, procedi" secco agganciato all'ultima proposta invece che
// all'HACCP; ripresa del triage dopo ordine di ignorarli). Verifiche:
//  1. parcheggio a conferma in sospeso (shouldParkFeedbackWake),
//  2. peek senza claim (la coda non avanza al surfacing),
//  3. claim differito solo al via esplicito,
//  4. wake non imperativo ("Risolvilo ora prima di restare inattivo" sparito),
//  5. disambiguazione conferme secche / risposte multiple / via riferito.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-hijack-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";
const {
	openDatabase, createFeedback, claimNextQueuedFeedback, peekNextQueuedFeedback,
	shouldParkFeedbackWake, looksLikeConfirmationRequest, looksLikeQueueIgnoreOrder,
	looksLikeExplicitQueueGo, buildQueuedFeedbackWakeMessage,
} = await import("./yano-feedback.mjs");

console.log("Anti-hijack: parcheggio silenzioso, claim differito, wake non imperativo, disambiguazione");
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok — ${name}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const db = openDatabase();

await check("parcheggio: conferma in sospeso o ordine ignora-coda parcheggia, altrimenti no", () => {
	assert.equal(shouldParkFeedbackWake({}), false);
	assert.equal(shouldParkFeedbackWake({ confirmationPending: true }), true);
	assert.equal(shouldParkFeedbackWake({ queueIgnored: true }), true);
	assert.equal(shouldParkFeedbackWake({ confirmationPending: true, queueIgnored: true }), true);
});

await check("richiesta conferma rilevata; testo neutro no", () => {
	assert.equal(looksLikeConfirmationRequest("Confermi il roster prima del lancio?"), true);
	assert.equal(looksLikeConfirmationRequest("Attendo la tua conferma per procedere."), true);
	assert.equal(looksLikeConfirmationRequest("Ho eseguito i test, tutto verde."), false);
	assert.equal(looksLikeConfirmationRequest(""), false);
});

await check("ordine ignora-coda rilevato; testo neutro no", () => {
	assert.equal(looksLikeQueueIgnoreOrder("Ignora la coda dei bug per ora"), true);
	assert.equal(looksLikeQueueIgnoreOrder("Parcheggia i feedback, continuiamo l'HACCP"), true);
	assert.equal(looksLikeQueueIgnoreOrder("Continua pure con il task"), false);
});

await check("via esplicito: ID record o verbo+ambito; confermo secco mai", () => {
	assert.equal(looksLikeExplicitQueueGo("confermo, procedi su BUG-abc123"), true);
	assert.equal(looksLikeExplicitQueueGo("procedi con tutti i bug"), true);
	assert.equal(looksLikeExplicitQueueGo("confermo 1 e 3"), true);
	assert.equal(looksLikeExplicitQueueGo("confermo, procedi"), false);
	assert.equal(looksLikeExplicitQueueGo("ok"), false);
	assert.equal(looksLikeExplicitQueueGo("procedi"), false);
});

await check("peek non avanza la coda; claim differito solo al via esplicito", async () => {
	const project = "workspace-hijack-peek";
	const bug = await createFeedback(db, { type: "bug", project_id: project, message: "Bug HACCP", resolution: "automatic", test_username: "u", test_password: "p" });
	const peeked = peekNextQueuedFeedback(db, project);
	assert.ok(peeked, "il peek deve vedere la voce");
	assert.equal(peeked.item.id, bug.id);
	assert.ok(["received", "pending_planner", "queued"].includes(peeked.item.status), "il peek non deve cambiare stato");
	assert.equal(looksLikeExplicitQueueGo("confermo, procedi"), false, "confermo secco: niente claim");
	const claimed = claimNextQueuedFeedback(db, project);
	assert.equal(claimed.claimed.id, bug.id, "solo il via esplicito (claim) avanza la coda");
	assert.equal(claimed.claimed.status, "processing");
});

await check("ordine FIFO preservato anche nel peek con più voci", async () => {
	const project = "workspace-hijack-fifo";
	const first = await createFeedback(db, { type: "bug", project_id: project, message: "Primo", resolution: "automatic", test_username: "u", test_password: "p" });
	await sleep(2);
	await createFeedback(db, { type: "bug", project_id: project, message: "Secondo", resolution: "automatic", test_username: "u", test_password: "p" });
	assert.equal(peekNextQueuedFeedback(db, project).item.id, first.id, "il peek vede la testa FIFO senza consumarla");
	assert.equal(peekNextQueuedFeedback(db, project).item.id, first.id, "il peek resta idempotente");
	assert.equal(claimNextQueuedFeedback(db, project).claimed.id, first.id, "il claim consuma la testa FIFO");
});

await check("wake non imperativo: niente 'Risolvilo ora prima di restare inattivo'", () => {
	const bugMessage = buildQueuedFeedbackWakeMessage({ id: "BUG-x", message: "Il salvataggio fallisce" }, "bug");
	const sugMessage = buildQueuedFeedbackWakeMessage({ id: "SUG-x", message: "Dark mode" }, "suggestion");
	assert.doesNotMatch(bugMessage, /Risolvilo ora prima di restare inattivo/);
	assert.doesNotMatch(sugMessage, /Valutala ora prima di restare inattivo/);
	assert.match(bugMessage, /via esplicito riferito/);
	assert.match(bugMessage, /Classifica prima l'impatto/);
	assert.match(sugMessage, /conferma esplicita dell'utente/);
});

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\nsmoke-test-feedback-hijack: ${passed} passed`);
