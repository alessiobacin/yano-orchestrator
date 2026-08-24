# Problemi comuni

## Yano non trova Pi, Herdr o Ollama

~~~
yano doctor
yano doctor --json
~~~

Installa i prerequisiti indicati dal doctor e ripeti il comando. Per gli
embedding locali:

~~~
ollama pull nomic-embed-text
yano doctor
~~~

## Il planner non vede gli altri agenti

Controlla broker e scope:

~~~
yano doctor --network
yano fleet
yano trace status
~~~

Assicurati che tutte le istanze siano state avviate dalla stessa root e con lo
stesso '--project'. Se non usi uno scope esplicito, ometti '--project' su tutte
le istanze.

## Un agente appare busy anche se non lavora

La presenza MQTT è retained. Controlla lo stato reale:

~~~
yano fleet
yano status
yano recovery status
~~~

Se l'istanza è realmente scomparsa, il planner deve rilanciarla con 'yano
start' nella tab Herdr corretta. Non aprire una seconda istanza con lo stesso
nome.

## yano init rifiuta una directory non vuota

Per una repository applicativa esistente esegui il comando dalla sua root:

~~~
yano init --name "Nome Applicazione"
~~~

Yano supporta l'inizializzazione in-place e non richiede '--force' solo perché
esistono package.json o codice applicativo.

## yano init --herdr non apre il planner

Controlla che Herdr sia installato e avviabile:

~~~
herdr
yano doctor
~~~

Poi ripeti 'yano init --herdr' dalla root del progetto. Se il workspace esiste
già, Yano lo riusa solo quando è associato alla stessa directory.

## Il reload resta in attesa del safe point

Prima prova ad aumentare il timeout:

~~~
yano update --reload --yes --timeout 300
~~~

Usa '--force' soltanto se sei consapevole che l'operazione LLM o il tool call
in corso può essere interrotto:

~~~
yano update --reload --yes --force
~~~

Se l'aggiornamento fallisce, non usare 'yano end': controlla lo snapshot e
ripristina con:

~~~
yano recovery status
yano resume --all --dry-run
yano resume --all --yes
~~~

## Un progetto usa un layout Yano vecchio

Non creare manualmente una seconda cartella .pi. Esegui:

~~~
yano init --name "Nome Progetto"
yano start --instance planner-01 --role planner
~~~

Yano individua il database e il roster esistenti, compreso il layout legacy in
.pi/agents/, senza duplicare lo stato.
