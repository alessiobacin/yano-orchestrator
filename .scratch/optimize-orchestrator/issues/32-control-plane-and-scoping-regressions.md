Type: human
Kind: task
Status: resolved
Blocked by: 01, 03, 14

## Question

Ripristinare il control plane allow-listed e rendere deterministico il test di isolamento dei project scope MQTT.

## Resolution

Implementato `agent_control` in `extensions/orchestrator.ts`: verbi allow-listed, configurazione opzionale `config/control.json`, process operations planner-only, binari consentiti e nessuna shell arbitraria. Corretto inoltre `smoke-test-project-scoping.mjs` per usare instance id unici e non consumare retained status di test precedenti.

Verifiche: syntax check, control-plane smoke (6 assertion) e project-scoping smoke (7 assertion) verdi.
