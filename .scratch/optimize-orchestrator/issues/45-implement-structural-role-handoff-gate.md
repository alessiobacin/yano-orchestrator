Type: task
Status: resolved
Blocked by: 05, 21

## Question

Imporre nel runtime il percorso code `planner → coder/frontend-developer → reviewer → planner`, consentendo il loop `reviewer → coder/frontend-developer` per le correzioni e rifiutando gli shortcut.

## Destination

Specifiche di riferimento: [spec.md](../spec.md) e [gate strutturali tra ruoli](05-structural-role-gates.md).

## Acceptance Criteria

- `planner → reviewer` viene rifiutato per i task con piano strutturato.
- `coder/frontend-developer → planner` viene rifiutato.
- `reviewer → coder/frontend-developer` e `reviewer → planner` sono consentiti.
- Ruoli specialistici e percorsi non-code non vengono reinterpretati come percorso code implicito.
- Il rifiuto avviene prima della pubblicazione MQTT e non muta lo stato del task.
- Esiste una regressione black-box del gate e restano verdi i flussi esistenti.

## Resolution

Implementato `assertRoleHandoffAllowed` in `extensions/orchestrator.ts`, integrato nel controllo strutturato di `agent_send`. La matrice è applicata solo ai ruoli core e solo quando il task dichiara un piano; i ruoli non-core restano governati dal piano/Playbook esplicito. Aggiunte asserzioni al test `scripts/smoke-test-plan-gate.mjs` per shortcut, loop di correzione e percorso specialistico.

Test verdi:

- `npm run check-syntax`
- `node scripts/smoke-test-plan-gate.mjs`
- `node --experimental-strip-types scripts/smoke-test-ticket-engine.mjs` — 60 assertion
