Type: human
Kind: grilling
Status: resolved
Blocked by: 02, 03

## Question

Come deve funzionare il watchdog come control loop deterministico fuori dal turno LLM? Definire segnali osservati, classificazione offline/stall/timeout, terminate, recovery, escalation, idempotenza degli sweep, intervalli, metriche e garanzia che run completati non restino senza finalize/notifica.

## Answer

Il watchdog osserva presenza MQTT/LWT, heartbeat, lease/fencing, ultimo progresso del ticket, outbox/inbox pendenti, stato del run e ticket completati, oltre a finalize e notifiche mancanti dopo il completamento.

Le soglie di stall, offline, timeout, terminate e grace period sono configurabili nel Playbook, con default globali validati.

Come control loop deterministico, il watchdog può scadere lease, terminare agenti bloccati, fallire o reinserire ticket secondo policy, riassegnare a un nuovo worker e ritentare outbox/inbox. Non può inventare un piano: quando serve una decisione qualitativa notifica il planner e porta il run nello stato previsto dal Playbook.

Se tutti i ticket sono completati ma finalize o notifica non sono avvenuti, il watchdog riattiva automaticamente il percorso di finalize, senza trasformare la propria logica operativa in una nuova decisione qualitativa.

Ogni sweep è idempotente, persistito e protetto da un lease del supervisore per impedire watchdog concorrenti.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
