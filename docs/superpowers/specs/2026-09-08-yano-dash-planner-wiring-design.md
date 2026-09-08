# Yano Dash → planner reale: assegnazione e domande — Design

## Problema (verificato con systematic-debugging, non ipotizzato)

Oggi **ogni** cambio di colonna/stato nella dashboard (drag & drop o salvataggio dal
pannello di dettaglio) passa da un unico endpoint generico `PATCH`/`PUT` che chiama
`updateFeedback()` in [`scripts/yano-feedback.mjs`](../../../scripts/yano-feedback.mjs).
Quella funzione fa **solo** un `UPDATE` SQL + una voce di audit. Non chiama mai
`claimFeedback`, non pubblica mai nulla su MQTT, non sveglia mai un planner.
Spostare una card su "processing" oggi non ha alcun effetto reale sul lavoro svolto
dagli agenti — è pura cosmesi sul database.

Il meccanismo di assegnazione reale esiste già, ma **solo alla creazione** di un
bug/suggestion: `createFeedback()` → `notifyPlanner()` (righe 269-282 di
`yano-feedback.mjs`) fa una presence-check MQTT di 250ms su
`pi/<project_id>/agents/+/status`, e per ogni planner online pubblica un comando
`feedback_received` sul suo topic. Lato planner
([`extensions/orchestrator.ts`](../../../extensions/orchestrator.ts)),
`handleFeedbackReceived` (riga 3108) chiama `wakeNextQueuedFeedback` (riga 3089),
che a sua volta chiama `claimNextQueuedFeedback` (coda FIFO per priorità, in
`yano-feedback.mjs` riga 130) e inietta il messaggio nella conversazione del
planner via `pi.sendMessage`. Esiste anche un fallback: ad ogni fine turno
("planner_turn_end", righe 7624/7649) il planner ricontrola la coda da solo.

Una card **esistente**, spostata manualmente in dashboard, non attraversa MAI
questo percorso: è invisibile al planner finché non arriva un nuovo item creato
(che fa ripartire la presence-check per TUTTA la coda) o finché il planner non
finisce spontaneamente un turno.

Le domande del planner hanno anch'esse un meccanismo reale — `decision_hold_create`
(riga 7212 di orchestrator.ts) — ma: (a) non sono strutturalmente collegate al
`feedback_id` di origine (usano un `ticket_id` con foreign key verso la tabella
`tickets`, un concetto diverso), e (b) la dashboard non legge mai la tabella
`decision_holds`, quindi anche oggi una domanda del planner è invisibile sulla
card Kanban.

## Obiettivi

1. Spostare una card da received/pending_planner/queued a "processing" deve
   davvero assegnare quel task specifico a un planner online e farlo partire.
2. Se nessun planner è online per quel progetto, lo spostamento è bloccato con un
   errore chiaro (nessuna finzione di assegnazione).
3. Se il planner ha una domanda aperta collegata a quel task, la card lo mostra
   visivamente (colore/bordo distinto da quello di severità) e permette di
   rispondere direttamente dal pannello di dettaglio.
4. Nessuna regressione sul fix già rilasciato (screenshot round-trip,
   `screenshotsContentEqual`) né sul comportamento delle altre transizioni di
   stato (cancelled, paused, resolved, retry, ecc.), che restano puro bookkeeping
   umano come oggi.

## Non-obiettivi (esplicitamente fuori scope)

- Nessuna UI nuova dentro Herdr: la "prova che il planner lavora" è la sua stessa
  tab che reagisce — non c'è nulla da costruire lì, è una conseguenza diretta del
  fix.
- Nessun protocollo di conferma/ack sulla consegna MQTT del messaggio mirato: è
  "best effort", stesso identico livello di garanzia che il flusso di creazione
  ha già oggi (vedi sezione Rischi).
- Nessuna modifica allo schema del database dell'orchestratore (niente nuove
  colonne, niente nuove foreign key): il collegamento domanda↔card usa il campo
  JSON libero `context` già esistente su `decision_holds`.
- Nessuna riscrittura della logica transazionale di `answerDecisionHold`
  (fencing di generazione, idempotenza, outbox): viene riusata l'esatta funzione
  esistente, eseguita da un'istanza planner realmente online — mai duplicata
  lato dashboard.

## Architettura

### Componente 1 — Assegnazione manuale

**Nuova funzione condivisa in `yano-feedback.mjs`:**

