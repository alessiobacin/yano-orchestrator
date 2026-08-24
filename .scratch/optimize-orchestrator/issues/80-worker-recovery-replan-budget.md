# 80 — Recovery worker e budget di replan

Type: human
Kind: task

**What to build:** Un worker offline può essere sostituito sul ticket esistente e il runtime applica budget bounded a retry e replan.

**Blocked by:** 03, 14, 26, 75

**Status:** resolved

- [ ] La sostituzione conserva ticket, run e generazione logica senza duplicare il lavoro.
- [ ] Retry, round e replan hanno contatori e fencing persistiti.
- [ ] Budget esaurito produce escalation e stop dei dispatch con causa consultabile.

## Answer

Implementati `ticket_requeue` e `ticket_recovery_get` con tabella durevole di
retry/replan budget, recovery generation, ultimo failure e stato exhausted.
Un worker fallito può essere sostituito mantenendo lo stesso ticket; il budget
esaurito lascia il ticket failed, marca il run failed e registra il checkpoint
`recovery_budget_exhausted`, impedendo ulteriori dispatch.

Smoke ticket engine verde con 104 assertion.
