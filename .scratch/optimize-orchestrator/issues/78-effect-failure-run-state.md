# 78 — Failure degli effetti e dead-letter runtime

Type: human
Kind: task

**What to build:** Un effetto esterno che supera il budget di retry porta il run a uno stato operativo bounded e conserva l'audit necessario al replan.

**Blocked by:** 03, 24, 59, 75

**Status:** resolved

- [ ] Il dead-letter di un effetto aggiorna atomicamente lo stato operativo del run.
- [ ] Il runtime distingue failure retryable, permanente e non autorizzata.
- [ ] Il passaggio a `blocked`/`needs_replan` ferma nuovi dispatch senza perdere outbox o audit.

## Answer

Integrato il dead-letter con il runtime Playbook: quando un effetto raggiunge
`max_attempts`, il run passa atomicamente allo stato Playbook `blocked` quando
disponibile, registra un checkpoint `playbook_failure` con classe, causa e
tentativi e conserva l'evento audit. Se il Playbook non espone lo stato
`blocked`, il run viene marcato `failed` con outcome `needs_replan`.

Il claim rifiuta dispatch su run non attivi o bloccati e l'ack rifiuta effetti
dead-lettered. Smoke ticket engine verde con 97 assertion.
