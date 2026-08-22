Type: grilling
Status: resolved
Blocked by: 01, 04

## Question

Quale schema eseguibile deve avere il Playbook per rappresentare stati canonici, eventi, guardie, azioni idempotenti, invarianti, budget di riallineamento e `human_approval`? Definire validazione, compatibilità/versioning e condizioni deterministiche di blocco quando il realignment non è possibile.

## Answer

Ogni Playbook eseguibile contiene almeno `id`, `version`, `schema_version`, stati canonici, eventi ammessi, transizioni con `from`/`event`/`to`, guardie e azioni, invarianti, policy di retry/recovery, policy `human_approval`, limiti di realignment e capability/ruoli richiesti.

Il runtime rifiuta l'intero Playbook se manca un campo obbligatorio, una transizione punta a uno stato inesistente o un'invariante è incoerente. Non sono ammessi fallback a interpretazioni del prompt.

Il realignment automatico ha un massimo configurabile di tentativi e/o tempo. Se non converge, il run entra in `blocked`/`needs_replan` secondo il contratto di failure.

Ogni azione con effetti esterni dichiara un'idempotency key derivata dal contesto persistito, inclusi `run_id`, `ticket_id`, generazione e azione. `human_approval` è un record persistito con approvatore, timestamp, transizione approvata, versione del Playbook ed eventuale scadenza.

Un Playbook usato da un run è immutabile. Ogni modifica a stati, transizioni, invarianti o policy richiede una nuova versione.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
