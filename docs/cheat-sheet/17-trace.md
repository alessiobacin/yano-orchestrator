# yano trace

Gestisce tracing, eventi, indicizzazione semantica e recupero dei dati.

~~~bash
yano trace status
yano trace enable --mode full
yano trace events --project sales-companion --limit 20 --json
yano trace context --project sales-companion --since 2026-08-27T00:00:00Z --json
yano trace index --all-projects --json
yano trace search --query "planner bloccato" --mode hybrid --limit 10 --json
yano trace overview --all-projects --json
~~~

Se il planner promette un test senza eseguirlo, cerca
`planner_action_claim_without_tool` e `planner_action_guard_wakeup` nel trace.
`planner_action_guard_exhausted` indica che il follow-up correttivo ha raggiunto
il limite senza una tool call osservabile.

Per cancellare dati usare sempre yano trace clear con il flag esplicito --yes.
Per esportare o importare un trace usare yano trace export/import.
