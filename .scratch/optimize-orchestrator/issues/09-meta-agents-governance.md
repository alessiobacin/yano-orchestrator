Type: human
Kind: grilling
Status: resolved
Blocked by: 01, 07, 08

## Question

Quali responsabilità, input/output, guardie e approvazioni devono avere l'agente che crea nuovi Playbook e l'agente che crea/pro­pone nuovi agenti per `roles.yaml`? Definire sandbox, validazione automatica, human approval, versionamento, rollback e divieto di auto-estendere capability o permessi senza controllo.

## Answer

Sono previsti due ruoli distinti:

- `playbook-author`: propone nuovi Playbook o nuove versioni;
- `role-definition`: propone nuovi agenti e relative capability in `roles.yaml`.

Entrambi operano esclusivamente in sandbox e producono proposte; non possono attivare direttamente Playbook, ruoli o capability.

La pipeline obbligatoria è: proposta → validazione sintattica e schema → capability preflight → review → human approval → attivazione/versionamento.

`role-definition` deve rifiutare skill, CLI, MCP o credenziali non verificate, con secret hardcoded o non isolabili per ruolo. I meta-agenti non possono modificare sé stessi, i propri permessi o il proprio Playbook senza human approval esplicita.

Le nuove versioni sono attivabili solo dopo approvazione. In caso di regressione, il runtime può disattivare la versione nuova e tornare all'ultima versione approvata; i run già avviati restano legati alla versione con cui sono partiti.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
