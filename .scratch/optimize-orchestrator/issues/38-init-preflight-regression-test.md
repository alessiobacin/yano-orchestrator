Type: task
Status: resolved
Blocked by: 36, 37

## Question

Aggiungere una regressione automatizzata per il contratto “preflight prima delle scritture” di `yano init`.

## Resolution

Aggiunto `scripts/smoke-test-init-preflight.mjs`: simula `pi` assente tramite PATH controllato e verifica exit code 1, diagnostica, messaggio di rollback e target completamente vuoto. Test verde con 4 assertion.
