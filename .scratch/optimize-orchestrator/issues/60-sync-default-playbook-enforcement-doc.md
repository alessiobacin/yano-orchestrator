Type: human
Kind: task
Status: resolved
Blocked by: 43, 55, 56, 59

## Question

Allineare il default Playbook con le invarianti effettivamente applicate dal runtime.

## Acceptance Criteria

- Il documento distingue enforcement runtime da responsabilità ancora planner/prompt.
- Binding, evidence, transition generation, approval hold, outbox e actor gate sono elencati come runtime.
- Dispatch adapter e riconciliazione ticket/fase restano dichiarati incompleti.
- Il loader e gli smoke test continuano a validare il Playbook.

## Resolution

Aggiornati `playbooks/default.yaml` e `existing_runtime` con lo stato effettivo delle implementazioni correnti.
