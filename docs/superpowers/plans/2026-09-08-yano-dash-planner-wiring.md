# Yano Dash → planner reale: assegnazione e domande Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spostare una card in dashboard su "processing" assegna davvero il task a un planner online e lo fa partire; se il planner ha una domanda aperta collegata, la card lo mostra e permette di rispondere dalla dashboard (o rileva che è stata risposta altrove, es. Herdr).

**Architecture:** Due nuovi comandi MQTT punto-a-punto (`feedback_assigned`, `decision_hold_answer_requested`) instradati verso il topic dei comandi di un planner online già esistente; la dashboard fa da mittente, `extensions/orchestrator.ts` da destinatario che riusa la sua logica esistente (`buildQueuedFeedbackWakeMessage`, `answerDecisionHold`) senza duplicarla. Nessuna modifica di schema database.

**Tech Stack:** Node.js (`node:sqlite`, `mqtt`), TypeScript (Bun/tsx strip-types, invariato), Preact/htm (dash-ui).

## Global Constraints

- Nessuna dipendenza npm nuova (solo built-in Node + `mqtt`, già presente).
- Ogni funzione nuova con effetti collaterali reali va testata contro un broker MQTT locale reale (`mqtt://127.0.0.1:1883`, stessa convenzione di `scripts/e2e-full-flow.mjs` e dei test esistenti di `yano-feedback.mjs`), mai mockata.
- File con modifiche concorrenti già in corso (`extensions/orchestrator.ts`, `scripts/yano-feedback.mjs`, `scripts/yano-dash.mjs`, `scripts/dash-ui/*`, `scripts/e2e-full-flow.mjs`, `scripts/smoke-test-yano-dash.mjs`): ogni commit di questo piano deve isolare (via `git apply --cached` su un hunk-diff mirato, come già fatto nel fix precedente) solo le righe di QUESTO piano, mai le altre modifiche non correlate presenti nello stesso file.
- Nessuna riscrittura della logica di `answerDecisionHold`/`resolveDecisionHold` (fencing, idempotenza, outbox): sempre delegata a un'istanza planner online reale.
- Riferimento: `docs/superpowers/specs/2026-09-08-yano-dash-planner-wiring-design.md`.

---

### Task 1: `findOnlinePlanners` in `yano-feedback.mjs`

**Files:**
- Modify: `scripts/yano-feedback.mjs` (aggiunta pura, subito dopo `notifyPlanner`, riga 282)
- Test: `scripts/smoke-test-find-online-planners.mjs`

**Interfaces:**
- Produces: `export async function findOnlinePlanners(projectId: string): Promise<Array<{instance: string, role: string, status: string, [k: string]: unknown}>>` — presence-check MQTT di 250ms su `pi/<projectId>/agents/+/status`, ritorna le card `role==="planner"` con `status !== "offline"`. Non pubblica nulla, sola lettura.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
// findOnlinePlanners deve trovare solo le card realmente pubblicate come
// planner online sul topic di presence di QUESTO progetto — mai altri
// progetti, mai ruoli diversi da planner, mai card "offline".
import assert from "node:assert/strict";
import mqtt from "mqtt";

const BROKER = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const { findOnlinePlanners } = await import("./yano-feedback.mjs");

async function publishPresence(project, instance, role, status) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, JSON.stringify({ instance, role, status }), { qos: 1, retain: true });
	await client.endAsync();
}
async function clearPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, "", { qos: 1, retain: true });
	await client.endAsync();
}

console.log("=== nessun planner pubblicato: ritorna array vuoto ===");
{
	const result = await findOnlinePlanners("workspace-find-online-planners-empty");
	assert.deepEqual(result, []);
}
console.log("   OK");

console.log("=== un planner online viene trovato ===");
{
	await publishPresence("workspace-find-online-planners-one", "planner-01", "planner", "idle");
	try {
		const result = await findOnlinePlanners("workspace-find-online-planners-one");
		assert.equal(result.length, 1);
		assert.equal(result[0].instance, "planner-01");
	} finally { await clearPresence("workspace-find-online-planners-one", "planner-01"); }
}
console.log("   OK");

console.log("=== una card offline e una di un altro ruolo vengono escluse ===");
{
	await publishPresence("workspace-find-online-planners-filter", "planner-02", "planner", "offline");
	await publishPresence("workspace-find-online-planners-filter", "coder-01", "coder", "idle");
	try {
		const result = await findOnlinePlanners("workspace-find-online-planners-filter");
		assert.deepEqual(result, []);
	} finally {
		await clearPresence("workspace-find-online-planners-filter", "planner-02");
		await clearPresence("workspace-find-online-planners-filter", "coder-01");
	}
}
console.log("   OK");

console.log("\nsmoke-test-find-online-planners: 3 passed");
```

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-find-online-planners.mjs`
Expected: `TypeError: findOnlinePlanners is not a function` (o `is not exported`) — non esiste ancora.

- [ ] **Step 3: Implementa**

In `scripts/yano-feedback.mjs`, subito dopo la chiusura di `notifyPlanner` (dopo la riga `}` che chiude `async function notifyPlanner(item) { ... }`, riga 282), aggiungi:

