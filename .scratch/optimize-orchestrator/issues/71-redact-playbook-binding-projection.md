Type: human
Kind: task
Status: resolved
Blocked by: 18, 20, 65, 70

## Question

Impedire che lo snapshot immutabile del Playbook esponga secret nelle risposte di binding e status.

## Acceptance Criteria

- `playbook_bind` redige lo snapshot nella risposta.
- `run_status` redige `playbook_binding`.
- checksum, origin, id e schema version restano visibili.
- Lo storage mantiene lo snapshot completo per l’interprete.

## Resolution

Applicata `redactRuntimeProjection` alle projection di binding; il runtime continua a usare lo snapshot completo dallo storage.
