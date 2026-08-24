Type: human
Kind: task
Status: resolved
Blocked by: 12, 24, 43, 54

## Question

Impedire che il planner confermi effetti esterni senza un adapter autorizzato.

## Acceptance Criteria

- `audit` e `human_approval` possono essere chiusi dal planner secondo i gate dedicati.
- `notification` e `mqtt_event` richiedono il ruolo `effect-adapter`.
- Il tool non esegue shell o effetti arbitrari.
- Un ack forgiato dal planner viene rifiutato senza mutare l’outbox.
- Retry dell’ack audit resta idempotente.

## Resolution

`playbook_effect_ack` accetta planner/effect-adapter, ma il storage richiede esplicitamente `effect-adapter` per `notification` e `mqtt_event`. Il default Playbook include una notification effect e lo smoke verifica sia il rifiuto del planner sia l’ack positivo dell’adapter autorizzato.
