Type: task
Status: resolved
Blocked by: 12, 24, 26, 55

## Question

Collegare l’effect Playbook `human_approval` al lifecycle persistente dei decision hold.

## Acceptance Criteria

- Un effect `human_approval` dichiarato apre un solo decision hold per generazione.
- Il hold contiene question, owner e contesto dichiarati.
- Creazione hold, state transition, outbox e audit sono atomici.
- Effect diversi da `human_approval` non aprono hold.
- Test black-box verifica apertura e persistenza del hold.

## Resolution

`transitionPlaybook` crea atomicamente il decision hold per gli effect `human_approval`, inserisce l’effect nell’outbox e registra l’audit. Il default Playbook dichiara il hold di conferma team; ticket engine verifica hold aperto e question persistita.
