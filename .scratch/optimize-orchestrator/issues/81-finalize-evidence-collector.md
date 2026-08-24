# 81 — Finalize evidence collector completo

Type: human
Kind: task

**What to build:** Il finalize raccoglie evidenze verificabili e separate per test, workspace, commit, merge e push, impedendo di dichiarare completato ciò che non è stato osservato.

**Blocked by:** 15, 20

**Status:** resolved

- [ ] Adapter allowlisted raccolgono evidenze redatte e legate al worktree/commit osservato.
- [ ] Modifiche successive invalidano automaticamente le evidenze diventate stale.
- [ ] Test, commit, merge e push restano passaggi distinti, idempotenti e auditati.

## Answer

Implementati `finalize_evidence_collect` e `finalize_evidence_list` con
evidence tipizzate `test`, `workspace`, `commit`, `merge` e `push`. Commit e
workspace vengono osservati dal worktree reale; test/merge/push richiedono una
osservazione esplicita dell'adapter. Le evidence sono idempotenti, persistite,
redatte e precedenti evidence verificate diventano `stale` quando cambia il
commit osservato.

Smoke reconciliation verde con 13 assertion.
