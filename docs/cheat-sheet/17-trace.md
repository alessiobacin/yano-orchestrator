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

Per cancellare dati usare sempre yano trace clear con il flag esplicito --yes.
Per esportare o importare un trace usare yano trace export/import.
