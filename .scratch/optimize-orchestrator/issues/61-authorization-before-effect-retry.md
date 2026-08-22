Type: task
Status: resolved
Blocked by: 02, 13, 59

## Question

Impedire che il fast-path idempotente bypassi l’autorizzazione dell’effect adapter.

## Acceptance Criteria

- L’identità viene verificata prima della ricerca dell’operazione idempotente già completata.
- Un planner non può riusare la chiave di un adapter per leggere/confermare un effect esterno.
- Retry dell’adapter autorizzato resta idempotente.

## Resolution

Spostato il controllo `effect-adapter` prima del fast-path `prior` in `ackPlaybookEffect`; aggiunta regressione planner retry con chiave già usata dall’adapter.
