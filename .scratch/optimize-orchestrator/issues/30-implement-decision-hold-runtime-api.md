Type: human
Kind: task
Status: resolved
Blocked by: 29

## Question

Implementare il lifecycle runtime dei decision hold: tool create/get/list/answer/cancel, autorizzazioni, generation/idempotency, audit event, expiry watchdog e resume planner via outbox con `needs_replan` quando la risposta modifica il piano.

## Resolution

Implementato in `extensions/orchestrator.ts`: tool `decision_hold_create/get/list/answer/cancel`, autorizzazione planner/user, hold persistenti con context/answer/metadata JSON, generation fencing, idempotency key, audit SQLite/MQTT, expiry watchdog e outbox durevole per il resume planner con `needs_replan` esplicito. La creazione è deterministica sulla coppia `run_id + idempotency_key` e valida run/ticket.

Verifiche: `npm run check-syntax`, `npm run check-skill-isolation`, `node scripts/smoke-test-yano-status.mjs` — tutte verdi.
