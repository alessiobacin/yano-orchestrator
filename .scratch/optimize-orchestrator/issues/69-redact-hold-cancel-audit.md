Type: task
Status: resolved
Blocked by: 15, 20, 68

## Question

Evitare che il testo libero di cancellazione di un decision hold venga copiato nell’event log.

## Acceptance Criteria

- L’audit conserva hold id, generation e idempotency key.
- Il testo `reason` non viene persistito nell’evento.
- L’audit indica se una reason era stata fornita.
- Il comportamento del lifecycle non cambia.

## Resolution

Sostituito `reason` con `reason_provided` nell’evento `decision_hold_cancelled`; il testo resta fuori dall’audit persistente.
