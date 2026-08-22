Type: grilling
Status: resolved
Blocked by: 15

## Question

Come deve raccogliere e validare il runtime le evidenze di test, version bump, docs-sync, approvazioni, report, branch e commit prima di `worktree_finalize`? Definire adapter per progetto, output redaction, prove non-applicabili, invalidazione dopo nuovi commit e audit trail di merge/push.

## Answer

Ogni progetto dichiara adapter e comandi verificabili per test, version bump e docs-sync. `not_applicable` è ammesso solo con motivazione, approvazione planner/reviewer e regola di progetto che dimostri l'inapplicabilità.

Ogni evidenza contiene almeno `kind`, `command/action`, `inputs`, `exit_code`, stdout/stderr redatti, `timestamp`, `commit_sha`, `worktree`, `result` e `reason`.

Se il commit cambia dopo la raccolta, tutte le evidenze del worktree diventano `stale` e il collector le riesegue. Secret e dati sensibili sono redatti da output, report, eventi e audit trail.

Merge e push producono record audit separati con commit prima/dopo, branch remoto, timestamp, actor, risultato e idempotency key.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