```js
// Estrae la presence-check già usata da notifyPlanner in un helper riusabile.
async function findOnlinePlanners(projectId) { /* stessa logica di notifyPlanner righe 269-278, ma solo discovery, senza publish */ }

export async function assignFeedbackToPlanner(db, feedbackId, { actor = "local-user", reason } = {}) {
	const current = row(db, feedbackId);
	if (!current) throw new Error("elemento non trovato");
	if (!["received", "pending_planner", "queued"].includes(current.status))
		throw new Error(`impossibile assegnare: stato attuale "${current.status}" non è in coda`);
	const planners = await findOnlinePlanners(current.project_id);
	if (!planners.length) throw new Error(`nessun planner online per il progetto "${current.project_id}"`);
	const target = planners[0]; // "il primo trovato", come deciso
	const claimed = claimFeedback(db, feedbackId, { actor, reason: reason || "assegnato manualmente dalla dashboard" });
	const client = await mqtt.connectAsync(process.env.PI_ORCH_BROKER_URL || "mqtt://127.0.0.1:1883", { connectTimeout: 3_000 });
	try {
		await client.publishAsync(`pi/${current.project_id}/agents/${target.instance}/commands`, JSON.stringify({
			type: "feedback_assigned", feedback_type: current.type, feedback_id: claimed.id,
			project_id: current.project_id, message: buildQueuedFeedbackWakeMessage(claimed, current.type),
			resolution: claimed.resolution, screenshots: claimed.screenshots || [],
			requires_user_confirmation: current.type === "suggestion" || claimed.resolution === "user_confirmation",
		}));
	} finally { await client.endAsync(); }
	return claimed;
}
```

**`buildQueuedFeedbackWakeMessage`** (riga 119) guadagna una riga finale, presente
in ENTRAMBI i rami (bug/suggestion):

```
Se in qualunque momento durante questo task ti serve una decisione dell'utente,
chiama decision_hold_create passando context={"feedback_id":"<id>"} — così la
domanda compare automaticamente sulla card in dashboard.
```

**`extensions/orchestrator.ts`** — nuovo handler accanto a `handleFeedbackReceived`
(riga 3108), e nuovo ramo nel dispatcher MQTT (riga 3665, stesso if-chain):

```ts
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

Riga 3665: `if (env.type === "feedback_received") handleFeedbackReceived(env);`
diventa `if (env.type === "feedback_received") handleFeedbackReceived(env); else if (env.type === "feedback_assigned") handleFeedbackAssigned(env);`
(mantenendo tutti gli else-if successivi invariati).

**`yano-feedback.mjs` — dispatch PATCH/PUT** (riga 334): quando
`input.status === "processing"` **e** lo stato attuale è
received/pending_planner/queued, chiama `assignFeedbackToPlanner` invece di
`updateFeedback`. Ogni altra transizione resta invariata (bookkeeping puro).

**UI** (`Drawer.js`/`Board.js`/`app.js`): se la chiamata fallisce (nessun planner
online), la card non si sposta e un toast mostra l'errore esatto restituito
dall'API.

### Componente 2 — Domande del planner visibili + risposta dalla dashboard

**Perché non si scrive mai direttamente su `decision_holds` dalla dashboard:**
rispondere richiede — verificato leggendo `resolveDecisionHold` (riga 2408) —
un controllo di fencing sulla `generation`, una riga di idempotenza in
`decision_hold_operations`, e un inserimento in `decision_hold_outbox` che è
l'UNICO modo con cui il planner bloccato viene risvegliato (drenato da
`watchdogSweep`, riga 4113, **solo** per un'istanza planner realmente online —
stesso vincolo di liveness del Componente 1). Riscrivere questa logica in
`yano-dash` duplicherebbe codice delicato con rischio reale di corrompere lo
stato o rompere silenziosamente il risveglio. Si riusa invece la stessa
identica funzione `answerDecisionHold` già usata dal tool `decision_hold_answer`
(riga 7272), eseguita dall'istanza planner stessa via un nuovo comando MQTT.

**Nuovo modulo `scripts/yano-orchestrator-holds.mjs`** (sola lettura, DB separato
da quello di `yano-feedback.mjs`):

```js
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function orchestratorDbPath(projectRoot) {
	return path.join(projectRoot, ".pi", "extensions", "yano-orchestrator", "orchestratorStorage", "orchestrator.db");
}

// Ritorna null (mai eccezione) se il DB non esiste ancora — nessun orchestratore
// è mai partito per quel progetto.
export function findOpenHoldsByFeedbackId(projectRoot, feedbackIds) {
	const dbPath = orchestratorDbPath(projectRoot);
	if (!fs.existsSync(dbPath)) return {};
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db.prepare("SELECT id,run_id,ticket_id,generation,question,context,owner,created_at FROM decision_holds WHERE status='open'").all();
		const byFeedbackId = {};
		for (const row of rows) {
			let context; try { context = JSON.parse(row.context || "{}"); } catch { continue; }
			if (context.feedback_id && feedbackIds.includes(context.feedback_id)) {
				byFeedbackId[context.feedback_id] = { id: row.id, run_id: row.run_id, generation: row.generation, question: row.question, owner: row.owner, created_at: row.created_at };
			}
		}
		return byFeedbackId;
	} finally { db.close(); }
}
```

**`yano-dash.mjs`** — per le route GET (lista e singolo item) di un progetto:
risolve la root del progetto dal catalogo watcher-registry già usato per
`/api/projects`, filtra gli item in stato "processing", chiama
`findOpenHoldsByFeedbackId` una sola volta per l'intera richiesta, e allega
`open_question: {...} | null` a ogni item.

**Nuovo endpoint** `POST /<project-id>/bugs/<id>/answer-question` (e equivalente
per `/suggestions/`), body `{ answer: string }`:

1. Rilegge l'hold aperto per quel `feedback_id` (deve esistere ancora — se è già
   stato risposto/scaduto altrove, errore chiaro, niente doppio invio).
2. `findOnlinePlanners(project_id)` — nessuno online → stesso errore di blocco
   del Componente 1.
3. Pubblica su `pi/<project_id>/agents/<instance>/commands`:
   `{ type: "decision_hold_answer_requested", hold_id, generation, answer, idempotency_key: crypto.randomUUID(), project_id }`.

**`extensions/orchestrator.ts`** — nuovo handler, stesso if-chain di riga 3665:

```ts
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

