Type: task
Status: resolved
Blocked by: 26, 29, 30, 56

## Question

Impedire che un effect `human_approval` venga chiuso prima della decisione associata.

## Acceptance Criteria

- Un effect approval con hold `open` rifiuta l’ack.
- Il hold risolto consente l’ack con generation e idempotency key corrette.
- Hold mancante per un effect approval produce failure fail-closed.
- Retry dell’ack resta idempotente.

## Resolution

`ackPlaybookEffect` risolve il hold deterministico derivato da run, transition, generation ed effect id e rifiuta l’ack finché il hold è `open` o mancante. Smoke ticket engine copre open → answered → dispatched.
