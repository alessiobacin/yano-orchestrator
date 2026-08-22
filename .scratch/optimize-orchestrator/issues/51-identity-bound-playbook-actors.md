Type: task
Status: resolved
Blocked by: 12, 24, 26

## Question

Impedire che il planner possa dichiarare arbitrariamente l’attore di una transizione Playbook.

## Acceptance Criteria

- `planner` e `runtime` sono invocabili solo dall’identità planner.
- `human` è invocabile solo dall’identità user.
- `team`, `planner_or_reviewer`, `planner_and_team` e `coder_or_specialist` applicano mapping runtime deterministici.
- Un actor forgiato viene rifiutato prima della transazione e non muta lo stato.
- Il flusso planner esistente resta verde.

## Resolution

`playbook_transition` ora vincola l’actor alla `identity.role`, supportando i composite actor dichiarati dal Playbook. Aggiunto smoke test che verifica il rifiuto di un planner che tenta di usare `human`.
