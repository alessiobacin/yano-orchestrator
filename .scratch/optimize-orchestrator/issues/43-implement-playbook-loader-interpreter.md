Type: human
Kind: task
Status: resolved
Blocked by: 12, 18, 24

## Question

Implementare il loader, validator e interprete runtime dei Playbook versionati, mantenendo il Playbook come autorità normativa e impedendo transizioni o effetti non dichiarati.

## Destination

Specifiche di riferimento: [spec.md](../spec.md), [contratto eseguibile del Playbook](12-playbook-executable-contract.md), [loader e distribuzione](18-playbook-loader-distribution-contract.md), [interpreter runtime gate](24-playbook-interpreter-runtime-gate.md).

## Acceptance Criteria

- Un Playbook viene caricato solo da una sorgente dichiarata, con versione, origine e checksum persistiti.
- Schema, guardie, transizioni ed effetti sconosciuti causano failure fail-fast senza mutare il run.
- Una versione attiva resta immutabile per tutta la vita del run.
- Le transizioni sono serializzate per run e applicate atomicamente insieme all’audit.
- Effetti asincroni usano idempotency key e outbox; retry e recovery non duplicano effetti.
- `human_approval` apre un decision hold solo quando il Playbook lo dichiara.
- Incompatibilità tra Playbook, piano e DAG produce `blocked`/`needs_replan` secondo il contratto, senza inventare un piano.
- Esistono smoke test black-box per caricamento, checksum, fail-fast, immutabilità, guardie, effetti e recovery.

## Progress

Completato il primo vertical slice in `scripts/playbook-loader.mjs`: parsing YAML, schema validation fail-fast, origin/checksum SHA-256, deep immutability e registry in-memory con binding idempotente e rifiuto di checksum divergenti per lo stesso run. `scripts/smoke-test-playbook-loader.mjs` è verde.

Restano da implementare l’integrazione SQLite per il binding per-run, l’interprete delle guardie/transizioni e l’outbox degli effetti asincroni; il ticket resta `claimed` fino al completamento di questi contratti.

Aggiornamento: il binding SQLite è ora implementato. `playbook_bind` carica il Playbook validato, persiste snapshot/origin/checksum per run, è idempotente sullo stesso checksum e rifiuta checksum divergenti; `run_status` espone il binding. Ticket engine: 53 assertion verdi.

Secondo vertical slice completato: `playbook_runtime_state` persiste stato/generation per run; `playbook_transition` risolve una transizione dichiarata, verifica stato di partenza, actor, guardie e generation, aggiorna lo stato e registra l’audit nella stessa transazione. Ticket engine: 56 assertion verdi.

Terzo vertical slice completato: le transizioni possono dichiarare effetti `{id, kind, payload}`; il loader li valida e il runtime li persiste in `playbook_effect_outbox` con dedupe key nella stessa transazione dello state change. `playbook_effect_list` li espone come pending senza eseguire effetti esterni. Ticket engine: 58 assertion verdi.

Quarto vertical slice completato: `playbook_effect_ack` consente a un adapter autorizzato di confermare un effetto con generation e idempotency key; la conferma aggiorna stato e audit atomicamente, senza eseguire shell o effetti arbitrari. Ticket engine: 60 assertion verdi.

## Answer

Il contratto è implementato nel vertical slice runtime corrente. Il loader
valida schema, riferimenti, guardie ed effetti fail-fast, calcola origin e
checksum, congela il documento e impedisce rebinding divergenti. Il runtime
persiste binding immutabile, stato/generation, evidenze, transizioni atomiche,
outbox deduplicata, decision hold e ack autorizzato con fencing.

Verifiche eseguite:

- `node scripts/smoke-test-playbook-loader.mjs` — verde;
- `node scripts/smoke-test-reconciliation.mjs` — 7 assertion verdi;
- `node scripts/smoke-test-ticket-engine.mjs` — 90 assertion verdi;
- `npm run check-syntax` — verde.

Il reconciliation resta non distruttivo: segnala ticket dangling e hold aperti
senza inventare un piano o auto-risolvere il lavoro. I gap successivi sono
tracciati nella specifica dell'issue 74.
