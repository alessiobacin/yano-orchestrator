Type: human
Kind: task
Status: resolved
Blocked by: 02, 13, 24, 61

## Question

Impedire che il fast-path idempotente bypassi il fencing della generation.

## Acceptance Criteria

- La generation viene verificata prima del lookup dell’operazione idempotente.
- Un ack con generation obsoleta viene rifiutato anche se la chiave è già stata usata.
- Retry con generation corretta resta idempotente.

## Resolution

Spostato il controllo generation prima del fast-path `prior` in `ackPlaybookEffect`; aggiunta regressione su ack stale con chiave già usata.
