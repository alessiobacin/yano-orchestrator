Type: human
Kind: task
Status: resolved

## Question

`plannerStalled()` in `scripts/yano-watcher-registry.mjs` sopprime correttamente
un falso "planner stalled" quando esiste un `decision_holds` aperto per il run
(`WHERE status='open'`), ed è verificato da un test reale
(`scripts/smoke-test-watchdog.mjs`, asserzione "an open human decision hold
suppresses false stalled/orphaned alerts").

Il problema: `prompts/planner.md` istruisce il planner ad "attendere conferma
dell'utente" in più punti del flusso (framing/roster, `to-tickets`/granularità,
`get-the-best-from`, ecc. — righe indicative 338, 364, 401-402) ma **non chiama
mai `decision_hold_create`** in nessuno di questi punti, benché il tool sia
disponibile ai ruoli `planner`/`user` (`extensions/orchestrator.ts`, tool
`decision_hold_create`). Il meccanismo di soppressione esiste ed è testato, ma
resta cablato solo per i gate strutturati dei Playbook (es. approvazione
deploy in produzione), non per le conferme di conversazione ordinarie.

Conseguenza osservabile: se l'utente impiega più di
`YANO_PLANNER_STALL_MS`/`DEFAULT_PLANNER_STALL_MS` (15 minuti) a rispondere a
una domanda di conferma ordinaria, `yano watcher supervise` (cron ogni minuto)
classifica il run come `planner_stalled` e chiama `recoverPlanner()`, che
inietta un comando `yano start --instance planner-01 ... "<prompt di
recovery>"` **nello stesso pane Herdr** dove il planner sta aspettando la
risposta dell'utente in TUI — rischio concreto di interferire con la sessione
interattiva viva e sprecare un turno/token per "recuperare" un agente che non
era affatto bloccato.

Cosa serve: individuare nel prompt del planner ogni punto in cui il flusso
prescrive "attendi conferma/attendi la scelta dell'utente" e farlo aprire un
`decision_hold_create` (owner: user) prima di fermarsi, chiudendolo con
`decision_hold_answer`/`decision_hold_cancel` alla risposta (o quando il gate
non è più necessario). Deve restare compatibile con i flussi di conversazione
dove `orchestrator.db` non esiste ancora (vedi `yano watch`: registra
`waiting/not_initialized` senza escalation in quel caso — un hold non può
essere aperto prima di `orchestrator_init`).

## Answer

Precisazione trovata durante l'implementazione, più esatta della formulazione
della domanda: la condizione che protegge davvero da `plannerStalled()` non è
`orchestrator_init` (crea solo il workspace/DB, idempotente) ma l'esistenza di
un **run** (`run_create`, che produce il `run_id` richiesto da
`decision_hold_create`). Per giunta `reconcileProjectRun()` in
`scripts/yano-watcher-registry.mjs` restituisce già `project_idle` (nessun
recovery tentato) quando `runs.length === 0` — quindi i gate più precoci del
flusso "Nuovo task" (proposta di roster/fasi, granularità `to-tickets`), che
nel prompt avvengono **prima** di `run_create` (righe 192-193 di
`prompts/planner.md`: `run_create` è chiamato solo "dopo l'approvazione del
breakdown di `to-tickets`"), non sono a rischio concreto: non esiste ancora un
run da classificare stalled. Il rischio reale riguarda le conferme che il
planner richiede **dopo** che il run esiste già (debate pre-lancio se un run è
già attivo, riuso worktree, domanda di sostituzione modello a chiusura fase,
qualunque domanda ad-hoc a metà round).

Modifiche applicate a `prompts/planner.md`:
1. Aggiunti `decision_hold_create`, `decision_hold_answer`,
   `decision_hold_cancel` all'elenco dei tool disponibili in apertura (prima
   non comparivano da nessuna parte nel documento).
2. Nuova sezione "## Conferme dell'utente e `decision_hold`" (dopo "##
   Watchdog e risvegli"): spiega il meccanismo di `plannerStalled()`, la regola
   operativa (apri un hold quando esiste già un `run_id` e stai per fermare il
   turno per una conferma; chiudilo con `decision_hold_answer`/`cancel`), e il
   caso in cui non serve (nessun run ancora creato). Chiarisce anche che i gate
   Playbook strutturati con effect `human_approval` aprono già un hold da soli
   — nessuna duplicazione lì.
3. Puntatori inline alla nuova sezione nei tre punti concreti dove un run
   esiste già e il planner può restare fermo ad attendere: la conferma
   pre-lancio del debate (se un run è già attivo), il riuso del worktree
   (step 4 di "Nuovo task", che segue `run_create`), e la domanda di
   sostituzione modello a chiusura fase/task.

Verifica: nessuna modifica al runtime necessaria — `plannerStalled()` e la sua
copertura in `scripts/smoke-test-watchdog.mjs` ("an open human decision hold
suppresses false stalled/orphaned alerts") erano già corrette, il gap era
esclusivamente nel prompt. Rieseguiti dopo la modifica, tutti verdi:
`smoke-test-development-contracts.mjs` (verifica testualmente la sezione
"Indipendenza obbligatoria coder ↔ reviewer", non toccata), `smoke-test-specialist-prompt.mjs`,
`smoke-test-yano-debate-playbook.mjs` (il gate di conferma debate è quello
modificato), `smoke-test-yano-conversation-playbook.mjs`,
`node scripts/check-skill-isolation.mjs`, `npm run check:docs`.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