```js
// Sola lettura: presence-check di 250ms identica a quella già usata da
// notifyPlanner, ma esposta come funzione autonoma così può essere riusata
// sia dall'assegnazione manuale (Task 2) sia dalla risposta a una domanda del
// planner (Task 7) senza toccare notifyPlanner, il cui comportamento esistente
// (incluso il fatto che si connette comunque anche quando
// YANO_FEEDBACK_SKIP_NOTIFY=1 salta solo l'invio) resta invariato per non
// rischiare regressioni sui test già esistenti.
export async function findOnlinePlanners(projectId) {
	const client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3_000 });
	try {
		const statuses = [];
		const onMessage = (_topic, payload) => { try { const card = JSON.parse(payload.toString()); if (card.role === "planner" && card.status !== "offline") statuses.push(card); } catch {} };
		client.on("message", onMessage);
		await client.subscribeAsync(`pi/${projectId}/agents/+/status`, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 250));
		return statuses;
	} finally { await client.endAsync(); }
}
```

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-find-online-planners.mjs`
Expected: `smoke-test-find-online-planners: 3 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-feedback.mjs scripts/smoke-test-find-online-planners.mjs
git commit -m "feat(feedback): add findOnlinePlanners presence-check helper"
```

Nota: `scripts/yano-feedback.mjs` ha modifiche concorrenti non correlate. Prima del commit, isola SOLO l'aggiunta di questo task con `git diff scripts/yano-feedback.mjs`, individua l'hunk esatto aggiunto in questo step, e stagealo con `git apply --cached` su un patch-file contenente solo quell'hunk (stesso procedimento già usato per il fix screenshot/status di questa sessione) invece di `git add` diretto sull'intero file.

---

### Task 2: `assignFeedbackToPlanner` in `yano-feedback.mjs`

**Files:**
- Modify: `scripts/yano-feedback.mjs`
- Test: `scripts/smoke-test-assign-feedback-to-planner.mjs`

**Interfaces:**
- Consumes: `findOnlinePlanners` (Task 1), `updateFeedback`, `buildQueuedFeedbackWakeMessage`, `row` (già esistenti nel file).
- Produces: `export async function assignFeedbackToPlanner(db, feedbackId, input): Promise<FeedbackRecord | null>` — throws `Error("nessun planner online per il progetto \"<id>\"")` se nessun planner è online; altrimenti delega interamente la scrittura a `updateFeedback` (stesso comportamento di validazione/audit/requeue-su-contenuto-cambiato) e, solo se il risultato è realmente `status === "processing"`, pubblica `feedback_assigned` sul topic comandi del primo planner trovato.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
// assignFeedbackToPlanner: blocca l'assegnazione se nessun planner è online
// (item invariato, nessun audit "status_changed" aggiunto); se un planner è
// online, delega a updateFeedback (stesso comportamento esistente, incluso il
// requeue automatico su una modifica di contenuto reale) e pubblica un
// comando mirato SOLO quando il risultato è davvero "processing".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mqtt from "mqtt";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-assign-feedback-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";
const BROKER = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";

const { openDatabase, createFeedback, assignFeedbackToPlanner, getFeedback, listFeedbackAudit } = await import("./yano-feedback.mjs");
const db = openDatabase();

async function publishPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, JSON.stringify({ instance, role: "planner", status: "idle" }), { qos: 1, retain: true });
	await client.endAsync();
}
async function clearPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, "", { qos: 1, retain: true });
	await client.endAsync();
}

console.log("=== nessun planner online: errore, item invariato ===");
{
	const project = "workspace-assign-no-planner";
	const created = await createFeedback(db, { type: "bug", project_id: project, message: "il pulsante non risponde", require_credentials: false });
	await assert.rejects(
		() => assignFeedbackToPlanner(db, created.id, { status: "processing", audit_reason: "presa in carico manuale" }),
		/nessun planner online/,
	);
	const after = getFeedback(db, created.id);
	assert.equal(after.status, created.status, "lo stato non deve cambiare se nessun planner è online");
	assert.equal(listFeedbackAudit(db, created.id).length, 0, "nessuna voce di audit deve essere aggiunta su un tentativo bloccato");
}
console.log("   OK");

console.log("=== planner online: claim eseguito e comando mirato pubblicato ===");
{
	const project = "workspace-assign-with-planner";
	const created = await createFeedback(db, { type: "bug", project_id: project, message: "crash al salvataggio", require_credentials: false });
	await publishPresence(project, "planner-01");
	try {
		const received = [];
		const listener = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
		listener.on("message", (_topic, payload) => { try { received.push(JSON.parse(payload.toString())); } catch {} });
		await listener.subscribeAsync(`pi/${project}/agents/planner-01/commands`, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 200));

		const updated = await assignFeedbackToPlanner(db, created.id, { status: "processing", audit_reason: "presa in carico manuale" });
		assert.equal(updated.status, "processing");

		await new Promise((resolve) => setTimeout(resolve, 300));
		await listener.endAsync();
		assert.equal(received.length, 1, "deve arrivare esattamente un comando mirato");
		assert.equal(received[0].type, "feedback_assigned");
		assert.equal(received[0].feedback_id, created.id);
		assert.equal(received[0].project_id, project);
		assert.match(received[0].message, new RegExp(created.id));
	} finally { await clearPresence(project, "planner-01"); }
}
console.log("   OK");

console.log("=== planner online ma la richiesta modifica anche il testo: il requeue esistente vince, nessun comando pubblicato ===");
{
	const project = "workspace-assign-content-changed";
	const created = await createFeedback(db, { type: "bug", project_id: project, message: "messaggio originale", require_credentials: false });
	await publishPresence(project, "planner-02");
	try {
		const received = [];
		const listener = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
		listener.on("message", (_topic, payload) => { try { received.push(JSON.parse(payload.toString())); } catch {} });
		await listener.subscribeAsync(`pi/${project}/agents/planner-02/commands`, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 200));

		const updated = await assignFeedbackToPlanner(db, created.id, { status: "processing", message: "messaggio modificato davvero", audit_reason: "modifico e provo ad assegnare insieme" });
		assert.equal(updated.status, "queued", "una modifica di contenuto reale forza ancora il rientro in coda, come da regola esistente");

		await new Promise((resolve) => setTimeout(resolve, 300));
		await listener.endAsync();
		assert.equal(received.length, 0, "nessun comando va pubblicato se il risultato non è davvero processing");
	} finally { await clearPresence(project, "planner-02"); }
}
console.log("   OK");

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("\nsmoke-test-assign-feedback-to-planner: 3 passed");
```

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-assign-feedback-to-planner.mjs`
Expected: `TypeError: assignFeedbackToPlanner is not a function`

- [ ] **Step 3: Implementa**

Subito dopo `findOnlinePlanners` (Task 1), aggiungi in `scripts/yano-feedback.mjs`:

```js
export async function assignFeedbackToPlanner(db, feedbackId, input) {
	const current = row(db, feedbackId);
	if (!current) return null;
	const planners = await findOnlinePlanners(current.project_id);
	if (!planners.length) throw new Error(`nessun planner online per il progetto "${current.project_id}"`);
	const updated = await updateFeedback(db, feedbackId, input);
	if (updated?.status === "processing") {
		const target = planners[0];
		const client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3_000 });
		try {
			await client.publishAsync(`pi/${current.project_id}/agents/${target.instance}/commands`, JSON.stringify({
				type: "feedback_assigned", feedback_type: updated.type, feedback_id: updated.id, project_id: updated.project_id,
				message: buildQueuedFeedbackWakeMessage(updated, updated.type), resolution: updated.resolution,
				screenshots: updated.screenshots || [], requires_user_confirmation: updated.type === "suggestion" || updated.resolution === "user_confirmation",
			}));
		} finally { await client.endAsync(); }
	}
	return updated;
}
```

Poi, nella stessa funzione `buildQueuedFeedbackWakeMessage` (riga 119-123), aggiungi la riga di istruzione finale in ENTRAMBI i return (bug e suggestion). Testo esatto da appendere (con un `\n\n` di separazione) ad ogni stringa restituita:

```
Se in qualunque momento durante questo task ti serve una decisione dell'utente, chiama decision_hold_create passando context={"feedback_id":"${claimed.id}"} — così la domanda compare automaticamente sulla card in dashboard.
```

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-assign-feedback-to-planner.mjs`
Expected: `smoke-test-assign-feedback-to-planner: 3 passed`

Poi verifica che il testo aggiunto a `buildQueuedFeedbackWakeMessage` non rompa `scripts/smoke-test-feedback-queue-wake.mjs` (usa `assert.match`, non uguaglianza esatta, quindi deve continuare a passare):

Run: `node scripts/smoke-test-feedback-queue-wake.mjs`
Expected: `smoke-test-feedback-queue-wake: 8 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-feedback.mjs scripts/smoke-test-assign-feedback-to-planner.mjs
git commit -m "feat(feedback): add assignFeedbackToPlanner (blocks when no planner online)"
```

Stesso avvertimento del Task 1 sull'isolamento dell'hunk in `yano-feedback.mjs`.

---

### Task 3: Wiring nel dispatch PATCH/PUT di `handleFeedbackApi`

**Files:**
- Modify: `scripts/yano-feedback.mjs` (riga 334)
- Test: `scripts/smoke-test-feedback-status-processing-assignment.mjs`

**Interfaces:**
- Consumes: `assignFeedbackToPlanner` (Task 2), `handleFeedbackApi`.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
// La transizione "processing" via PATCH/PUT deve passare da
// assignFeedbackToPlanner (bloccando se nessun planner è online) SOLO
// quando lo stato attuale è ancora in coda; ogni altra transizione resta
// puro updateFeedback come oggi (nessuna regressione sul fix screenshot/status
// già rilasciato).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import mqtt from "mqtt";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-feedback-dispatch-"));
process.env.YANO_DATA_DIR = dataDir;
process.env.YANO_FEEDBACK_SKIP_NOTIFY = "1";
const BROKER = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";

const { openDatabase, handleFeedbackApi, createFeedback } = await import("./yano-feedback.mjs");
const db = openDatabase();
const server = http.createServer((req, res) => handleFeedbackApi(db, req, res, { requireCredentials: false }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
async function api(path, options) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
	return { status: response.status, body: await response.json() };
}
async function publishPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, JSON.stringify({ instance, role: "planner", status: "idle" }), { qos: 1, retain: true });
	await client.endAsync();
}
async function clearPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, "", { qos: 1, retain: true });
	await client.endAsync();
}

