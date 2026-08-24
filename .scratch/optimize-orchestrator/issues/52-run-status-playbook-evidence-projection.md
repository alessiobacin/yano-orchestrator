Type: human
Kind: task
Status: resolved
Blocked by: 13, 26, 46

## Question

Rendere le evidenze Playbook parte della proiezione durevole usata da resume e watchdog.

## Acceptance Criteria

- `run_status` espone le evidenze persistite del run.
- La proiezione non espone secret, ma solo requisito, sorgente, idempotency key e timestamp.
- Il dato è coerente con `playbook_evidence_list` dopo restart.
- Esiste una regressione black-box.

## Resolution

`run_status` ora include `playbook_evidence`; il producer non persiste i valori delle credenziali, quindi la proiezione resta redatta. Smoke ticket engine verifica la visibilità dell’evidenza durante il recovery flow.
