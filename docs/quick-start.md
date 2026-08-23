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

Per aprire automaticamente Herdr, creare un workspace con il nome della
cartella corrente ed eseguire subito il planner nello stesso terminale:

```bash
yano init --name "Mio Progetto" --herdr
```

Questa modalità porta esplicitamente il workspace in primo piano. Da un
terminale normale apre/aggancia anche il client Herdr; se il comando è già
eseguito dentro Herdr, evita di aprire un client annidato. È in-place e non
accetta `--target`: evita che il workspace Herdr e la root reale del progetto
puntino a directory diverse.

`yano init` prepara configurazione, ruoli e workspace del progetto senza
copiarvi il codice dell'estensione; il database SQLite operativo viene creato
quando il primo planner inizializza l'orchestratore.

Se la directory contiene già un'applicazione, puoi eseguire lo stesso comando
senza `--force`: Yano adotta la root in modo non distruttivo, preservando
`package.json`, codice, configurazioni e `.env.example`, e aggiungendo solo i
file d'infrastruttura mancanti. Se `agents/` è già una cartella applicativa,
il roster Yano viene scritto in `.pi/agents/`.

Lo scope MQTT predefinito viene derivato da `config/project.json`, poi dal
`package.json` e infine dal nome della cartella. Non aggiungere un
`--project` basato arbitrariamente sul nome della directory: se lo usi,
riportalo identico su ogni istanza. Yano mostra un avviso all'avvio quando lo
scope esplicito diverge da quello della root corrente.

Quando il flag è omesso, `yano start` passa comunque lo scope risolto in modo
esplicito al processo `pi` figlio. Questo evita che una copia obsoleta o
installata da un'altra registry di Pi scelga accidentalmente lo scope
condiviso predefinito. Il runtime verifica inoltre che ogni card retained di
presenza dichiari lo stesso progetto del topic MQTT prima di mostrarla.

Un progetto creato con il layout precedente, che conserva il roster in
`.pi/agents/roles.yaml`, viene riconosciuto automaticamente e avviato con
quella directory di configurazione. Per i nuovi progetti il layout consigliato
resta `agents/roles.yaml` nella root.

## 2. Avvia il broker MQTT

Con il broker Docker incluso:

```bash
docker compose -f mqtt/compose.yaml up -d
```

Se il broker è già disponibile su `127.0.0.1:1883`, questo passaggio non è
necessario.

## 3. Inizializza il trace prima del primo agente

Inizializza il trace completo prima di avviare il planner:

```bash
yano trace enable --mode full
yano trace status
```

`agent_list` include anche l’istanza che lo ha chiamato, marcata `self: true`;
questa riga conferma che il planner è online ma non è una destinazione valida
per una delega. Se dopo il riavvio compare solo `self` e mancano i peer,
controlla lo scope visualizzato dal messaggio di avvio e rilancia tutte le
istanze con lo stesso `--project` (oppure ometti il flag per usare il default
della root). Uno scope diverso è una rete MQTT diversa: il refresh non può
fondere intenzionalmente due progetti separati.

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

`yano start` applica comunque `full` automaticamente. Per una raccolta più
leggera si può usare `yano start --trace-mode events` (oppure `standard`/`off`).

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
  --mode hybrid --limit 10 --json --explain
```

L'indice è incrementale, vive nella stessa `temp/` globale e può essere
ricreato dai JSONL. Usa `--project`, `--round`, `--task`, `--instance`,
`--type` o `--since` per restringere ulteriormente la ricerca.

Per ridurre ancora il contesto del planner, consolida il round e genera un
piano di recupero con un limite token esplicito:

```bash
yano trace consolidate --run <run-id> --round 1 --json
yano trace plan \
  --run <run-id> --round 1 \
  --query "perché la verifica del frontend è fallita?" \
  --budget 6000 --json
```

La consolidazione crea memorie episodiche e pattern ricorrenti in SQLite, oltre
alle proiezioni `planner-context.json` e `recurring-failures.md` nella temp
globale. Sono dati derivati: il trace JSONL resta la fonte primaria.

Per conservare o trasferire un'indagine:

```bash
yano trace export --run <run-id> --output ./trace-bundle.json
yano trace import --input ./trace-bundle.json --reindex
yano trace consolidate --run <run-id>
```

L'importazione ripristina i record raw in modo idempotente; indice semantico e
memoria vengono ricostruiti dal progetto di destinazione.

Infine il planner salva `yano trace opinion` e apre un nuovo round nello
stesso worktree. Coder e reviewer possono leggere il contesto filtrato per
capire se l'errore nasce da requisito, implementazione, verifica o
orchestrazione.

## 7. Metti in pausa e ripristina un task

Se devi chiudere il laptop o interrompere il lavoro senza perdere il punto di
ripresa, usa il checkpoint non distruttivo:

```bash
yano pause --all --yes
yano recovery status
yano resume --all --dry-run
yano resume --all --yes --supervisor auto
```

La pausa conserva SQLite, ticket, worktree, branch, presenza disponibile e
trace nella `temp/` globale dell'installazione Yano. Il ripristino controlla
quali istanze sono ancora vive, riapre solo quelle mancanti e riattiva il
planner con la sessione precedente. Non usare `yano end`: quel comando chiude
formalmente il run.

## 8. Chiudi o conserva il progetto

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