console.log("=== PUT verso processing senza planner online: 400, item invariato ===");
{
	const project = "workspace-dispatch-no-planner";
	const created = await createFeedback(db, { type: "bug", project_id: project, message: "bottone rotto", require_credentials: false });
	const { status, body } = await api(`/${project}/bugs/${created.id}`, {
		method: "PUT", headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: created.message, status: "processing", audit_reason: "presa in carico" }),
	});
	assert.equal(status, 400);
	assert.match(body.error, /nessun planner online/);
	const { body: fetched } = await api(`/${project}/bugs/${created.id}`);
	assert.equal(fetched.status, created.status);
}
console.log("   OK");

console.log("=== PUT verso processing con planner online: 200, davvero preso in carico ===");
{
	const project = "workspace-dispatch-with-planner";
	const created = await createFeedback(db, { type: "bug", project_id: project, message: "crash", require_credentials: false });
	await publishPresence(project, "planner-03");
	try {
		const { status, body } = await api(`/${project}/bugs/${created.id}`, {
			method: "PUT", headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: created.message, status: "processing", audit_reason: "presa in carico" }),
		});
		assert.equal(status, 200);
		assert.equal(body.status, "processing");
	} finally { await clearPresence(project, "planner-03"); }
}
console.log("   OK");

console.log("=== PUT verso 'cancelled' (transizione non di assegnazione): invariato, nessuna presence-check richiesta ===");
{
	const project = "workspace-dispatch-cancel";
	const created = await createFeedback(db, { type: "bug", project_id: project, message: "non serve più", require_credentials: false });
	const { status, body } = await api(`/${project}/bugs/${created.id}`, {
		method: "PUT", headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: created.message, status: "cancelled", audit_reason: "non serve più" }),
	});
	assert.equal(status, 200, "cancellare non deve mai richiedere un planner online");
	assert.equal(body.status, "cancelled");
}
console.log("   OK");

server.close();
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("\nsmoke-test-feedback-status-processing-assignment: 3 passed");
```

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-feedback-status-processing-assignment.mjs`
Expected: il primo check fallisce con status 200 invece di 400 (oggi il PUT scrive sempre, senza controllare planner online).

- [ ] **Step 3: Implementa**

In `scripts/yano-feedback.mjs`, sostituisci la riga 334:

```js
if (itemId && (method === "PATCH" || method === "PUT")) { const updated = await updateFeedback(db,itemId,{...(await readRequest(req)),updated_by:req.headers["x-yano-user"] || undefined}); return json(res,updated?200:404,updated||{error:"not found"}); }
```

con:

```js
if (itemId && (method === "PATCH" || method === "PUT")) { const body={...(await readRequest(req)),updated_by:req.headers["x-yano-user"] || undefined}; const current=row(db,itemId); const isAssignment = current && body.status === "processing" && ["received","pending_planner","queued"].includes(current.status); const updated = await (isAssignment ? assignFeedbackToPlanner(db,itemId,body) : updateFeedback(db,itemId,body)); return json(res,updated?200:404,updated||{error:"not found"}); }
```

