#!/usr/bin/env node

import assert from "node:assert/strict";
import { buildPlannerActionGuardPrompt, findUnexecutedActionClaim } from "./planner-action-guard.mjs";

const exactIncidentBranch = [
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Ho verificato il codice." }],
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Codice confermato: con --print-only nessun branch installa/avvia nulla (solo infer + contratto). Ora lancio il test read-only contro i 4 progetti reali." }],
		},
	},
];

const claim = findUnexecutedActionClaim(exactIncidentBranch);
assert.ok(claim, "the exact incident must be identified as an action claim without a tool call");
assert.match(claim.claim, /Ora lancio/i);
assert.equal(typeof claim.fingerprint, "string");
assert.match(buildPlannerActionGuardPrompt(claim.claim), /non contiene una tool call/i);

const executed = findUnexecutedActionClaim([
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Ora lancio il test read-only." },
				{ type: "toolCall", id: "test-1", name: "bash", arguments: { command: "node test.mjs" } },
			],
		},
	},
]);
assert.equal(executed, null, "a real tool call must satisfy the claim");

const confirmation = findUnexecutedActionClaim([
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Il piano è pronto. Confermi? Dopo la conferma lancerò il test." }],
		},
	},
]);
assert.equal(confirmation, null, "a future action guarded by an explicit confirmation question is not a missed execution");

const unrelated = findUnexecutedActionClaim([
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Il risultato del test è disponibile." }],
		},
	},
]);
assert.equal(unrelated, null);

console.log("smoke-test-planner-action-guard: ok (unexecuted action claim is detected and re-promptable)");

assert.ok(findUnexecutedActionClaim([{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Ticket 3 chiuso — ora il reviewer per il ticket finale." }] } }]), "membox: nominal action claims must wake the planner");

assert.ok(findUnexecutedActionClaim([
 { type: 'message', message: {role:'toolResult',toolName:'tickets_ready',details:{ready:['ticket-4']}} },
 { type: 'message', message: {role:'assistant',content:[{type:'text',text:'Il ticket precedente è completato.'}]}}
]), 'ready work without dispatch cannot silently finish the planner');
