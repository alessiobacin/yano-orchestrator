Type: task
Status: resolved
Blocked by: 02, 13, 24, 56

## Question

Garantire che una transizione concorrente non produca audit o effect se il cambio di stato fenced non è avvenuto.

## Acceptance Criteria

- L’update runtime usa generation fencing.
- Il numero di righe aggiornate viene verificato.
- Zero righe aggiornate causa rollback completo di hold, outbox e audit.
- Una transizione valida continua a produrre esattamente un cambio di stato.

## Resolution

`transitionPlaybook` verifica `changes === 1` dopo l’update fenced e fallisce nella transazione prima di creare effect/hold/audit se rileva una race. Lo smoke ticket engine esegue due transizioni concorrenti sulla stessa generation: una sola riesce.
