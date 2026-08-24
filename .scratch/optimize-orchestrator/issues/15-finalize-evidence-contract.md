Type: human
Kind: grilling
Status: resolved
Blocked by: 04, 05

## Question

Quali evidenze reali deve verificare `worktree_finalize` prima di merge e push? Definire prove per test, versione, docs-sync, approvazione reviewer/planner, stato del worktree, conflitti, report e comportamento quando un'evidenza è autodichiarata ma non verificabile.

## Answer

`worktree_finalize` richiede test eseguiti realmente dal runtime, con comando, exit code, timestamp e output redatto. Un test dichiarato non applicabile richiede una motivazione verificabile.

La versione viene verificata confrontando il diff reale del manifest di progetto, come `package.json` o equivalente, con la versione precedente; l'autodichiarazione non è sufficiente. Il docs-sync verifica i file pertinenti rispetto al diff reale, inclusi README, quickstart, architettura e API docs quando applicabili.

Sono obbligatori reviewer approval persistita, planner approval persistita, report completo dei round, worktree coerente senza modifiche inattese, branch identificabile e commit identificabile.

Se una prova manca, fallisce o non è verificabile, `worktree_finalize` rifiuta merge e push e lascia intatto il worktree. Merge e push sono passaggi distinti, idempotenti e registrati nello stato del run.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
