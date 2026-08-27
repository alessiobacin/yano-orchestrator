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

Poi termina gli agenti del progetto via MQTT, libera le eventuali pane Herdr,
riusa o crea i workspace necessari, rilancia gli agenti osservati con lo scope
corretto (incluso planner-01) e verifica la nuova presence.

Il codice applicativo, i worktree, il database, i trace e le tab Herdr non
vengono cancellati.

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
