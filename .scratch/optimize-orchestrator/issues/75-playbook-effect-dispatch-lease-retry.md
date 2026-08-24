# 75 — Dispatcher effetti Playbook: lease, fencing e retry bounded

Type: human
Kind: task
Status: resolved  
Blocked by: 43, 59, 61, 62

## Question

Come impedire doppio dispatch e retry illimitati degli effetti esterni del
Playbook dopo crash o riavvio dell'adapter?

## Answer

La tabella `playbook_effect_outbox` ora persiste `delivery_state`, tentativi,
lease owner/token/scadenza, errore e prossimo tentativo. `playbook_effect_claim`
acquisisce una lease atomica e fenced; `playbook_effect_fail` accetta soltanto
il proprietario della lease non scaduta e porta l'effetto a retry oppure
`dead_letter` quando raggiunge `max_attempts`. L'ack esistente invalida la lease
e marca l'effetto `delivered`.

La migrazione storage v2→v3 è additiva e il dispatcher resta adapter-only: il
planner non può acquisire o fallire effetti esterni. Gli eventi di lease e
failure sono persistiti nell'audit.

Verifiche: controllo sintassi, ticket engine smoke con 90 assertion e smoke
loader/reconciliation già verdi.
