Type: human
Kind: task
Status: resolved
Blocked by: 20, 46, 65, 72

## Question

Uniformare la redazione delle evidence nelle risposte dirette e nella projection `run_status`.

## Acceptance Criteria

- `playbook_evidence_record` non ristampa testo arbitrario oltre alla conferma breve.
- `playbook_evidence_list` redige i record.
- `run_status.playbook_evidence` usa la stessa policy.
- ID, source verificata e idempotency key restano disponibili.

## Resolution

Applicata `redactRuntimeProjection` alle tre superfici evidence; il testo del record non include più il requisito fornito dall’utente.
