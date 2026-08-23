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
   eventi trace osservabili sotto `<installazione-yano>/temp/recovery/`;
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
