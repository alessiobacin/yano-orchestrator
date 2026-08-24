Type: human
Kind: task
Status: resolved
Blocked by: 20, 24, 65, 71

## Question

Impedire che la risposta di `playbook_transition` esponga payload effect sensibili.

## Acceptance Criteria

- La risposta conserva from/to, transition id e generation.
- Effect id, kind e approval hold id restano leggibili.
- Payload sensibili vengono redatti ricorsivamente.
- Lo storage e l’interprete usano ancora il risultato completo internamente.

## Resolution

Applicata `redactRuntimeProjection` al dettaglio restituito da `playbook_transition`.
