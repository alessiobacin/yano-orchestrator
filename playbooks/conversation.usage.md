# `conversation` — come si attiva

Playbook globale bundlato (`playbooks/conversation.yaml`, nessun ruolo
dedicato in `agents/roles.yaml`: il planner stesso lo esegue). Non richiede
l'iter di provisioning di Architect: è disponibile subito in ogni progetto
che gira su questa versione di `yano-orchestrator`, esattamente come
`qa-full-audit` o `qa-hardening`.

## 1. Perché esiste

Prima di questo playbook, l'ultima riga del cascade di
`candidateForTask()` in `scripts/yano-architect.mjs` assumeva sempre lavoro
di codice per qualunque messaggio che non corrispondesse a un pattern più
specifico (`deploy`, `docs`, `frontend`, `qa`, `refactor`, ...):

```js
return { playbook: "backend-change", roles: ["coder", "reviewer"], reason: "general implementation fallback" };
```

Una domanda o una discussione ("cosa ne pensi di Postgres vs Mongo per
questo caso?", "aiutami a capire come funziona X") finiva quindi trattata
come un task di consegna vero e proprio, con tutta la ceremony di
`playbooks/default.yaml` — worktree, conferma del team, `plan_set`, final
checks — anche se nessuno aveva ancora chiesto di costruire o modificare
nulla. `conversation` è il nuovo default onesto: il fallback ora distingue
un verbo d'azione chiaro (implementa/crea/scrivi/correggi/...), che
continua a instradare a `backend-change` come prima, da un testo che legge
come domanda/opinione/confronto, che instrada invece qui.

## 2. Richiesta in linguaggio naturale al planner

L'attivazione non è un comando CLI diretto: è un messaggio al planner, che
la instrada da solo tramite la stessa valutazione del catalogo usata per
ogni altro task (vedi `prompts/planner.md`, sezione "Scoping" e "Catalogo
playbook e team dinamici").

```text
Cosa ne pensi di usare Postgres invece di Mongo per questo caso?
```

```bash
yano architect assess --project-root "$PWD" \
  --task "Cosa ne pensi di usare Postgres invece di Mongo per questo caso?" \
  --json
```

Output reale (verificato in questa sessione):

```json
{
  "candidate_playbook": "conversation",
  "roles": [],
  "catalog": { "action": "reuse", "exact_match": { "id": "conversation" } }
}
```

Nessuna scelta ambigua: `conversation` non ha `catalog_alternatives`
dichiarate da nessun altro branch del cascade, quindi `user_choice_required`
è `false` e il planner procede senza fermare il turno.

## 3. Cosa fa il planner sotto al cofano

Nessun `worktree_create`, nessun `plan_set`, nessuna proposta di team: il
planner resta in `received` → `responding` e risponde direttamente,
eventualmente usando i propri tool di sola lettura (lettura file, `yano
trace`, ricerca web se disponibile) per informare la risposta. Non chiama
mai `agent_send` per assemblare un team di consegna mentre è in questo
stato — sarebbe la stessa ceremony che questo playbook esiste per evitare.

## 4. Se la conversazione cristallizza in un task vero

Se lo scambio (questo messaggio o un follow-up sullo stesso filo) rivela un
intento concreto e realizzabile ("sì, implementalo"), il planner passa a
`crystallizing`: rilancia `yano architect assess`/`candidateForTask` per la
descrizione ormai concreta del task, presenta all'utente il playbook di
consegna raccomandato e attende conferma.

`playbook_bind` è immutabile per tutta la vita di una run in questo
codebase (vedi `extensions/orchestrator.ts`, `playbook_bind` rifiuta un
checksum diverso da quello già legato). `conversation` rispetta questa
regola invece di inventare un'eccezione: **non** prova mai a ri-legare la
run corrente a un playbook diverso. La run `conversation` corrente si
limita a transitare in `completed` con un `handoff_target` annotato; è una
**nuova** run — nuovo slug, nuovo worktree, nuovo `plan_set`, nuovo
`playbook_bind` — quella che parte sul playbook raccomandato, solo dopo la
conferma esplicita dell'utente sull'handoff.

## 5. Cosa NON aspettarti da questo playbook

A differenza di `qa-full-audit` o di qualunque playbook di consegna:

- Non crea nessun worktree.
- Non produce nessun report di consegna (`.pi/extensions/yano-orchestrator/reports/<slug>.md`)
  nel senso dei playbook di delivery — è una conversazione, non un task
  tracciato a fasi.
- Non avvia nessuna istanza aggiuntiva: il planner stesso tiene la
  conversazione, non delega a un ruolo dedicato.
- Non chiama mai `plan_set`, `ticket_create` o `worktree_finalize`.
- Non richiede conferma del team (non c'è un team) — l'unica conferma
  esplicita che ha senso qui è quella dell'handoff, quando la
  conversazione cristallizza in un vero task.

## 6. Verifica diretta del playbook

```bash
yano playbook show conversation --json
```

Restituisce `id: conversation`, `catalog.scope: global`,
`catalog.reusable: true` — lo stesso schema di ogni altro playbook del
catalogo, verificato da `node scripts/lint-playbooks.mjs`.
