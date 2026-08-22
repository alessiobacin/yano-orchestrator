Type: grilling
Status: resolved
Blocked by: 01

## Question

Quali vincoli strutturali deve imporre il codice per garantire il passaggio planner → coder → reviewer → planner, inclusi round di correzione, task frontend e specialisti? Definire autorizzazioni per ruolo, transizioni lecite, prove di handoff, rifiuto di chiamate premature e trattamento dei task non-code senza affidarsi solo ai prompt.

## Answer

Nel flusso code le sole transizioni normali sono `planner → coder → reviewer → planner`; il runtime rifiuta handoff diretti come `coder → planner` o `planner → reviewer` quando non previsti dal Playbook.

Un rifiuto del reviewer crea il loop `reviewer → coder → reviewer` sullo stesso ticket e nella stessa fase, con budget di round configurabile nel Playbook. Il superamento del budget segue le failure semantics e porta a replanning o escalation.

`frontend-developer` segue lo stesso gate coder → reviewer e non può chiudere direttamente il ticket. Gli specialisti possono lavorare in parallelo e produrre evidenze o segnalazioni, ma la chiusura resta responsabilità del percorso coder/reviewer/planner.

I task non-code non vengono forzati nel percorso coder: il Playbook deve poter selezionare un percorso alternativo esplicito, con validator/reviewer adeguato. Sono previsti Playbook aggiuntivi e un agente specializzato nella loro creazione. È inoltre previsto un agente specializzato nella proposta di nuovi agenti per `roles.yaml`, basata sulla ricerca delle skill, CLI, MCP e capability effettivamente necessarie e verificabili.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
