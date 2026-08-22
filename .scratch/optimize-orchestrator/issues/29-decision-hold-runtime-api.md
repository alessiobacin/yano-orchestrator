Type: grilling
Status: resolved
Blocked by: 27, 28

## Question

Quali API/tool runtime devono gestire il lifecycle di `decision_holds`? Definire create/get/list, answer/release, expiry sweep, autorizzazioni, generation/idempotency, eventi di resume, notifiche planner/utente e integrazione con `blocked`/`needs_replan` senza lasciare run ambigui.

## Answer

Il runtime espone `decision_hold_create`, `decision_hold_get`, `decision_hold_list`, `decision_hold_answer` e `decision_hold_cancel`; expiry è gestito automaticamente dal watchdog.

Solo il planner può creare o cancellare hold, solo l'utente autorizzato può rispondere e il runtime può scadere o bloccare. `decision_hold_answer` richiede `hold_id`, generation corrente, idempotency key e risposta; rifiuta hold chiusi o di generation diversa.

Una risposta valida pubblica un evento/outbox che risveglia il planner sullo stesso run senza modificare direttamente piano o DAG. Se implica una modifica qualitativa, il run entra in `needs_replan` e attende il planner.

Ogni create/answer/cancel/expire/resume produce un audit event ed è idempotente.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
