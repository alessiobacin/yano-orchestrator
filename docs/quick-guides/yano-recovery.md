# Pause e ripristino dei task

Yano separa la pausa dalla chiusura del task. `yano end` chiude un run; `yano
pause` salva invece uno snapshot e conserva run, ticket, branch e worktree nello
stato in cui si trovano.

## Pausa sicura

Dal progetto interessato:

```bash
yano pause --project code-mem --all --yes
yano recovery status --project code-mem
```

Per un solo run usare `--run <run-id>`. Il comando:

1. legge il database del progetto, anche se appartiene a un layout Yano
   precedente;
2. raccoglie ticket `running`/`pending`, presenza MQTT e stato Git;
3. salva `snapshot.json`, copia del database e WAL/SHM disponibili e gli
   eventi trace osservabili sotto `<YANO_DATA_DIR>/recovery/`;
4. crea un checkpoint e un evento `run_paused` senza modificare lo status del
   run o dei ticket;
5. con `--yes`, invia ai processi presenti un `terminate` graceful. Non usa
   `kill`, non cancella tab, worktree, branch o ticket.

Senza `--yes` il checkpoint viene comunque scritto, ma nessun agente viene
fermato. È utile per verificare il contenuto prima dello stop.

## Anteprima e ripristino

Prima di avviare processi:

```bash
yano resume --project code-mem --all --dry-run
```

Il comando confronta la presenza MQTT corrente con:

- gli agenti osservati nello snapshot;
- gli agenti assegnatari dei ticket `running`;
- `planner-01` e il roster locale.

Per eseguire il ripristino:

```bash
yano resume --project code-mem --all --yes --supervisor auto
```

Gli agenti vengono avviati esclusivamente in tab Herdr del workspace del
progetto. Se il server Herdr non è disponibile, il comando si ferma e segnala
il prerequisito mancante. Il planner viene aperto con `--continue` e riceve un
messaggio che gli impone di verificare run, ticket, worktree e agenti prima di
continuare. Gli agenti già vivi non vengono duplicati. I ticket `done` non
vengono rilanciati e i ticket non assegnati restano una decisione del planner.

Per collegarsi a una sessione:

Usa direttamente l'interfaccia Herdr per focalizzare la tab dell'istanza.

## Aggiornamento con reload controllato

`yano update` aggiorna il pacchetto globale, la copia dell'estensione Pi e
sincronizza `pi update --extensions`, ma un processo Pi già attivo continua a
usare il codice caricato in memoria. Per applicare il nuovo codice alle
istanze del progetto corrente usare:

```bash
yano update --reload --dry-run
yano update --reload --yes
```

Il reload non è un hot-reload. Verifica Herdr, broker, database e run attivi,
chiede agli agenti di raggiungere un safe point, salva snapshot con presenza
MQTT, ticket, Git, trace, workspace/tab/pane Herdr e versione Yano, invia
`terminate` graceful, aggiorna entrambe le copie di Yano, riusa le tab Herdr e
riapre gli agenti mancanti tramite `resume`. Il planner viene avviato con
`--continue` e riconcilia ticket, worktree e assegnazioni.

```bash
yano update --reload --yes --timeout 180
yano update --reload --yes --force
```

`--timeout` è espresso in secondi e vale per safe point e verifica finale.
`--force` salta l'attesa del safe point e va usato solo accettando la possibile
interruzione dell'operazione corrente. Il reload è limitato al progetto
corrente e non chiude né duplica le tab Herdr.

Gli snapshot e l'esito del reload sono in:

```text
<YANO_DATA_DIR>/recovery/<progetto>/<run>/<timestamp>/
```

La ripresa è semantica: eventi, output dei tool, report, ticket, checkpoint e
worktree sono ripristinabili; i token interni di una generazione LLM già
interrotta non lo sono. In caso di errore nell'aggiornamento gli agenti restano
in pausa e il comando indica lo snapshot da usare con `yano resume`.

## Stato e limiti

```bash
yano recovery status --project <nome>
yano status --project <nome>
yano fleet --project <nome>
```

La presenza MQTT è un'indicazione live, non una prova storica: l'evidenza
storica viene dal checkpoint, dal database, dal Git worktree e dal trace. Se il
broker non è raggiungibile, la pausa salva comunque la parte locale e segnala
che la presenza non è stata acquisita.

Un ripristino non risolve automaticamente un ticket lasciato `running` se il
codice del worker ha fallito: riapre l'istanza corretta e lascia al planner la
decisione di verificare, riprovare o re-accodare il ticket secondo le regole
del progetto.
