# yano gantt

Avvia il Gantt live del progetto. Ogni progetto riceve una porta libera stabile
nel range 10000-19999.

~~~bash
yano gantt --persistent --open
yano gantt --persistent --port 10055
yano gantt --link --json
yano gantt --links --json
~~~

La modalità persistent registra il link in
YANO_DATA_DIR/gantt/instances.json e mantiene il processo live in foreground.
--link restituisce il link del progetto corrente; --links elenca tutti i
progetti registrati.
