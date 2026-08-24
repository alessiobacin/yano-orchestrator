Type: human
Kind: grilling
Status: resolved
Blocked by: 12, 18

## Question

Come deve interpretare il runtime una transizione Playbook? Definire valutazione deterministica delle guardie, ordine delle azioni, precondizioni/postcondizioni, commit atomico, effetti asincroni, errori di schema e gate che impediscono al planner o a un worker di bypassare la macchina a stati.

## Answer

Guardie e condizioni usano un linguaggio dichiarativo limitato e validato; il Playbook non può eseguire JavaScript o codice arbitrario.

L'ordine della transizione è: validate event → evaluate guards → validate preconditions → persist state/generation/idempotency/outbox atomically → execute delivery/effect → await acknowledgement → commit result.

Gli effetti esterni asincroni hanno uno stato intermedio esplicito, come `effect_pending`, e impediscono la transizione successiva fino ad acknowledgement o applicazione della failure policy.

Un errore di azione causa rollback dello stato transazionale e applicazione della recovery policy, senza avanzamento parziale. Eventi concorrenti sullo stesso run sono serializzati dal runtime tramite lease del run e fencing token.

I tool del planner e dei worker producono solo intenti/eventi sottoposti all'interprete; non possono mutare direttamente lo stato del Playbook.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
