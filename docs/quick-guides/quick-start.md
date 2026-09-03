# Quick start di un progetto Yano

Questa guida prepara un progetto nuovo, attiva il trace e porta il primo task
fino al feedback dell'utente.

## Pulizia e documentazione della repo

Per chiedere una pulizia completa, includi anche la documentazione mancante:
`Pulisci la repo e crea la documentazione mancante`. Il Planner presenta un
piano unico da approvare; `clean-repo` crea file reali nelle categorie
`architecture`, `guides`, `quick-guides`, `adr`, `notes`, `cheat-sheet` e
`diagram`, oltre a una collection Postman se rileva un backend. Gli equivalenti
esistenti vengono riusati, senza duplicati.

Se cerchi solo i comandi per una singola operazione, usa la raccolta di
[quick guides](./README.md). Questa pagina resta il percorso
completo e ragionato dal primo avvio fino alla diagnosi del risultato.

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

Le variabili per notifiche, watcher e trace globale non devono essere copiate
nel pacchetto npm. Su un'installazione globale configurale con `yano config`:

```bash
yano config list --all
yano config set YANO_ORCHESTRATOR_REPO /percorso/yano-orchestrator
printf '%s' "$TELEGRAM_BOT_TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
yano config set TELEGRAM_DESTINATION_CHAT_ID CHAT_ID
```

In sviluppo è ancora possibile usare il `.env` del checkout Yano. Il `.env`
del progetto applicativo non viene usato per la configurazione globale.

`yano doctor` verifica anche Ollama, il modello `nomic-embed-text` e una
richiesta reale all'endpoint locale `/api/embed`. Se Ollama manca, segui il
comando di installazione stampato dal doctor, poi ripeti `yano init`.

## 1. Crea e inizializza il progetto

```bash
mkdir mio-progetto
cd mio-progetto
yano init --name "Mio Progetto"
```

Per un progetto usato solo come conversation test, senza repository Git o
worktree di sviluppo, puoi usare `yano init --name "Conversation Test" --no-git`.
Il planner deve chiamare `orchestrator_init` come primo preflight del task: il
database operativo viene così creato prima di qualunque consulto o debate,
senza creare worktree, repository o artefatti di sviluppo.

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

Per una review visuale opzionale dopo un task frontend, il planner chiede il
consenso dell'utente e, se accettato, usa `yano frontend-review start`. Il
comando installa `agentation` nel progetto React, avvia lo script `dev`,
`start` o `serve` individuato e stampa l'URL da annotare.

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

I dati restano nella directory globale di Yano, non nel repository e non nel
pacchetto installato. Il percorso viene scelto automaticamente per il sistema
operativo. Se vuoi un percorso esplicito:

```bash
yano config set YANO_DATA_DIR "$HOME/.local/share/yano-data"
yano trace enable --mode standard
```

Controlla il percorso effettivo con `yano trace status`.

## 4. Avvia il planner

```bash
yano start --instance planner-01 --role planner
```

`pi` senza flag resta sempre una sessione umana normale, anche dentro un
progetto inizializzato da Yano: non richiede `--instance` e non si collega
all'orchestratore. Per creare un agente Yano usa invece `yano start` (o il
comando equivalente con `--instance`), che gli assegna identità e progetto.

`yano start` applica comunque `full` automaticamente. Per una raccolta più
leggera si può usare `yano start --trace-mode events` (oppure `standard`/`off`).

Il launcher carica automaticamente la skill condivisa di analisi trace anche
per coder, reviewer e specialisti quando sono avviati con `yano start`.

Il reviewer applica inoltre la skill `yano-code-review`: ogni revisione separa
la conformità alla `Spec` dalla conformità agli `Standards` del repository,
registra il fixed point automatico quando disponibile e classifica i finding
come `blocking` o `non-blocking`. I code smell da soli non respingono un task;
restano vincolanti i test, le verifiche browser/API, il trace e il verdetto
operativo già previsto dal ciclo Yano.
Nel terminale del planner descrivi l'obiettivo; dopo la tua conferma creerà i
worktree e delegherà il lavoro.

Per ogni task di sviluppo il planner passa dalla skill `/to-tickets` dopo la
spec: propone slice verticali, criteri di accettazione e dipendenze, chiede se
la granularità è corretta e solo dopo importa i ticket approvati in SQLite/DAG.

## 5. Controlla il lavoro

Da un altro terminale puoi usare viste read-only:

```bash
yano status
yano fleet
yano logs
yano trace status
```

Per rispondere a «quanti progetti Yano sono attivi adesso?» usa l'inventario
globale Herdr:

```bash
yano projects --json
```

`project_count` conta una sola volta ogni root con almeno un agente Pi/Yano
live, inclusi planner, coder, reviewer e worker esterni. Non conta terminali
Codex, card MQTT retained o pane stale/offline; se `herdr_reachable` è falso il
totale è ignoto. I comandi `yano watcher projects`, `yano architect projects`
e simili rispondono invece alla domanda più specifica sui soli worker esterni
di quel ruolo.

