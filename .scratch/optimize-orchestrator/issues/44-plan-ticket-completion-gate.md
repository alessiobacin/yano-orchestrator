Type: human
Kind: task
Status: resolved
Blocked by: 04, 12, 13, 43

## Question

Impedire che `plan_advance` completi una fase senza prova dei ticket persistenti associati.

## Resolution

`plan_advance` supporta `run_id` e `ticket_ids`; quando forniti richiede ticket non vuoti, appartenenti allo stesso run e tutti `done`. Il percorso legacy senza run resta compatibile per piani non collegati al ticket layer. Guardie e failure sono verificate da `smoke-test-plan-gate.mjs`; syntax e ticket engine restano verdi.
