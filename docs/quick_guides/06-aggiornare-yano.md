# Aggiornare Yano

## Aggiornamento normale

Controlla prima se è disponibile una versione nuova:

~~~
yano update --check
~~~

Aggiorna l'installazione globale, la copia Git usata da pi extension install
e sincronizza le estensioni Pi:

~~~
yano update
~~~

Questo comando non riavvia le istanze Pi già aperte. I processi attivi
continuano a usare il codice caricato in memoria; applica il nuovo codice al
prossimo avvio.

Se Yano è stato installato in sviluppo con `npm link`, il comando rileva il
symlink, lo rimuove e installa una copia globale permanente da GitHub. Così un
commit locale non cambia più il comportamento di `yano` prima di un update
esplicito. Verifica con `npm ls -g yano-orchestrator --depth=0`: una copia
permanente non mostra `->` verso il checkout.

L’aggiornamento scarica il repository con Git, costruisce un tarball temporaneo
e installa quello. Questa scelta evita che configurazioni npm locali come
`allow-scripts` interferiscano con la preparazione di dipendenze Git.

## Aggiornare e ricaricare il team attivo

Dalla root del progetto interessato:

~~~
yano update --reload --dry-run
yano update --reload --yes
~~~

Il secondo comando attende safe point, salva lo stato, aggiorna Yano, riusa le
tab Herdr, riapre gli agenti e verifica la versione runtime.

Per un task lento:

~~~
yano update --reload --yes --timeout 180
~~~

Usa '--force' solo se accetti di interrompere l'operazione corrente:

~~~
yano update --reload --yes --force
~~~

## Se il reload fallisce

Gli agenti vengono lasciati in pausa e lo snapshot resta nella cartella globale
`<YANO_DATA_DIR>/recovery/` (usa `yano trace status` per il percorso effettivo).
Controlla lo stato:

~~~
yano recovery status
yano resume --all --dry-run
yano resume --all --yes
~~~

Il reload riguarda solo il progetto corrente. Non esiste un reload globale
implicito di tutti i progetti.

## Progetto incoerente o agenti con scope vecchio

Se fleet mostra agenti con un vecchio nome progetto, il database manca o le
tab Herdr sono rimaste disallineate, usa il comando di riconciliazione:

~~~
yano repair --dry-run
yano repair --yes --update
~~~

repair salva uno snapshot prima di fermare gli agenti e non cancella trace,
database, worktree o codice applicativo. Dopo che l'istanza canonica è pronta
può chiudere soltanto eventuali copie stale duplicate di Planner, Architect o
Watcher dello stesso progetto; non chiude worker applicativi o tab di altri
progetti. La guida completa è in
[17-ripristino-automatico](./17-ripristino-automatico.md).