(L'errore di `assignFeedbackToPlanner` propaga naturalmente al `catch` esistente di `handleFeedbackApi`, riga 338, che già risponde `400 {error: error.message}` per qualunque eccezione — nessuna modifica necessaria lì.)

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-feedback-status-processing-assignment.mjs`
Expected: `smoke-test-feedback-status-processing-assignment: 3 passed`

Poi esegui anche `node scripts/smoke-test-feedback-screenshot-status-update.mjs` per confermare zero regressioni sul fix precedente.

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-feedback.mjs scripts/smoke-test-feedback-status-processing-assignment.mjs
git commit -m "feat(feedback): route processing-transition PATCH/PUT through assignFeedbackToPlanner"
```

---

### Task 4: `handleFeedbackAssigned` in `extensions/orchestrator.ts`

**Files:**
- Modify: `extensions/orchestrator.ts` (riga 3108 area, riga 3665 dispatcher)
- Test: `scripts/smoke-test-check-syntax-orchestrator.mjs` (se non già coperto da `scripts/check-syntax.mjs` — verifica prima)

**Interfaces:**
- Consumes: `pi.sendMessage`, `identity`, `logEvent` (già esistenti nel file).
- Produces: nuovo ramo nel dispatcher MQTT per `env.type === "feedback_assigned"`.

- [ ] **Step 1: Verifica il gate di sintassi esistente**

Run: `node scripts/check-syntax.mjs` (o il comando equivalente — verifica in `package.json`/`scripts/test-all.mjs` quale sia il nome esatto) sullo stato ATTUALE del file, per avere una baseline "passa" prima di modificare.
Expected: nessun errore.

- [ ] **Step 2: Implementa**

Subito dopo la chiusura di `handleFeedbackReceived` (riga 3112, dopo il suo `}`), aggiungi:

```ts
	// Consegna mirata generata da yano-dash quando una card viene assegnata
	// manualmente (drag/drawer → "processing"): a differenza di
	// handleFeedbackReceived, qui l'item è GIÀ stato preso in carico da
	// assignFeedbackToPlanner (yano-feedback.mjs) — non si passa da
	// claimNextQueuedFeedback, altrimenti si rischierebbe di consegnare un
	// item diverso da quello che l'utente ha effettivamente trascinato.
	function handleFeedbackAssigned(payload: any): void {
		if (!identity || identity.role !== "planner" || payload?.project_id !== identity.project) return;
		const imageBlocks = (payload.screenshots || []).flatMap((shot: any) => {
			const source = shot?.preview_url || shot?.data || "";
			const match = String(source).match(/^data:([^;,]+)?;base64,(.+)$/s);
			return match ? [{ type: "image", data: match[2], mimeType: shot.mime_type || match[1] || "image/png" }] : [];
		});
		const content: any = [{ type: "text", text: payload.message }, ...imageBlocks];
		pi.sendMessage({ customType: "feedback-inbound", content, display: true, details: { feedback_id: payload.feedback_id, reason: "feedback_assigned", feedback_type: payload.feedback_type } } as any, { deliverAs: "followUp", triggerTurn: true });
		logEvent("feedback_assigned_delivered", { feedback_id: payload.feedback_id, feedback_type: payload.feedback_type });
	}
```

Poi, riga 3665, sostituisci:

```ts
					if (env.type === "feedback_received") handleFeedbackReceived(env);
```

con:

```ts
					if (env.type === "feedback_received") handleFeedbackReceived(env);
					else if (env.type === "feedback_assigned") handleFeedbackAssigned(env);
```

(mantenendo tutti gli `else if` successivi, riga 3667-3670, invariati e nell'ordine esistente.)

- [ ] **Step 3: Verifica sintassi**

Run: `node scripts/check-syntax.mjs` (stesso comando dello Step 1)
Expected: nessun errore — il file deve continuare a fare il parse/type-check pulito con `--experimental-strip-types`.

- [ ] **Step 4: Verifica manuale con un planner reale**

Non esiste un harness di unit test leggero per `extensions/orchestrator.ts` (l'unico harness esistente, `scripts/e2e-full-flow.mjs`, è un file monolitico di ~4000 righe con modifiche concorrenti in corso — costruirne una copia ridotta qui sarebbe sproporzionato rispetto al rischio: questo handler è ~10 righe che rispecchiano quasi esattamente `handleFeedbackReceived`, già testato). Verifica quindi dal vivo, con processi reali:

```bash
yano dash start --no-open
yano start --instance planner-verify --role planner
```

Poi, da un'altra sessione, sposta una card "received" su "processing" dalla dashboard (drag o drawer), e conferma che il messaggio compaia nella conversazione della tab `planner-verify` entro pochi secondi, con il testo esatto della card. Registra l'esito (screenshot o trascrizione) prima di procedere al commit.

- [ ] **Step 5: Commit**

```bash
git add extensions/orchestrator.ts
git commit -m "feat(orchestrator): deliver targeted feedback_assigned wake to online planner"
```

Isola l'hunk come nei task precedenti — `extensions/orchestrator.ts` ha modifiche concorrenti in corso.

---

### Task 5: `scripts/yano-orchestrator-holds.mjs` — lettura hold aperti

**Files:**
- Create: `scripts/yano-orchestrator-holds.mjs`
- Test: `scripts/smoke-test-yano-orchestrator-holds.mjs`

**Interfaces:**
- Consumes: `projectDbPath` da `./yano-project.mjs` (già esistente).
- Produces: `export function findOpenHoldsIndexedByFeedbackId(projectRoot: string, explicitProject?: string): Record<string, {id, run_id, generation, question, owner, created_at}>` — mai eccezione, `{}` se il DB non esiste.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-holds-project-"));
const { findOpenHoldsIndexedByFeedbackId } = await import("./yano-orchestrator-holds.mjs");

console.log("=== nessun DB orchestratore: {} senza eccezioni ===");
{
	const result = findOpenHoldsIndexedByFeedbackId(projectRoot, "demo-project");
	assert.deepEqual(result, {});
}
console.log("   OK");

console.log("=== hold aperto con context.feedback_id: trovato ===");
{
	const dbDir = path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage");
	fs.mkdirSync(dbDir, { recursive: true });
	const db = new DatabaseSync(path.join(dbDir, "orchestrator.db"));
	db.exec(`CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, generation INTEGER, question TEXT, context TEXT, owner TEXT, status TEXT, answer TEXT, resolution_metadata TEXT, created_at TEXT, expires_at TEXT, updated_at TEXT)`);
	db.prepare("INSERT INTO decision_holds (id,run_id,generation,question,context,owner,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
		.run("hold-1", "run-1", 0, "Confermi di eliminare il vecchio endpoint?", JSON.stringify({ feedback_id: "BUG-target" }), "planner-01", "open", "2026-09-08T10:00:00.000Z", "2026-09-08T10:00:00.000Z");
	db.prepare("INSERT INTO decision_holds (id,run_id,generation,question,context,owner,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
		.run("hold-2", "run-1", 0, "Domanda su un altro task", JSON.stringify({ feedback_id: "BUG-other" }), "planner-01", "open", "2026-09-08T10:00:00.000Z", "2026-09-08T10:00:00.000Z");
	db.prepare("INSERT INTO decision_holds (id,run_id,generation,question,context,owner,status,answer,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
		.run("hold-3", "run-1", 0, "Già risposta", JSON.stringify({ feedback_id: "BUG-answered" }), "planner-01", "answered", "sì", "2026-09-08T10:00:00.000Z", "2026-09-08T10:00:00.000Z");
	db.close();

	const result = findOpenHoldsIndexedByFeedbackId(projectRoot, "demo-project");
	assert.equal(Object.keys(result).length, 2, "solo i due hold 'open' devono comparire, non quello 'answered'");
	assert.equal(result["BUG-target"].question, "Confermi di eliminare il vecchio endpoint?");
	assert.equal(result["BUG-target"].owner, "planner-01");
	assert.equal(result["BUG-target"].generation, 0);
	assert.equal(result["BUG-other"].question, "Domanda su un altro task");
	assert.equal(result["BUG-answered"], undefined);
}
console.log("   OK");

fs.rmSync(projectRoot, { recursive: true, force: true });
console.log("\nsmoke-test-yano-orchestrator-holds: 2 passed");
```

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-yano-orchestrator-holds.mjs`
Expected: `Cannot find module './yano-orchestrator-holds.mjs'`

- [ ] **Step 3: Implementa**

```js
#!/usr/bin/env node
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath } from "./yano-project.mjs";

// Sola lettura: nessuna scrittura viene mai fatta qui sul database
// dell'orchestratore (vedi Task 7 per la risposta, che passa sempre da un
// planner online reale, mai da questo modulo).
export function findOpenHoldsIndexedByFeedbackId(projectRoot, explicitProject) {
	const dbFile = projectDbPath(projectRoot, explicitProject);
	if (!fs.existsSync(dbFile)) return {};
	const db = new DatabaseSync(dbFile, { readOnly: true });
	try {
		const rows = db.prepare("SELECT id,run_id,ticket_id,generation,question,context,owner,created_at FROM decision_holds WHERE status='open'").all();
		const byFeedbackId = {};
		for (const row of rows) {
			let context;
			try { context = JSON.parse(row.context || "{}"); } catch { continue; }
			if (context?.feedback_id) byFeedbackId[context.feedback_id] = { id: row.id, run_id: row.run_id, generation: row.generation, question: row.question, owner: row.owner, created_at: row.created_at };
		}
		return byFeedbackId;
	} finally { db.close(); }
}
```

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-yano-orchestrator-holds.mjs`
Expected: `smoke-test-yano-orchestrator-holds: 2 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-orchestrator-holds.mjs scripts/smoke-test-yano-orchestrator-holds.mjs
git commit -m "feat(orchestrator-holds): add read-only open-hold lookup by feedback_id"
```

(File nuovo, nessun hunk da isolare.)

---

### Task 6: `open_question` in `yano-dash.mjs`

**Files:**
- Modify: `scripts/yano-dash.mjs`
- Test: `scripts/smoke-test-yano-dash-open-question.mjs`

**Interfaces:**
- Consumes: `findOpenHoldsIndexedByFeedbackId` (Task 5).
- Produces: ogni item con `status === "processing"` restituito da `GET /<project>/bugs[/id]` e `/<project>/suggestions[/id]` guadagna il campo `open_question: {...} | null`.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
// GET su un item "processing" con un hold aperto collegato deve esporre
// open_question; un item senza hold, o non "processing", deve esporre null.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-openq-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-openq-project-"));
const env = { ...process.env, YANO_DATA_DIR: dataDir, YANO_FEEDBACK_SKIP_NOTIFY: "1" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

function seedWatcherRegistry() {
	const { DatabaseSync: WatcherDb } = require("node:sqlite");
	const watcherDir = path.join(dataDir, "watcher");
	fs.mkdirSync(watcherDir, { recursive: true });
	const db = new WatcherDb(path.join(watcherDir, "watcher-registry.sqlite"));
	db.exec(`CREATE TABLE watcher_projects (project_key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, workspace_id TEXT, worker_tab_id TEXT, worker_pane_id TEXT, worker_instance TEXT, worker_status TEXT NOT NULL DEFAULT 'stopped', interval_ms INTEGER NOT NULL DEFAULT 60000, lookback_ms INTEGER NOT NULL DEFAULT 3600000, last_recovery_at TEXT, last_recovery_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	const now = new Date().toISOString();
	db.prepare("INSERT INTO watcher_projects(project_key,name,root,worker_status,interval_ms,lookback_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
		.run("watcher-openq", "openq-demo", projectRoot, "running", 60000, 3600000, now, now);
	db.close();
}

function seedOpenHold(feedbackId) {
	const dbDir = path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage");
	fs.mkdirSync(dbDir, { recursive: true });
	const db = new DatabaseSync(path.join(dbDir, "orchestrator.db"));
	db.exec(`CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, generation INTEGER, question TEXT, context TEXT, owner TEXT, status TEXT, answer TEXT, resolution_metadata TEXT, created_at TEXT, expires_at TEXT, updated_at TEXT)`);
	db.prepare("INSERT INTO decision_holds (id,run_id,generation,question,context,owner,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
		.run("hold-openq", "run-openq", 0, "Uso REST o GraphQL per questo endpoint?", JSON.stringify({ feedback_id: feedbackId }), "planner-01", "open", new Date().toISOString(), new Date().toISOString());
	db.close();
}

function dashStatePath() { return path.join(dataDir, "dashboards", "dash.json"); }
async function startDash() {
	const child = spawn("node", [path.join(root, "bin", "yano.mjs"), "dash", "start", "--no-open", "--port", "0", "--project-id", "openq-demo"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(dashStatePath())) { try { const state = JSON.parse(fs.readFileSync(dashStatePath(), "utf8")); if (state.port && state.pid) return { child, port: state.port }; } catch {} }
		await sleep(50);
	}
	throw new Error("yano dash non ha scritto lo state file in tempo");
}
async function fetchJson(url, options) { const response = await fetch(url, options); return { status: response.status, body: await response.json() }; }

let dash = null;
try {
	seedWatcherRegistry();
	dash = await startDash();

	console.log("=== item 'received' (non processing): open_question sempre null ===");
	{
		const { body: created } = await fetchJson(`http://127.0.0.1:${dash.port}/openq-demo/bugs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "bottone rotto" }) });
		seedOpenHold(created.id);
		const { body: fetched } = await fetchJson(`http://127.0.0.1:${dash.port}/openq-demo/bugs/${created.id}`);
		assert.equal(fetched.open_question, null, "un hold aperto non deve comparire finché l'item non è 'processing'");
	}
	console.log("   OK");

	console.log("=== item 'processing' con hold aperto collegato: open_question esposto ===");
	{
		const { body: created } = await fetchJson(`http://127.0.0.1:${dash.port}/openq-demo/bugs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "crash al salvataggio" }) });
		seedOpenHold(created.id);
		// Forza lo stato a processing direttamente sul DB feedback, per isolare
		// questo test da assignFeedbackToPlanner (già testato nel Task 2/3) —
		// qui interessa solo la lettura/decorazione GET.
		const feedbackDbPath = path.join(dataDir, "feedback", "feedback.sqlite");
		const fdb = new DatabaseSync(feedbackDbPath);
		fdb.prepare("UPDATE feedback SET status='processing' WHERE id=?").run(created.id);
		fdb.close();

		const { body: fetched } = await fetchJson(`http://127.0.0.1:${dash.port}/openq-demo/bugs/${created.id}`);
		assert.ok(fetched.open_question, "open_question deve essere presente per un item processing con hold aperto");
		assert.equal(fetched.open_question.question, "Uso REST o GraphQL per questo endpoint?");
		assert.equal(fetched.open_question.owner, "planner-01");

		const { body: list } = await fetchJson(`http://127.0.0.1:${dash.port}/openq-demo/bugs`);
		const inList = list.find((item) => item.id === created.id);
		assert.ok(inList.open_question, "la lista deve esporre open_question esattamente come il singolo item");
	}
	console.log("   OK");

	console.log("\nsmoke-test-yano-dash-open-question: 2 passed");
} finally {
	if (dash?.child && dash.child.exitCode === null) { try { dash.child.kill("SIGKILL"); } catch {} }
	try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
	try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
```

(`feedbackDbPath` sopra è corretto e verificato: `dbPath()` in `yano-feedback.mjs` risolve a `path.join(traceRoot(), "feedback", "feedback.sqlite")`, e `traceRoot()` rispetta `YANO_DATA_DIR` — stesso meccanismo già usato con successo da `scripts/smoke-test-feedback-screenshot-status-update.mjs`.)

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-yano-dash-open-question.mjs`
Expected: `assert.ok(fetched.open_question, ...)` fallisce — oggi `open_question` non esiste nella risposta.

- [ ] **Step 3: Implementa**

In `scripts/yano-dash.mjs`:

1. Aggiungi l'import (riga 13-18 area):
```js
import { findOpenHoldsIndexedByFeedbackId } from "./yano-orchestrator-holds.mjs";
```

2. Sostituisci `decorateFeedback` (righe 87-93):
```js
function decorateFeedback(item, project, { catalog = projectCatalog(), activities = new Map() } = {}) {
	if (!item) return item;
	const root = catalog.find((candidate) => candidate.id === project)?.root;
	if (!root) return { ...item, execution: { state: "unknown", evidence: "project_root_unavailable" } };
	if (!activities.has(root)) activities.set(root, projectActivity(root));
	return { ...item, execution: executionForFeedback(item, activities.get(root)) };
}
```
con:
```js
function decorateFeedback(item, project, { catalog = projectCatalog(), activities = new Map(), holds = new Map() } = {}) {
	if (!item) return item;
	const entry = catalog.find((candidate) => candidate.id === project);
	const root = entry?.root;
	if (!root) return { ...item, execution: { state: "unknown", evidence: "project_root_unavailable" }, open_question: null };
	if (!activities.has(root)) activities.set(root, projectActivity(root));
	if (item.status === "processing" && !holds.has(root)) holds.set(root, findOpenHoldsIndexedByFeedbackId(root, entry.name));
	const open_question = item.status === "processing" ? (holds.get(root)?.[item.id] ?? null) : null;
	return { ...item, execution: executionForFeedback(item, activities.get(root)), open_question };
}
```

3. Nel blocco GET (righe 194-207), sostituisci:
```js
			const catalog = projectCatalog();
			const activities = new Map();
			if (!itemId) {
				const rows = await Promise.all(listFeedback(db, { type, project_id: project }).reverse().map(async (item) => decorateFeedback(await repairFeedbackScreenshots(db, item), project, { catalog, activities })));
				return send(res, 200, rows);
			}
			const found = await repairFeedbackScreenshots(db, getFeedback(db, itemId));
			if (!found || found.project_id !== project) return send(res, 404, { error: "not found" });
			return send(res, 200, { ...decorateFeedback(found, project, { catalog, activities }), audit: listFeedbackAudit(db, itemId) });
```
con:
```js
			const catalog = projectCatalog();
			const activities = new Map();
			const holds = new Map();
			if (!itemId) {
				const rows = await Promise.all(listFeedback(db, { type, project_id: project }).reverse().map(async (item) => decorateFeedback(await repairFeedbackScreenshots(db, item), project, { catalog, activities, holds })));
				return send(res, 200, rows);
			}
			const found = await repairFeedbackScreenshots(db, getFeedback(db, itemId));
			if (!found || found.project_id !== project) return send(res, 404, { error: "not found" });
			return send(res, 200, { ...decorateFeedback(found, project, { catalog, activities, holds }), audit: listFeedbackAudit(db, itemId) });
```

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-yano-dash-open-question.mjs`
Expected: `smoke-test-yano-dash-open-question: 2 passed`

Poi esegui `node scripts/smoke-test-yano-dash.mjs` per confermare zero regressioni sul comportamento esistente della dashboard.

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-dash.mjs scripts/smoke-test-yano-dash-open-question.mjs
git commit -m "feat(dash): expose open_question on processing items"
```

Isola l'hunk — `scripts/yano-dash.mjs` ha modifiche concorrenti in corso.

---

### Task 7: `requestDecisionHoldAnswer` in `yano-orchestrator-holds.mjs`

**Files:**
- Modify: `scripts/yano-orchestrator-holds.mjs`, `scripts/yano-feedback.mjs` (esporta `findOnlinePlanners`, già `export` dal Task 1 — nessuna modifica necessaria se già esportata correttamente)
- Test: `scripts/smoke-test-request-decision-hold-answer.mjs`

**Interfaces:**
- Consumes: `findOnlinePlanners` da `./yano-feedback.mjs` (Task 1, già esportata).
- Produces: `export async function requestDecisionHoldAnswer(projectId: string, hold: {id, generation}, answer: string): Promise<void>` — throws se nessun planner online; altrimenti pubblica `decision_hold_answer_requested` sul topic comandi del primo planner trovato.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import mqtt from "mqtt";

const BROKER = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const { requestDecisionHoldAnswer } = await import("./yano-orchestrator-holds.mjs");

async function publishPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, JSON.stringify({ instance, role: "planner", status: "idle" }), { qos: 1, retain: true });
	await client.endAsync();
}
async function clearPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, "", { qos: 1, retain: true });
	await client.endAsync();
}

console.log("=== nessun planner online: errore ===");
{
	await assert.rejects(
		() => requestDecisionHoldAnswer("workspace-answer-no-planner", { id: "hold-x", generation: 0 }, "sì, procedi"),
		/nessun planner online/,
	);
}
console.log("   OK");

console.log("=== planner online: comando pubblicato con i campi corretti ===");
{
	const project = "workspace-answer-with-planner";
	await publishPresence(project, "planner-04");
	try {
		const received = [];
		const listener = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
		listener.on("message", (_topic, payload) => { try { received.push(JSON.parse(payload.toString())); } catch {} });
		await listener.subscribeAsync(`pi/${project}/agents/planner-04/commands`, { qos: 1 });
		await new Promise((resolve) => setTimeout(resolve, 200));

		await requestDecisionHoldAnswer(project, { id: "hold-y", generation: 2 }, "usa GraphQL, è già lo standard del progetto");

		await new Promise((resolve) => setTimeout(resolve, 300));
		await listener.endAsync();
		assert.equal(received.length, 1);
		assert.equal(received[0].type, "decision_hold_answer_requested");
		assert.equal(received[0].hold_id, "hold-y");
		assert.equal(received[0].generation, 2);
		assert.equal(received[0].answer, "usa GraphQL, è già lo standard del progetto");
		assert.equal(received[0].project_id, project);
		assert.ok(received[0].idempotency_key, "ogni richiesta deve avere una idempotency_key fresca");
	} finally { await clearPresence(project, "planner-04"); }
}
console.log("   OK");

console.log("\nsmoke-test-request-decision-hold-answer: 2 passed");
```

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-request-decision-hold-answer.mjs`
Expected: `TypeError: requestDecisionHoldAnswer is not a function`

- [ ] **Step 3: Implementa**

In `scripts/yano-orchestrator-holds.mjs`, aggiungi in cima:
```js
import mqtt from "mqtt";
import crypto from "node:crypto";
import { findOnlinePlanners } from "./yano-feedback.mjs";
```

E in fondo al file:
```js
// Non scrive mai direttamente decision_holds: delega la scrittura reale a
// un'istanza planner online, che riusa la sua stessa answerDecisionHold —
// stesso motivo per cui findOpenHoldsIndexedByFeedbackId sopra è sola
// lettura (vedi design doc, sezione "Perché non si scrive mai direttamente").
export async function requestDecisionHoldAnswer(projectId, hold, answer) {
	const planners = await findOnlinePlanners(projectId);
	if (!planners.length) throw new Error(`nessun planner online per il progetto "${projectId}"`);
	const target = planners[0];
	const client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3_000 });
	try {
		await client.publishAsync(`pi/${projectId}/agents/${target.instance}/commands`, JSON.stringify({
			type: "decision_hold_answer_requested", hold_id: hold.id, generation: hold.generation,
			answer, idempotency_key: crypto.randomUUID(), project_id: projectId,
		}));
	} finally { await client.endAsync(); }
}
```

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-request-decision-hold-answer.mjs`
Expected: `smoke-test-request-decision-hold-answer: 2 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-orchestrator-holds.mjs scripts/smoke-test-request-decision-hold-answer.mjs
git commit -m "feat(orchestrator-holds): add requestDecisionHoldAnswer, delegated to an online planner"
```

---

### Task 8: Endpoint `answer-question` in `yano-dash.mjs`

**Files:**
- Modify: `scripts/yano-dash.mjs`
- Test: `scripts/smoke-test-answer-decision-hold-endpoint.mjs`

**Interfaces:**
- Consumes: `requestDecisionHoldAnswer`, `findOpenHoldsIndexedByFeedbackId` (Task 5/7).
- Produces: `POST /<project>/bugs/<id>/answer-question` e `/<project>/suggestions/<id>/answer-question`, body `{answer}` → `200 {ok:true}` o `404`/`400`/`409` con `{error}`.

- [ ] **Step 1: Scrivi il test che fallisce**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import mqtt from "mqtt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-answer-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yano-dash-answer-project-"));
const env = { ...process.env, YANO_DATA_DIR: dataDir, YANO_FEEDBACK_SKIP_NOTIFY: "1" };
const BROKER = process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

function seedWatcherRegistry() {
	const { DatabaseSync: WatcherDb } = require("node:sqlite");
	const watcherDir = path.join(dataDir, "watcher");
	fs.mkdirSync(watcherDir, { recursive: true });
	const db = new WatcherDb(path.join(watcherDir, "watcher-registry.sqlite"));
	db.exec(`CREATE TABLE watcher_projects (project_key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, workspace_id TEXT, worker_tab_id TEXT, worker_pane_id TEXT, worker_instance TEXT, worker_status TEXT NOT NULL DEFAULT 'stopped', interval_ms INTEGER NOT NULL DEFAULT 60000, lookback_ms INTEGER NOT NULL DEFAULT 3600000, last_recovery_at TEXT, last_recovery_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
	const now = new Date().toISOString();
	db.prepare("INSERT INTO watcher_projects(project_key,name,root,worker_status,interval_ms,lookback_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("watcher-answer", "answer-demo", projectRoot, "running", 60000, 3600000, now, now);
	db.close();
}
function seedOpenHold(feedbackId) {
	const dbDir = path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage");
	fs.mkdirSync(dbDir, { recursive: true });
	const db = new DatabaseSync(path.join(dbDir, "orchestrator.db"));
	db.exec(`CREATE TABLE decision_holds (id TEXT PRIMARY KEY, run_id TEXT, ticket_id TEXT, generation INTEGER, question TEXT, context TEXT, owner TEXT, status TEXT, answer TEXT, resolution_metadata TEXT, created_at TEXT, expires_at TEXT, updated_at TEXT)`);
	db.prepare("INSERT INTO decision_holds (id,run_id,generation,question,context,owner,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
		.run("hold-answer-test", "run-answer", 3, "Confermi il rollback?", JSON.stringify({ feedback_id: feedbackId }), "planner-05", "open", new Date().toISOString(), new Date().toISOString());
	db.close();
}
function dashStatePath() { return path.join(dataDir, "dashboards", "dash.json"); }
async function startDash() {
	const child = spawn("node", [path.join(root, "bin", "yano.mjs"), "dash", "start", "--no-open", "--port", "0", "--project-id", "answer-demo"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(dashStatePath())) { try { const state = JSON.parse(fs.readFileSync(dashStatePath(), "utf8")); if (state.port && state.pid) return { child, port: state.port }; } catch {} }
		await sleep(50);
	}
	throw new Error("yano dash non ha scritto lo state file in tempo");
}
async function fetchJson(url, options) { const response = await fetch(url, options); return { status: response.status, body: await response.json() }; }
async function publishPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, JSON.stringify({ instance, role: "planner", status: "idle" }), { qos: 1, retain: true });
	await client.endAsync();
}
async function clearPresence(project, instance) {
	const client = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
	await client.publishAsync(`pi/${project}/agents/${instance}/status`, "", { qos: 1, retain: true });
	await client.endAsync();
}

let dash = null;
try {
	seedWatcherRegistry();
	dash = await startDash();

	console.log("=== risposta senza planner online: 409, errore chiaro ===");
	{
		const { body: created } = await fetchJson(`http://127.0.0.1:${dash.port}/answer-demo/bugs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "serve una decisione" }) });
		seedOpenHold(created.id);
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/answer-demo/bugs/${created.id}/answer-question`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "sì" }) });
		assert.equal(status, 409);
		assert.match(body.error, /nessun planner online/);
	}
	console.log("   OK");

	console.log("=== nessun hold aperto per quell'item: 404 ===");
	{
		const { body: created } = await fetchJson(`http://127.0.0.1:${dash.port}/answer-demo/bugs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "nessuna domanda qui" }) });
		const { status, body } = await fetchJson(`http://127.0.0.1:${dash.port}/answer-demo/bugs/${created.id}/answer-question`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "sì" }) });
		assert.equal(status, 404);
		assert.match(body.error, /nessuna domanda aperta/);
	}
	console.log("   OK");

	console.log("=== risposta valida con planner online: 200, comando pubblicato correttamente ===");
	{
		const { body: created } = await fetchJson(`http://127.0.0.1:${dash.port}/answer-demo/bugs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "serve una decisione" }) });
		seedOpenHold(created.id);
		await publishPresence("answer-demo", "planner-05");
		try {
			const received = [];
			const listener = await mqtt.connectAsync(BROKER, { connectTimeout: 3_000 });
			listener.on("message", (_topic, payload) => { try { received.push(JSON.parse(payload.toString())); } catch {} });
			await listener.subscribeAsync(`pi/answer-demo/agents/planner-05/commands`, { qos: 1 });
			await sleep(200);

			const { status } = await fetchJson(`http://127.0.0.1:${dash.port}/answer-demo/bugs/${created.id}/answer-question`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "procedi con il rollback" }) });
			assert.equal(status, 200);

			await sleep(300);
			await listener.endAsync();
			assert.equal(received.length, 1);
			assert.equal(received[0].type, "decision_hold_answer_requested");
			assert.equal(received[0].hold_id, "hold-answer-test");
			assert.equal(received[0].generation, 3);
			assert.equal(received[0].answer, "procedi con il rollback");
		} finally { await clearPresence("answer-demo", "planner-05"); }
	}
	console.log("   OK");

	console.log("\nsmoke-test-answer-decision-hold-endpoint: 3 passed");
} finally {
	if (dash?.child && dash.child.exitCode === null) { try { dash.child.kill("SIGKILL"); } catch {} }
	try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
	try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
```

- [ ] **Step 2: Verifica che fallisca**

Run: `node scripts/smoke-test-answer-decision-hold-endpoint.mjs`
Expected: 404 su tutte le richieste (`answer-question` non esiste ancora come rotta).

- [ ] **Step 3: Implementa**

In `scripts/yano-dash.mjs`:

1. Aggiungi l'import accanto a quello del Task 6:
```js
import { findOpenHoldsIndexedByFeedbackId, requestDecisionHoldAnswer } from "./yano-orchestrator-holds.mjs";
```
(sostituisce l'import a riga singola del Task 6 con questa forma a due nomi.)

2. Nel corpo di `handler()`, subito PRIMA del blocco GET esistente (riga 194, `if (req.method === "GET" && parts.length >= 2 ...`), aggiungi:
```js
	if (req.method === "POST" && parts.length === 4 && ["bugs", "suggestions"].includes(parts[1]) && parts[3] === "answer-question") {
		const project = parts[0];
		const itemId = parts[2];
		const found = getFeedback(db, itemId);
		if (!found || found.project_id !== project) return send(res, 404, { error: "not found" });
		const body = await new Promise((resolve, reject) => { let raw = ""; req.on("data", (chunk) => { raw += chunk; }); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); req.on("error", reject); });
		const answer = String(body.answer || "").trim();
		if (!answer) return send(res, 400, { error: "la risposta non può essere vuota" });
		const entry = projectCatalog().find((candidate) => candidate.id === project);
		if (!entry) return send(res, 404, { error: "progetto non trovato" });
		const hold = findOpenHoldsIndexedByFeedbackId(entry.root, entry.name)[itemId];
		if (!hold) return send(res, 404, { error: "nessuna domanda aperta per questo elemento" });
		try {
			await requestDecisionHoldAnswer(project, hold, answer);
		} catch (error) {
			return send(res, 409, { error: error.message });
		}
		return send(withChangeBroadcast(res, req, clients), 200, { ok: true });
	}
```

- [ ] **Step 4: Verifica che passi**

Run: `node scripts/smoke-test-answer-decision-hold-endpoint.mjs`
Expected: `smoke-test-answer-decision-hold-endpoint: 3 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/yano-dash.mjs scripts/smoke-test-answer-decision-hold-endpoint.mjs
git commit -m "feat(dash): add answer-question endpoint for open planner decision holds"
```

---

### Task 9: `handleDecisionHoldAnswerRequested` in `extensions/orchestrator.ts`

**Files:**
- Modify: `extensions/orchestrator.ts`
- Verifica: sintassi + manuale (stesso motivo del Task 4)

**Interfaces:**
- Consumes: `ensureYanoStorage`, `yanoPublishEvent`, `logEvent`, `identity` (già esistenti).

- [ ] **Step 1: Baseline sintassi**

Run: `node scripts/check-syntax.mjs`
Expected: nessun errore (baseline pre-modifica).

- [ ] **Step 2: Implementa**

Subito dopo `handleFeedbackAssigned` (Task 4), aggiungi:

```ts
	// Riusa ESATTAMENTE la stessa storage.answerDecisionHold del tool
	// decision_hold_answer (riga ~7280) — stesso fencing di generazione,
	// stessa idempotenza, stesso outbox che risveglia il run bloccato. Non
	// viene mai duplicata qui: yano-dash delega sempre a un'istanza planner
	// online reale proprio per questo motivo (vedi design doc).
	function handleDecisionHoldAnswerRequested(payload: any): void {
		if (!identity || identity.role !== "planner" || payload?.project_id !== identity.project || !yanoStorage) return;
		try {
			const hold = yanoStorage.answerDecisionHold(payload.hold_id, { generation: payload.generation, idempotency_key: payload.idempotency_key, answer: payload.answer });
			yanoStorage.recordEvent(hold.run_id, "decision_hold_answered", { hold_id: hold.id, generation: hold.generation, idempotency_key: payload.idempotency_key }, hold.ticket_id);
			void yanoPublishEvent(hold.run_id, "decision_hold_answered", { hold_id: hold.id, generation: hold.generation });
			logEvent("decision_hold_answered_via_dashboard", { hold_id: hold.id });
		} catch (error) {
			logEvent("decision_hold_answer_via_dashboard_failed", { hold_id: payload.hold_id, error: error instanceof Error ? error.message : String(error) });
		}
	}
```

Poi, nello stesso if-chain del dispatcher (riga 3665 + il nuovo ramo del Task 4), aggiungi un ulteriore `else if`:

```ts
					if (env.type === "feedback_received") handleFeedbackReceived(env);
					else if (env.type === "feedback_assigned") handleFeedbackAssigned(env);
					else if (env.type === "decision_hold_answer_requested") handleDecisionHoldAnswerRequested(env);
```

- [ ] **Step 3: Verifica sintassi**

Run: `node scripts/check-syntax.mjs`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale con un planner reale**

Con `yano dash` e una tab planner reale già avviati (come nel Task 4): fai in modo che il planner crei un hold aperto reale (`decision_hold_create` con `context={"feedback_id":"<id-della-card>"}`), conferma che la card cambi colore in dashboard (una volta completato anche il Task 10), rispondi dalla dashboard, e verifica che l'hold risulti `answered` (`decision_hold_get`) e che il planner riprenda il lavoro. Registra l'esito prima di procedere.

- [ ] **Step 5: Commit**

```bash
git add extensions/orchestrator.ts
git commit -m "feat(orchestrator): answer a decision hold requested from the dashboard"
```

---

### Task 10: UI — badge domanda + form di risposta

**Files:**
- Modify: `scripts/dash-ui/api.js`, `scripts/dash-ui/components/Card.js`, `scripts/dash-ui/components/Drawer.js`
- Verifica: manuale in browser (nessun harness di test automatico esiste per il rendering Preact in questo progetto — coerente con come sono già stati verificati gli altri fix UI di questa sessione).

**Interfaces:**
- Consumes: `item.open_question` (Task 6).
- Produces: `answerQuestion(project, type, id, answer)` in `api.js`.

- [ ] **Step 1: `api.js`**

Aggiungi in `scripts/dash-ui/api.js`, dopo `updateItem`:

```js
export function answerQuestion(project, type, id, answer) {
	const collection = type === "bug" ? "bugs" : "suggestions";
	return requestJson(`/${encodeURIComponent(project)}/${collection}/${encodeURIComponent(id)}/answer-question`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ answer }),
	});
}
```

- [ ] **Step 2: `Card.js`**

In `scripts/dash-ui/components/Card.js`, aggiungi una classe/stile condizionale distinto dal bordo di severità. Sostituisci la riga `<article ...>` (righe 9-17) — aggiungi un bordo esterno + sfondo tenue quando `item.open_question` è presente, e l'icona ❓ accanto al titolo:

```js
		<article
			class=${`w-full min-w-0 max-w-full cursor-grab rounded-lg border-l-4 p-3 shadow hover:bg-slate-700 ${item.open_question ? "bg-amber-950 ring-2 ring-amber-400" : "bg-slate-800"}`}
			style=${{ borderLeftColor: SEVERITY_COLOR[item.severity || "medium"] }}
			draggable="true"
			onDragStart=${() => onDragStart()}
			onDragOver=${(event) => { if ([...(event.dataTransfer?.items || [])].some((entry) => entry.kind === "file")) event.preventDefault(); }}
			onDrop=${(event) => { event.preventDefault(); event.stopPropagation(); onFileDrop?.([...event.dataTransfer.files]); }}
			onClick=${() => onOpen(item)}
		>
			${shot ? html`<img class="mb-3 h-28 w-full rounded object-cover" src=${shot} alt="Screenshot allegato" onError=${(event) => event.target.remove()} />` : null}
			<div class="flex items-start justify-between gap-2">
				<b class="min-w-0 flex-1 break-words text-slate-50">${item.open_question ? "❓ " : ""}${showType ? `${typeIcon(item.type)} ` : ""}${titleOf(item)}</b>
				${item.severity ? html`<span class="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-900" style=${{ background: SEVERITY_COLOR[item.severity] }}>${item.severity}</span>` : null}
			</div>
```

(le righe successive del componente, `<small>...` e il resto, restano invariate.)

- [ ] **Step 3: `Drawer.js`**

In `scripts/dash-ui/components/Drawer.js`:

1. Import aggiuntivo:
```js
import { answerQuestion } from "../api.js";
```

2. Nuovo stato subito dopo `const [screenshots, setScreenshots] = useState(...)` (riga 33):
```js
	const [questionAnswer, setQuestionAnswer] = useState("");
	const [answering, setAnswering] = useState(false);
```

3. Nuova funzione, subito dopo `submit` (dopo la sua chiusura, riga 53):
```js
	async function submitAnswer(event) {
		event.preventDefault();
		if (!questionAnswer.trim()) return setError("La risposta non può essere vuota.");
		setAnswering(true);
		setError(null);
		try {
			await answerQuestion(project, item.type, item.id, questionAnswer.trim());
			setQuestionAnswer("");
		} catch (answerError) {
			setError(answerError.message);
		} finally {
			setAnswering(false);
		}
	}
```

Nota: `project` non è oggi un prop di `Drawer` — verifica in `app.js` come viene passato `project` al componente `Drawer` (riga 130-137 di `app.js`) e aggiungi `project=${project}` alla sua invocazione, più `project` alla firma `export function Drawer({ item, defaultType, initialStatus, onClose, onSave, project })`.

4. Nel markup, subito dopo la sezione `${item?.execution ? html\`<${ActivityIndicator} ... /> \` : null}` (riga 106), aggiungi:
```js
				${item?.open_question ? html`
					<section class="rounded-md border border-amber-400 bg-amber-950 p-3">
						<h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-200">❓ Domanda aperta dal planner</h3>
						<p class="mb-2 text-amber-100">${item.open_question.question}</p>
						<p class="mb-2 text-xs text-amber-300">In attesa di risposta per: ${item.open_question.owner}</p>
						<textarea class="mb-2 min-h-[60px] w-full min-w-0 rounded-md border border-amber-600 bg-slate-950 px-2 py-1 text-slate-100" placeholder="Scrivi la risposta..." value=${questionAnswer} onInput=${(event) => setQuestionAnswer(event.target.value)}></textarea>
						<button type="button" disabled=${answering} class="w-full rounded-md bg-amber-500 py-2 font-semibold text-slate-900 disabled:opacity-50" onClick=${submitAnswer}>${answering ? "Invio..." : "Rispondi"}</button>
					</section>
				` : null}
```

- [ ] **Step 4: Verifica manuale in browser**

Con `yano dash` avviato e un hold aperto reale collegato a una card `processing` (creato manualmente per il test, come nel Task 9): apri la board, conferma che la card abbia il bordo/sfondo ambra e l'icona ❓; apri il dettaglio, conferma che la domanda sia leggibile; scrivi una risposta e invia; conferma che (con un planner online) la richiesta torni 200 e che, dopo il poll di sicurezza del Task 11 o un refresh manuale, la card torni al colore normale.

- [ ] **Step 5: Commit**

```bash
git add scripts/dash-ui/api.js scripts/dash-ui/components/Card.js scripts/dash-ui/components/Drawer.js scripts/dash-ui/app.js
git commit -m "feat(dash-ui): show open planner questions on cards and answer them"
```

---

### Task 11: Poll di sicurezza (8s) per rilevare risposte date altrove

**Files:**
- Modify: `scripts/dash-ui/app.js`

- [ ] **Step 1: Implementa**

In `scripts/dash-ui/app.js`, subito dopo l'`useEffect` esistente che sottoscrive `subscribeStream` (righe 52-55), aggiungi:

```js
	useEffect(() => {
		if (!project) return;
		// Rete di sicurezza indipendente dall'SSE: rispondere a un hold
		// direttamente in Herdr tocca solo il DB dell'orchestratore, mai la
		// tabella feedback, quindi non genera l'evento "changed" esistente.
		// loadItems() ricalcola open_question dal vivo ad ogni chiamata, quindi
		// questo timer è l'unico modo con cui la dashboard se ne accorge da
		// sola. Vedi docs/superpowers/specs/2026-09-08-yano-dash-planner-wiring-design.md.
		const timer = setInterval(loadItems, 8000);
		return () => clearInterval(timer);
	}, [project]);
```

- [ ] **Step 2: Verifica manuale**

Con una domanda aperta visibile su una card (dal Task 10), rispondi all'hold SENZA passare dalla dashboard (es. inserendo direttamente `status='answered'` sul DB di test, o rispondendo davvero da una tab planner via `decision_hold_answer`), attendi fino a 8 secondi e conferma che la card torni al colore normale senza ricaricare manualmente la pagina.

- [ ] **Step 3: Commit**

```bash
git add scripts/dash-ui/app.js
git commit -m "feat(dash-ui): poll for questions answered outside the dashboard"
```

---

### Task 12: Documentazione + regressione finale + verifica end-to-end reale

**Files:**
- Modify: `docs/quick-guides/24-feedback-dashboards.md`

- [ ] **Step 1: Aggiorna la documentazione**

Aggiungi alla sezione sui cambi di stato (dopo il paragrafo "Trascinare una card in un'altra colonna apre il pannello di dettaglio...") un paragrafo che descriva: l'assegnazione reale al planner online quando si sposta una card su "processing" (con blocco esplicito se nessun planner è online), la visibilità delle domande del planner sulla card (colore distinto + risposta dal pannello), e il rilevamento automatico (entro 8s) di una risposta data altrove (es. Herdr).

- [ ] **Step 2: Suite completa**

Run: `node scripts/test-all.mjs`
Expected: tutti i controlli passano (131 + i nuovi test di questo piano — circa 155-160 attesi, il numero esatto dipende dai conteggi interni di ogni nuovo file).

- [ ] **Step 3: Verifica end-to-end reale finale**

Con `yano dash start` e una tab planner reale avviati: crea (o riusa) un bug in "received", trascinalo su "processing", conferma che il planner reagisca; fai in modo che il planner chiami `decision_hold_create` con `context.feedback_id` collegato; conferma che la card cambi colore; rispondi dalla dashboard; conferma che il planner riprenda; verifica infine che rispondere direttamente in una tab planner (per un secondo hold di prova) faccia sparire l'avviso dalla dashboard entro 8s senza reload manuale.

- [ ] **Step 4: Commit**

```bash
git add docs/quick-guides/24-feedback-dashboards.md
git commit -m "docs(feedback-dashboards): document real planner assignment and visible questions"
```
