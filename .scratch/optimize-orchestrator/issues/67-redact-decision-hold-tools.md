Type: human
Kind: task
Status: resolved
Blocked by: 20, 26, 65

## Question

Impedire che `decision_hold_get/list` bypassino la redazione applicata a `run_status`.

## Acceptance Criteria

- `decision_hold_get` redige context e resolution metadata sensibili.
- `decision_hold_list` applica la stessa redazione a ogni hold.
- Storage e lifecycle answer/cancel restano invariati.
- Nessun secret viene stampato nel testo del tool.

## Resolution

Applicata `redactRuntimeProjection` alle risposte dei tool `decision_hold_get` e `decision_hold_list`; il test precedente del hold Playbook continua a verificare status e question.
