Type: task
Status: resolved
Blocked by: 10, 20, 52, 64

## Question

Evitare che la projection `run_status` ristampi secret presenti nei context dei decision hold o nei payload degli effect.

## Acceptance Criteria

- Chiavi sensibili vengono redatte nella projection runtime.
- Lo storage auditabile resta invariato.
- ID, status, generation e idempotency key non vengono inutilmente rimossi.
- La redazione è ricorsiva per mapping e array.

## Resolution

Aggiunta `redactRuntimeProjection` con redazione ricorsiva di `secret`, `password`, `token`, `authorization`, `api_key` e `private_key`; applicata a hold ed effect in `run_status`.
