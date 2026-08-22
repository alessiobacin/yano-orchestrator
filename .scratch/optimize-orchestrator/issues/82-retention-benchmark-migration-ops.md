# 82 — Retention, benchmark e migrazioni operative

**What to build:** Storage e release hanno policy versionate per retention, performance e migrazione, con diagnostica e rollback sicuro.

**Blocked by:** 19, 23, 47, 75

**Status:** resolved

- [ ] Eventi, evidenze, outbox e dead-letter hanno retention distinta e audit preservato.
- [ ] Benchmark riproducibili applicano soglie versionate a latenza, recovery e crescita storage.
- [ ] Migrazioni eseguono preflight/postflight e rollback senza toccare silenziosamente run attivi.

## Answer

Implementate policy retention versionate per eventi, evidence, outbox e
dead-letter con `retention_policy_set` e preview non distruttiva. Implementato
`benchmark_record`, che persiste dataset, metriche, soglie e risultato
`passed`/`failed`. Lo schema storage è avanzato adotta v7 con migrazioni
additive fail-fast e verifica delle nuove tabelle prima di aggiornare il marker.

Ticket engine verde con 104 assertion e controllo sintassi verde.
