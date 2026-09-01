# Installazione e prerequisiti

Questa guida prepara una macchina nuova per usare Yano.

## Prerequisiti principali

Servono:

- Node.js 22.5 o superiore;
- Git;
- 'pi';
- Code Mem, disponibile come comando 'cm' (`cm version` deve riuscire);
- Herdr, se vuoi gestire le istanze nelle sue tab;
- Docker Desktop oppure un broker MQTT già disponibile;
- Ollama con il modello 'nomic-embed-text' per l'indicizzazione semantica.

## Installare Yano globalmente

Da una shell:

~~~
npm install -g https://github.com/alessiobacin/yano-orchestrator.git
yano --version
~~~

Durante lo sviluppo locale del repository Yano puoi usare invece:

~~~
cd /percorso/yano-orchestrator
npm install
npm link
yano --version
~~~

## Verificare l'ambiente

~~~
yano doctor
~~~

Il doctor controlla runtime Node, Git, Pi, Code Mem, broker, Ollama, modello di
embedding e prerequisiti browser/MCP. Se qualcosa manca, stampa il comando
consigliato per il sistema operativo in uso.

Per un risultato leggibile da script:

~~~
yano doctor --json
~~~

Se il doctor segnala Ollama, installalo seguendo l'istruzione stampata e poi
verifica il modello:

~~~
ollama pull nomic-embed-text
yano doctor
~~~

Quando il doctor trova `cm`, `yano init` esegue automaticamente `cm init pi`
nella root: inizializza `memory/` e l'hook/skill locale di Pi. L'hook è
best-effort e non blocca l'avvio di un agente.

## Avviare il broker incluso

Da un progetto già inizializzato:

~~~
docker compose -f mqtt/compose.yaml up -d
~~~

Controlla lo stato con:

~~~
yano doctor --network
~~~

Se hai già un broker MQTT su 127.0.0.1:1883, non devi avviare quello Docker.
Per un broker diverso passa lo stesso '--broker' a tutte le istanze.
