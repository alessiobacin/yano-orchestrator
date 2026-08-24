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
