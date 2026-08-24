Type: human
Kind: task
Status: resolved
Blocked by: 27

## Question

Applicare il contratto `decision_holds` al control plane SQLite: aggiungere migrazione/schema, garantire che `yano-status` legga gli hold senza crash e verificare il percorso con lo smoke test dedicato.

## Answer

Aggiunta la tabella `decision_holds` allo schema SQLite dell'estensione con run/ticket/generation, domanda/contesto, owner, stati vincolati, risposta, metadata di risoluzione, timestamp ed expiry. Aggiunto l'indice `(run_id, status)` usato da `yano-status`.

Verifica completata con `node scripts/smoke-test-yano-status.mjs`: 7 asserzioni passate.

## Comments

- Task AFK eseguito il 2026-08-22.
