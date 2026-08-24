Type: human
Kind: task
Status: resolved
Blocked by: 26, 57

## Question

Distinguere una decisione approvata da un hold semplicemente chiuso per cancellazione, scadenza o blocco.

## Acceptance Criteria

- Solo `answered` consente l’ack dell’effect `human_approval`.
- `open`, `cancelled`, `expired` e `blocked` rifiutano l’ack.
- Il messaggio di failure espone lo stato corrente senza secret.

## Resolution

Il gate `ackPlaybookEffect` ora richiede esattamente `decision_holds.status = answered`; gli altri stati sono rifiutati fail-closed.
