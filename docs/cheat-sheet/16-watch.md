# yano watch

Esegue il controllo del flusso di un progetto. Con --once esegue una sola
scansione, utile per i test.

~~~bash
yano watch --project-root "$PWD" --once
yano watch --project-root "$PWD" --lookback-ms 3600000 --interval-ms 300000
yano watch --project-root "$PWD" --validation-run RUN_ID --playbook-proposal PROP_ID --once
~~~

Per sapere su quali progetti è attivo il worker usare yano watcher projects
--all --json.
