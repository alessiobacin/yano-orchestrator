# Yano: uso generale

Eseguire i comandi dalla root del progetto gestito, salvo i comandi esplicitamente
globali.

~~~bash
yano --help
yano --version
yano doctor --network
yano init --name "Nome progetto"
yano trace enable --mode full
yano start --instance planner-01 --role planner
yano projects --json
yano fleet --project-root "$PWD" --json
yano gantt --persistent --open
yano gantt --link --json
yano gantt --links --json
~~~

Regola pratica: prima doctor, poi init (se necessario), quindi trace e start. Il
Gantt usa una porta libera nel range 10000-19999.
