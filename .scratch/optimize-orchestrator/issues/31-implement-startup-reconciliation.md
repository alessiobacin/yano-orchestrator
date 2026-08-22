Type: task
Status: resolved
Blocked by: 13, 14, 30

## Question

Implementare la riconciliazione deterministica dello stato persistito al riavvio del planner.

## Resolution

Implementato in `extensions/orchestrator.ts`: `orchestrator_init` del planner esegue la scansione degli active run, rileva ticket running assegnati a istanze non presenti e decision hold aperti, persiste un checkpoint `reconcile_sweep` e registra l’evento omonimo. La riconciliazione è osservativa: non cancella, non riaccoda e non modifica ticket o hold. `run_status` espone ora anche i checkpoint persistiti.

Verifica: `node --experimental-strip-types scripts/smoke-test-reconciliation.mjs` — 7/7 assertion verdi.
