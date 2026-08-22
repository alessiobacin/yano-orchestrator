Type: task
Status: resolved
Blocked by: 12, 18, 24, 43

## Question

Impedire che un Playbook introduca effect kind non supportati dal runtime.

## Acceptance Criteria

- Il loader applica una allowlist esplicita degli effect kind.
- Un kind sconosciuto fallisce prima del binding e non muta il run.
- La allowlist include gli effect kind previsti dal contratto corrente.
- Esiste una regressione loader fail-fast.

## Resolution

Aggiunta allowlist `audit`, `human_approval`, `mqtt_event`, `notification` in `scripts/playbook-loader.mjs`; effect kind arbitrari vengono rifiutati. Smoke loader aggiornato con caso negativo.
