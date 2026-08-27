# Ripristino automatico di un progetto

Usa 'yano repair' quando un progetto mostra agenti Herdr ancora presenti ma
con scope MQTT sbagliato, versioni runtime diverse, Planner non visibile o
tab rimaste da una vecchia sessione.

## Prima controlla cosa verrebbe fatto

Dalla root del progetto:

~~~
cd /percorso/progetto
yano repair --dry-run
~~~

Il comando rileva:

- nome canonico e alias MQTT eventualmente rimasti;
- agenti Herdr che lavorano dalla stessa directory;
- database locale e proposte Architect persistite;
- broker e presence retained;
- versione Yano in uso.

## Riparazione normale

~~~
yano repair --yes
~~~

Yano salva prima uno snapshot in:

~~~
<YANO_DATA_DIR>/recovery/repair/<progetto>/
~~~

Poi termina gli agenti del progetto via MQTT, riusa o crea i workspace necessari,
avvia gli agenti direttamente con `herdr agent start` e attende la loro
readiness prima di verificare la nuova presence. Planner, Architect e Watcher
mantengono rispettivamente l'identità visibile `planner-01`,
`architect-<project-name>` e `watcher-<project-name>`; il nome tecnico Herdr è
project-scoped per evitare collisioni tra progetti.

Il codice applicativo, i worktree, il database e i trace non vengono cancellati.
Quando una nuova istanza canonica è pronta, `repair` può chiudere soltanto le
copie stale duplicate di Planner, Architect o Watcher dello stesso progetto.
Non chiude i worker applicativi e non tocca tab di altri progetti. Per forzare
la chiusura di un processo che non risponde serve esplicitamente `--force`.

Se il progetto non ha ancora il database operativo, puoi far creare soltanto
lo schema corrente senza cancellare nulla:

~~~
yano repair --yes --init-db
~~~

Questo non crea un run né ticket: il Planner deve ancora chiamare
`orchestrator_init` e `run_create`.

## Riparazione con aggiornamento

~~~
yano repair --yes --update
~~~

Prima controlla se esiste una versione nuova. Se sì, esegue l'aggiornamento
normale di Yano e pi update --extensions, quindi riavvia tutti gli agenti
osservati con il codice aggiornato. Se non esiste una versione nuova, esegue comunque il
riallineamento degli agenti.

Se il primo stop non libera una pane:

~~~
yano repair --yes --update --force
~~~

force va usato soltanto quando accetti di interrompere un’operazione LLM
ancora in corso.

## Dopo il ripristino

~~~
yano doctor --network
yano fleet --project-root "$PWD" --json
yano trace status
~~~

Gli agenti Architect e Watcher vengono rinominati con lo schema canonico e
ricevono un prompt di riallineamento. Se esiste una proposta Architect salvata
nella directory globale, Yano può ri-provisionarla quando non c’è una sessione
esterna da riprendere; se la proposta non esiste più, il Planner riceve il
contesto e decide se ricreare correttamente il flusso.

## Ripristino di tutti i progetti attivi

Prima mostra l’inventario globale senza fermare nulla:

~~~
yano repair --all-projects --dry-run
~~~

Se l’inventario è corretto, applica il ripristino sequenziale:

~~~
yano repair --all-projects --yes --update
~~~

L’operazione include i worker esterni registrati per progetto (`debugger`,
`auto-improver` e `suggester`) e non riattiva worker esplicitamente in pausa o
fermati. Ogni progetto riceve uno snapshot separato; il comando non indovina
la root di un semplice scope MQTT sconosciuto e non modifica il codice.
