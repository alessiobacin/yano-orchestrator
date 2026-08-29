# yano start

Avvia un agente Pi nel progetto corrente. Il ruolo determina prompt, skill e
strumenti assegnati.

~~~bash
yano start --instance planner-01 --role planner
yano start --instance coder-01 --role coder
yano start --instance reviewer-01 --role reviewer
yano start --instance planner-01 --role planner --project /percorso/progetto
~~~

Per i worker esterni usare i comandi dedicati (yano watcher, yano debugger,
yano auto-improve, yano suggester). Il titolo della tab Herdr coincide con
l’istanza.
