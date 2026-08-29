# yano watcher

Controlla periodicamente il flusso degli agenti senza modificare il progetto
applicativo.

~~~bash
yano watcher projects --all --json
yano watch --project-root "$PWD" --once
yano watch --project-root "$PWD" --lookback-ms 3600000 --interval-ms 600000
~~~

Il worker watcher rimane attivo nel workspace yano-watcher; --once consente un
controllo puntuale. Gli eventi di scansione finiscono nel trace.
