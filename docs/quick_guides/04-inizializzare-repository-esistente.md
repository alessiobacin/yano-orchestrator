# Inizializzare una repository esistente

Yano può adottare un progetto già sviluppato anche se contiene già
package.json, codice, configurazioni o una repository Git.

## Procedura

~~~
cd /percorso/app-esistente
yano init --name "App Esistente"
~~~

Non serve '--force' solo perché la directory non è vuota. L'inizializzazione
in-place aggiunge l'infrastruttura Yano mancante e preserva i file applicativi.

Poi avvia il broker e il trace:

~~~
docker compose -f mqtt/compose.yaml up -d
yano trace enable --mode full
~~~

Infine avvia il planner:

~~~
yano start --instance planner-01 --role planner
~~~

Oppure usa direttamente la modalità automatica Herdr:

~~~
yano init --name "App Esistente" --herdr
~~~

## Attenzione alla cartella agents/

Se agents/ è già usata dall'applicazione, Yano usa il roster in
.pi/agents/ per non mescolare configurazioni. Non spostare manualmente le
cartelle: lascia che 'yano start' scelga il layout corretto.

## Verificare cosa è stato creato

~~~
yano status
yano skills
yano mcp
yano doctor
~~~
