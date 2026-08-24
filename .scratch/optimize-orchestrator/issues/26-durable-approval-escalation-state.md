Type: human
Kind: grilling
Status: resolved
Blocked by: 03, 12, 13

## Question

Come devono essere rappresentati e ripresi gli stati `human_approval`, `blocked`, `needs_replan` ed escalation? Definire owner, scadenza, resume command/event, autorizzazioni, idempotenza, audit e comportamento dopo riavvio o approvazione duplicata.

## Answer

Il runtime persiste almeno gli stati `pending`, `approved`, `rejected`, `expired`, `blocked`, `needs_replan`, `escalated` e `resolved`.

Ogni approval è legata a `run_id`, transizione, Playbook/versione, generation, evidence hash, approvatore e timestamp. Un'approval scaduta porta a `blocked`/escalation e non può approvare automaticamente.

Il rientro da `blocked` richiede un comando/evento esplicito e autenticato, con nuova idempotency key e rivalidazione di Playbook, generation e capability. In `blocked`, `needs_replan` o `escalated` non sono consentiti nuovi dispatch automatici.

Un'approval duplicata con lo stesso contesto è idempotente; un'approval in conflitto o riferita a generation/versione diversa viene rifiutata e auditata.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
