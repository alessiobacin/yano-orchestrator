Type: human
Kind: task
Status: resolved
Blocked by: 12, 24, 54

## Question

Validare il payload degli effect dichiarati dal Playbook prima del binding runtime.

## Acceptance Criteria

- Ogni payload è una mapping, non un array o uno scalare.
- `human_approval` richiede `payload.question`.
- `mqtt_event` richiede `payload.topic`.
- `notification` richiede `payload.message`.
- Payload incompleti falliscono nel loader senza mutare il run.

## Resolution

Implementata la validazione per-kind nel loader e aggiunto smoke test per `human_approval` senza `question`.
