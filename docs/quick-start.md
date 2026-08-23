# Quick start di un progetto Yano

Questa guida prepara un progetto nuovo, attiva il trace e porta il primo task
fino al feedback dell'utente.

## Prerequisiti

- Node.js 22.5 o superiore;
- Git;
- Yano installato globalmente o collegato dal repository;
- Ollama con `nomic-embed-text` (installato/verificato automaticamente da `yano init` quando possibile);
- un broker MQTT locale, normalmente Docker.

Dal repository di Yano:

```bash
npm install -g /percorso/yano-orchestrator
yano doctor
```

`yano doctor` verifica anche Ollama, il modello `nomic-embed-text` e una
richiesta reale all'endpoint locale `/api/embed`. Se Ollama manca, segui il
comando di installazione stampato dal doctor, poi ripeti `yano init`.

## 1. Crea e inizializza il progetto

```bash
mkdir mio-progetto
cd mio-progetto
yano init --name "Mio Progetto"
```

`yano init` prepara configurazione, ruoli e workspace del progetto senza
copiarvi il codice dell'estensione; il database SQLite operativo viene creato
quando il primo planner inizializza l'orchestratore.

Lo scope MQTT predefinito viene derivato da `config/project.json`, poi dal
`package.json` e infine dal nome della cartella. Non aggiungere un
`--project` basato arbitrariamente sul nome della directory: se lo usi,
riportalo identico su ogni istanza. Yano mostra un avviso all'avvio quando lo
scope esplicito diverge da quello della root corrente.

## 2. Avvia il broker MQTT

Con il broker Docker incluso:

```bash
docker compose -f mqtt/compose.yaml up -d
```

Se il broker è già disponibile su `127.0.0.1:1883`, questo passaggio non è
necessario.

## 3. Inizializza il trace prima del primo agente

Attiva almeno `events` prima di avviare il planner:

```bash
yano trace enable --mode events
yano trace status
```

Se `agent_list` è vuoto dopo il riavvio del planner, controlla prima lo scope
visualizzato dal messaggio di avvio e rilancia tutte le istanze con lo stesso
`--project` (oppure ometti il flag per usare il default della root). Uno scope
diverso è una rete MQTT diversa: il refresh non può fondere intenzionalmente
due progetti separati.

`yano fleet` mostra solo agenti con heartbeat recente; le card retained
`offline` o scadute vengono indicate come ignorate, non come agenti live.

Per includere risposte visibili e metadati dei tool usa `standard`; per una
sessione diagnostica completa usa `full`:

```bash
yano trace enable --mode full
```

I dati restano nella directory globale di Yano, non nel repository. Se
l'installazione globale non è scrivibile:

```bash
export YANO_DATA_DIR="$HOME/.local/share/yano-trace"
yano trace enable --mode standard
```

Controlla il percorso effettivo con `yano trace status`.

## 4. Avvia il planner

```bash
yano start --instance planner-01 --role planner
```

Il launcher carica automaticamente la skill condivisa di analisi trace anche
per coder, reviewer e specialisti quando sono avviati con `yano start`.
Nel terminale del planner descrivi l'obiettivo; dopo la tua conferma creerà i
worktree e delegherà il lavoro.

## 5. Controlla il lavoro

Da un altro terminale puoi usare viste read-only:

```bash
yano status
yano fleet
yano logs
yano trace status
```

Se l'avvio usa uno scope MQTT esplicito, usa lo stesso valore anche nelle
viste read-only:

```bash
yano status --project mio-progetto
yano fleet --project mio-progetto
yano logs --project mio-progetto
yano trace events --project mio-progetto --follow
```

SQLite mantiene run, ticket, dipendenze, evidenze e stato di recupero; il trace
globale mantiene la storia osservabile utile per audit e diagnosi.

## 6. Registra il risultato del round

Quando il planner presenta un risultato, registra il tuo verdetto con le tue
parole. Per un risultato corretto:

```bash
yano trace feedback \
  --status accepted \
  --text "Il task è soddisfacente e il flusso funziona." \
  --run <run-id> --round 1 --task <task-slug>
```

Per un risultato da correggere:

```bash
yano trace feedback \
  --status rejected \
  --text "Il risultato non funziona: manca la verifica del caso limite." \
  --run <run-id> --round 1 --task <task-slug>
```

Il comando crea automaticamente una snapshot. Il planner legge poi il
contesto limitato:

```bash
yano trace context \
  --run <run-id> --round 1 --task <task-slug> --json
```

Se il problema può ripetersi, confronta anche i progetti:

```bash
yano trace overview --all-projects --json
```

Quando il contesto è ampio, crea l'indice semantico locale e chiedi solo le
evidenze pertinenti al problema:

```bash
yano trace index --run <run-id>
yano trace search \
  --run <run-id> \
  --query "perché la verifica del frontend è fallita?" \
  --limit 10 --json
```

L'indice è incrementale, vive nella stessa `temp/` globale e può essere
ricreato dai JSONL. Usa `--project`, `--round`, `--task`, `--instance`,
`--type` o `--since` per restringere ulteriormente la ricerca.

Infine il planner salva `yano trace opinion` e apre un nuovo round nello
stesso worktree. Coder e reviewer possono leggere il contesto filtrato per
capire se l'errore nasce da requisito, implementazione, verifica o
orchestrazione.

## 7. Chiudi o conserva il progetto

Quando il lavoro è approvato il planner esegue la checklist finale e completa
il merge. Per chiudere eventuali run ancora attivi:

```bash
yano end --list
yano end --yes
```

Non cancellare subito il trace: è utile per confrontare round e progetti. Se
vuoi eliminarlo esplicitamente:

```bash
yano trace clear --all --yes
```

Per il riferimento completo consulta [`yano-trace.md`](./yano-trace.md).
