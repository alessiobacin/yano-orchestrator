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
temp/recovery/. Controlla lo stato:

~~~
yano recovery status
yano resume --all --dry-run
yano resume --all --yes
~~~

Il reload riguarda solo il progetto corrente. Non esiste un reload globale
implicito di tutti i progetti.
