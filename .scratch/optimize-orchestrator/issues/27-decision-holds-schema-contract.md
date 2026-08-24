Type: human
Kind: grilling
Status: resolved
Blocked by: 19, 26

## Question

Quale contratto deve avere `decision_holds` nel control plane SQLite? Definire scopo, stati, owner, domanda/contesto, evidenze, expiry, resume/release, idempotenza, relazioni con ticket/run/approval, visibilità in `yano-status` e comportamento dopo crash o migrazione.

## Answer

Un decision hold rappresenta una pausa esplicita del planner in attesa di una decisione umana/qualitativa. Gli stati sono almeno `open`, `answered`, `expired`, `cancelled` e `blocked`.

Ogni hold contiene `run_id`, eventuale `ticket_id`, `generation`, domanda, contesto, owner, `created_at`, expiry, risposta e resolution metadata.

La risposta è un evento autenticato, idempotente e legato alla stessa generation. Una risposta duplicata viene ignorata; una risposta conflittuale viene rifiutata e auditata.

Un hold scaduto porta a `blocked`/escalation senza ripresa automatica. `yano-status` mostra gli hold attivi e la migrazione SQLite deve creare `decision_holds` prima che il comando possa operare.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
