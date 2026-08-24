Type: human
Kind: task
Status: resolved
Blocked by: 13, 26, 52, 56

## Question

Esporre in un’unica superficie di recovery tutti gli oggetti durevoli del runtime Playbook.

## Acceptance Criteria

- `run_status` espone evidence, effect outbox e decision hold.
- La proiezione mantiene payload e secret redatti secondo i contratti dei producer.
- Il dato è leggibile dopo restart e non è una projection calcolata da MQTT.
- Smoke test verifica la presenza delle tre proiezioni.

## Resolution

Aggiunti `playbook_effects` e `decision_holds` a `run_status`, accanto a `playbook_evidence`, `playbook_binding` e `playbook_state`.
