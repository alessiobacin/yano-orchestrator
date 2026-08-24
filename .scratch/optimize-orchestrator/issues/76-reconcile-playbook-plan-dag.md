# 76 — Reconciliation completo Playbook–plan–DAG

Type: human
Kind: task

**What to build:** Il runtime confronta il Playbook normativo con plan e DAG persistiti e rende consultabile un risultato deterministico di riallineamento.

**Blocked by:** 25, 43

**Status:** resolved

- [ ] Ogni stato Playbook è associabile a fase, plan e nodi DAG con generazione persistita.
- [ ] Conflitti e mapping mancanti producono `blocked` o `needs_replan` senza auto-inventare lavoro.
- [ ] Diff, cause, generazione ed esito sono idempotenti, auditati e visibili nel resume.

## Progress

Implementato il primo vertical slice: `playbook_reconcile` è planner-only,
richiede un Playbook bound e un plan strutturato, verifica stati, fasi, ticket
appartenenti al run e inversioni delle dipendenze, quindi persiste un
checkpoint/evento con checksum, generation, diff e outcome `coherent` oppure
`needs_replan`. Retry con la stessa idempotency key non duplicano il checkpoint
né l'audit. Il gate non modifica ticket, plan o Playbook e non inventa lavoro.

Lo smoke end-to-end è stato aggiunto a `scripts/smoke-test-reconciliation.mjs`
e verifica mapping coerente, retry idempotente e inversione di dipendenza che
richiede replan senza mutare il DAG: 10 assertion verdi. Il checkpoint è già
visibile nella superficie di resume tramite la lista dei checkpoint/eventi.
