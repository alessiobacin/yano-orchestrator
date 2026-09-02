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

Scope MQTT: di default lo scope è derivato dalla root del progetto
(projectKey); `--project-scope <scope>` lo sovrascrive sul wire — l’istanza
pubblica/sottoscrive (presenza, comandi, risposte, team, LWT) su
`pi/<scope>/**`. Esempio: i servizi di sistema girano su
`yano start ... --project-scope yano-system` (scope stabile `pi/yano-system/**`).
Lo scope è usato così com’è nei topic: niente spazi o "/" se non vuoi topic
nidificati.
