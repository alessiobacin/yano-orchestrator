# Trace e diagnosi

## Attivare il trace completo

~~~
yano trace enable --mode full
yano trace status
~~~

Il trace vive nella directory dati globale dell'utente, non nella repository del
progetto e non dentro il pacchetto installato. Il percorso è automatico per
macOS/Linux/Windows; usa `yano trace status` per vederlo. `YANO_DATA_DIR` è
soltanto un override opzionale, configurabile con `yano config set`.

Per seguire gli eventi mentre il team lavora:

~~~
yano trace events --follow
~~~

## Registrare il verdetto dell'utente

Risultato corretto:

~~~
yano trace feedback \
  --status accepted \
  --text 'Il task è corretto.' \
  --run <run-id> --round 1 --task <task-slug>
~~~

Risultato da correggere:

~~~
yano trace feedback \
  --status rejected \
  --text 'Manca la gestione del caso limite.' \
  --run <run-id> --round 1 --task <task-slug>
~~~

## Recuperare solo il contesto utile

~~~
yano trace context --run <run-id> --round 1 --task <task-slug> --json
yano trace index --project 'Mio Progetto' --run <run-id>
yano trace search \
  --project 'Mio Progetto' \
  --run <run-id> \
  --query 'errore di verifica' \
  --mode hybrid --limit 10 --json
~~~

Per una visione trasversale dei progetti:

~~~
yano trace overview --all-projects --json
~~~

Non cancellare il trace durante una diagnosi. Per la guida completa consulta
[yano trace](../yano-trace.md).
