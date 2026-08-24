Type: human
Kind: task
Status: resolved
Blocked by: 02, 13, 46

## Question

Garantire che il retry idempotente della registrazione evidence non duplichi l’audit.

## Acceptance Criteria

- La stessa chiave evidence restituisce lo stesso record.
- Il retry non crea un secondo record.
- Il retry non crea un secondo evento `playbook_evidence_recorded`.
- Un nuovo idempotency key continua a produrre una nuova evidence distinta.

## Resolution

`recordPlaybookEvidence` ora restituisce `created`; il tool registra l’evento solo quando l’inserimento è nuovo. Smoke ticket engine verifica record e audit deduplicati.
