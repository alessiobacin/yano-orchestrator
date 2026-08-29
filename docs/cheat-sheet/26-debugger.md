# yano debugger

Gestisce segnalazioni e analisi di bug senza modificare direttamente la repo
applicativa.

~~~bash
yano debugger init --project-root "$PWD"
yano debugger start --project-root "$PWD" --once
yano debugger status --project-root "$PWD"
yano debugger report --project-root "$PWD" --title "Bug" --description "Dettagli"
yano debugger transition --project-root "$PWD" --bug-id BUG_ID --to triaged
~~~

Il planner riceve il problema e decide il successivo lavoro di sviluppo.
