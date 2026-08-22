# 79 — Approval multi-principal ed escalation

**What to build:** Approval ed escalation sono durevoli, vincolate al contesto del run e riprendibili solo da principal autorizzati.

**Blocked by:** 26, 29, 30, 75

**Status:** resolved

- [ ] Ogni approval è vincolata a principal, run, checksum e generation.
- [ ] Expiry, cancellazione ed escalation impediscono dispatch non autorizzati.
- [ ] Cambio responsabile e resume sono idempotenti e auditati.

## Answer

I decision hold Playbook persistono checksum, principal originario, principal
escalato e versione di escalation. È disponibile `decision_hold_escalate` con
generation, checksum e idempotency fencing; answer/cancel accettano il checksum
atteso e verificano il principal quando dichiarato. Expiry/cancel continuano a
impedire l'ack dell'effect approval.

Smoke ticket engine verde con 100 assertion: escalation, retry idempotente e
checksum obsoleto rifiutato verificati.
