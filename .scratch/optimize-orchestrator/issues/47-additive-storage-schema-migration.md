Type: task
Status: resolved
Blocked by: 19, 46

## Question

Portare i database esistenti al nuovo schema Playbook senza operare su layout parziali o versioni non supportate.

## Acceptance Criteria

- Il marker dello storage distingue la versione del database dalla versione config.
- Database v1 vengono migrati in modo additivo alle tabelle v2.
- Il marker viene avanzato solo dopo la riuscita del batch DDL.
- Versioni future o marker corrotti causano failure fail-fast.
- L’apertura resta idempotente e i flussi ticket/Playbook rimangono verdi.

## Resolution

Introdotto `YANO_STORAGE_SCHEMA_VERSION = 2`; `SQLiteOrchestratorStorage.init()` crea le tabelle additive, valida il marker e aggiorna v1→v2 solo dopo il DDL riuscito. Versioni future e valori non interi/inferiori a 1 vengono rifiutati.

Test verdi: `npm run check-syntax`; ticket engine — 67 assertion.