Per vedere l'uso senza effetti collaterali:

```bash
yano watch --help
yano watcher start --help
```

Le regole persistenti del planner si gestiscono con `yano rule`. Sono salvate
nel data-root globale e possono valere per tutti i progetti oppure per una
singola root:

```bash
yano rule --add --global "Tutti i progetti devono avere un diagramma di flusso della logica in <root progetto>/docs/diagram"
yano rule --add --project-root /path/progetto "Regola specifica del progetto"
yano rule --list --project-root /path/progetto --json
```

Questi comandi non aprono il broker e non modificano il registro. Un watcher
continuo può partire prima del primo `orchestrator_init`: registra il preflight
come `waiting` e resta vivo. Se nel frattempo vede un trace di debate già
avviato, lo segnala come `missing-orchestrator-init` al planner invece di
nasconderlo come semplice attesa.

Ogni `agent_send` controlla la presence del destinatario prima di pubblicare.
Se il destinatario è offline, Yano inoltra automaticamente il messaggio al
planner live; se manca anche il planner, lo consegna al canale fallback del
watcher, che avvia o riapre `planner-01` e ripete la consegna mantenendo
destinatario originale, mittente e `assignment_id`. Il watcher non viene
avviato da `yano start`: viene registrato solo quando lo chiedi esplicitamente
con `yano watcher start` (che avvia `yano watch --away` con le opzioni scelte)
per il progetto desiderato.
Durante l'installazione globale di Yano (`npm install -g`) viene installato una
sola volta anche il supervisore utente ogni minuto; verifica lo stato con
`yano watcher cron status`.

Ogni sessione Pi registra nei log globali `context_usage` con token effettivi,
finestra, rapporto, caratteri serializzati e numero di entry. Il watcher può
chiedere la compaction nativa della sessione, valida per ogni playbook, quando
il rapporto supera la soglia configurata:

```bash
yano watch --project-root /path/progetto --interval-ms 60000 --away \
  --context-compact-ratio 0.82
```

La stessa soglia può essere impostata con `YANO_WATCH_CONTEXT_COMPACT_RATIO`.
L'agente esegue `ctx.compact()` al proprio safe point, conserva il riepilogo
nel session log e registra `context_compaction_completed`; non viene ricreato
il run e non viene toccato il codice del progetto.

Per sapere su quali progetti sono attivi i worker esterni, senza interrogare
manualmente Herdr:

```bash
yano architect projects
yano watcher projects
yano feedback projects
yano auto-improve projects       # alias: yano auto-improver projects
yano feedback projects
```

L'evidence pack auto-improve rileva anche test, build e config lint presenti
nel repository, non solo gli script npm; segnala separatamente l'eventuale
mancanza di un comando standard. Il worker parte da un transcript Pi nuovo a
ogni audit, pur potendo riusare la tab Herdr, e può scrivere solo il report
globale tramite il tool dedicato `auto_improve_complete`.

Le viste mostrano gli agenti live. Aggiungi `--all --json` per includere anche
proposte e registrazioni offline. `yano fleet --project-root /path` resta la
vista degli agenti del progetto, inclusi Planner e worker di sviluppo.

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

## Dashboard Gantt per progetto

Per aprire una dashboard live con porta automatica libera:

```bash
yano gantt --persistent --open
```

Le porte automatiche sono sempre nel range `10000-19999`; la scelta parte da
uno slot stabile per progetto e prova il successivo se occupato. Per recuperare
il link del progetto dalla sua root:

```bash
yano gantt --link --json
```

Da qualunque directory, per elencare tutti i Gantt registrati:

```bash
yano gantt --links --json
```

`--persistent` salva il link nel data-root globale di Yano e impedisce di
avviare una seconda dashboard per lo stesso progetto quando quella esistente è
raggiungibile. Il registro conserva anche i link fermi, ma il server resta
foreground: il dashboard è live finché il processo o la tab Herdr restano
attivi. Per riavviarlo, esegui di nuovo `yano gantt --persistent --open` dalla
root del progetto. Per il dettaglio tecnico consulta
[`docs/architecture/architecture.md`](../architecture/architecture.md) e la
[quick guide Gantt](./19-inventario-agenti-e-gantt.md).

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

L'indice è incrementale, vive nella stessa directory dati globale e può essere
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
alle proiezioni `planner-context.json` e `recurring-failures.md` nella directory
dati globale. Sono dati derivati: il trace JSONL resta la fonte primaria.

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
trace nella directory dati globale di Yano. Il ripristino controlla
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

Per il riferimento completo consulta [`yano-trace.md`](./yano-trace.md). Per
il flusso di bug applicativi usa [`yano-feedback.md`](./yano-feedback.md) e la
[guida rapida del feedback](./12-yano-feedback.md).
