# Nuovo progetto: avvio manuale

Usa questa procedura quando vuoi inizializzare la repository e decidere tu in
quale terminale avviare il planner.

## 1. Creare la repository

~~~
mkdir mio-progetto
cd mio-progetto
git init
~~~

## 2. Inizializzare Yano

~~~
yano init --name "Mio Progetto"
~~~

'yano init' crea solo l'infrastruttura Yano mancante. Non sovrascrive il codice
dell'applicazione.

## 3. Avviare il broker e il trace

~~~
docker compose -f mqtt/compose.yaml up -d
yano trace enable --mode full
yano trace status
~~~

## 4. Avviare il planner nel terminale corrente

~~~
yano start --instance planner-01 --role planner
~~~

Il planner resta collegato al terminale corrente. Descrivi lì il task da
realizzare.

## Usare comunque Herdr, ma aprirlo manualmente

Se vuoi supervisionare il processo in Herdr senza usare l'automazione di
'yano init --herdr':

~~~
herdr
~~~

Nel workspace Herdr del progetto esegui:

~~~
cd /percorso/mio-progetto
yano start --instance planner-01 --role planner
~~~

Per il flusso più semplice e ripetibile usa invece
[la modalità automatica](./03-nuovo-progetto-con-herdr.md).