Questo è l'**identico** corpo del tool `decision_hold_answer` esistente (riga
7272) — stessa funzione di storage, stesso fencing, stesso outbox. Zero
duplicazione della logica delicata.

**UI**: `Card.js` — se `item.open_question` è presente, bordo/sfondo dedicato
(distinto dal colore di severità) + icona ❓. `Drawer.js` — pannello con la
domanda, chi aspetta risposta, campo di testo + pulsante "Rispondi" che chiama il
nuovo endpoint.

## Rischi e compromessi accettati (documentati, non nascosti)

- **Nessun ack di consegna MQTT**: sia l'assegnazione mirata sia la risposta a
  una domanda sono "fire and forget" verso un planner visto online ~250ms prima.
  Se il planner si disconnette esattamente in quella finestra, il claim/risposta
  risulta comunque persistito (l'item passa a "processing", o l'hold risulta
  risposto) ma nessuno lo elabora subito. È lo stesso identico livello di
  garanzia che il flusso di creazione ha già oggi — non è una regressione,
  è il comportamento esistente del sistema. Non viene costruito un protocollo di
  conferma/retry: violerebbe "semplice, senza troppe opzioni" del brief originale.
  Se in futuro diventa un problema operativo reale, è risolvibile con un piccolo
  sweep periodico di item "processing" senza attività — non ora (YAGNI).
- **Item "processing" senza nessuno che lo lavori**: può succedere solo nella
  finestra di rischio sopra descritta. A differenza della coda naturale (dove un
  item "queued" rimane comunque visibile e recuperabile dal prossimo
  `claimNextQueuedFeedback`), un item già "processing" non rientra più in quel
  pool. Accettato come compromesso esistente nel sistema (stesso rischio che
  `claimFeedback` ha sempre avuto per gli altri chiamanti).

## Piano di test (TDD)

1. `assignFeedbackToPlanner`: nessun planner online → errore, item invariato
   (status originale, nessun audit "status_changed"); planner online (mock del
   subscribe MQTT) → claim eseguito, messaggio pubblicato con il testo atteso di
   `buildQueuedFeedbackWakeMessage`.
2. `findOpenHoldsByFeedbackId`: DB orchestratore inesistente → `{}` senza
   eccezioni; hold aperto con `context.feedback_id` corrispondente → trovato con
   i campi giusti; hold di un altro feedback_id o non aperto → ignorato.
3. Test end-to-end con processi reali (stesso pattern di
   `scripts/smoke-test-yano-dash.mjs`): un "planner" fittizio si connette a MQTT
   reale, si dichiara online; si sposta una card via API dash su "processing";
   si verifica che il fittizio riceva `feedback_assigned` con il feedback_id e
   messaggio corretti. Poi si simula la creazione di un decision_hold reale (via
   un secondo processo TS minimale o inserimento diretto nel DB dell'orchestratore
   di test) con `context.feedback_id`; si verifica che compaia su
   `GET /<project>/bugs/<id>`; si risponde via il nuovo endpoint; si verifica che
   il fittizio riceva `decision_hold_answer_requested` con i campi giusti.
4. Nessuna regressione: la suite completa (`node scripts/test-all.mjs`,
   attualmente 131 controlli) deve continuare a passare, incluso il test di
   regressione screenshot/status già presente.

## File toccati

- `scripts/yano-feedback.mjs` — `findOnlinePlanners`, `assignFeedbackToPlanner`,
  riga finale in `buildQueuedFeedbackWakeMessage`, dispatch PATCH/PUT.
- `extensions/orchestrator.ts` — `handleFeedbackAssigned`,
  `handleDecisionHoldAnswerRequested`, due nuovi rami nell'if-chain di riga 3665.
- `scripts/yano-orchestrator-holds.mjs` — nuovo, sola lettura.
- `scripts/yano-dash.mjs` — arricchimento GET con `open_question`, nuovo endpoint
  `answer-question`.
- `scripts/dash-ui/components/Card.js`, `Drawer.js` — evidenza visiva domanda +
  form di risposta.
- Nuovi smoke test per ciascun pezzo sopra elencato.
- `docs/quick-guides/24-feedback-dashboards.md` — aggiornamento della sezione
  esistente sui cambi di stato per riflettere l'assegnazione reale e le domande
  visibili.
