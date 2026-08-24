Type: human
Kind: task
Status: resolved
Blocked by: 20, 43, 65

## Question

Impedire che i tool diretti degli effect bypassino la redazione applicata a `run_status`.

## Acceptance Criteria

- `playbook_effect_list` redige payload sensibili.
- `playbook_effect_ack` redige il payload nella risposta.
- Storage e ack lifecycle restano invariati.
- Il testo breve del tool non contiene payload.

## Resolution

Applicata `redactRuntimeProjection` alle risposte list/ack degli effect Playbook.
