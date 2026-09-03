# Avviare planner e altri agenti

Il planner è normalmente l'unico agente che avvii manualmente: seleziona il
team e delega coder, reviewer e specialisti tramite Herdr.

## Avviare il planner

~~~
yano start --instance planner-01 --role planner
~~~

Se hai scelto uno scope MQTT esplicito, usalo sempre:

~~~
yano start --instance planner-01 --role planner --project mio-progetto
~~~

## Avviare manualmente un worker

Questa procedura serve per test, recovery o diagnosi. Eseguila in una tab Herdr
dedicata del workspace corretto:

~~~
yano start --instance coder-01 --role coder
yano start --instance reviewer-01 --role reviewer
~~~

Per ruoli frontend:

~~~
yano start --instance frontend-developer-01 --role frontend-developer
yano start --instance frontend-reviewer-01 --role frontend-reviewer
~~~

Non avviare un secondo agente con lo stesso '--instance': l'identità è usata
per presenza MQTT, trace, ticket e tab Herdr.

## Controllare la flotta

~~~
yano fleet
yano status
yano logs
~~~

Se un agente deve collaborare con il planner, deve usare lo stesso progetto e
lo stesso broker. Uno scope diverso produce intenzionalmente una flotta MQTT
separata.

## Review visuale Agentation

Dopo `frontend-developer`, `frontend-reviewer` ed E2E, il planner deve chiedere
esplicitamente: “Vuoi fare una review visuale dell'app in sviluppo con
Agentation?”. Se accetti, esegue `yano frontend-review setup` per
installare/verificare `agentation` come devDependency e l'import/mount solo in
development, poi `yano frontend-review start` per avviare l'app. Deve fornire
l'URL reale restituito dal comando, non un URL ipotizzato. Puoi annotare la
pagina e il planner riceve le annotazioni tramite il server MCP `agentation`.
