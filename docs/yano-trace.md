# `yano trace`

`yano trace` è il registro forense globale di Yano. Conserva gli eventi
osservabili dell'orchestrazione e aggiunge un livello separato per feedback
dell'utente, snapshot, opinioni del planner e aggregazioni tra progetti.

Serve a capire che cosa è successo in un round, perché l'utente lo ha rifiutato
e quali errori di flusso si ripetono tra progetti. Registra solo dati
osservabili: messaggi visibili, lifecycle dei tool, MQTT, watchdog, Git,
terminal adapter e feedback esplicito. Non registra il chain of thought privato
del modello.

## Dove vengono salvati i dati

Per impostazione predefinita i dati sono fuori dal progetto e dal pacchetto
installato, nella directory dati per-user di Yano:

```text
<YANO_DATA_DIR>/
├── tracing.json
├── semantic-index.sqlite
└── traces/<project-key>/
    ├── events/*.jsonl
    ├── terminal/*.jsonl
    ├── snapshots/*.jsonl
    ├── projections/planner-context.json
    ├── projections/recurring-failures.md
    ├── feedback.jsonl
    ├── summaries.jsonl
    └── opinions.jsonl
```

`<project-key>` è derivato dalla directory reale del workspace. Il nome umano e
lo scope MQTT sono alias, non identità di persistenza: così `FocusBoard` e
`focusboard-trace-test` non dividono più lo stesso trace. Le directory legacy
nome-hash restano leggibili durante la migrazione.
Il percorso viene scelto automaticamente: macOS `~/Library/Application
Support/yano/data`, Linux `~/.local/share/yano`, Windows
`%LOCALAPPDATA%/yano/data`. Per usare un percorso diverso:

```bash
yano config set YANO_DATA_DIR "$HOME/.local/share/yano-trace"
```

È supportato anche `YANO_TEMP_DIR`; `YANO_DATA_DIR` ha precedenza.

`yano start` propaga automaticamente la stessa directory al processo Pi e agli
agenti che il planner avvia. Questo evita che CLI npm globale ed estensione
caricata da un clone Pi scrivano in due directory dati diverse. Per ispezionare un run
avviato da una vecchia versione si può indicare temporaneamente il suo store
con `--data-dir`.

## Escalation delle falle di Yano

Quando `yano watch` osserva un progetto, oltre agli stall controlla i record
recenti del trace per segnali ad alta confidenza che appartengono a Yano. Per
esempio `agent_send_no_live_target`, un errore di un tool interno o una
discordanza tra workspace e progetto. Gli errori generici dell'applicazione
(come `npm test` fallito) non vengono classificati come difetti di Yano.

L'assenza di `orchestrator.db` non è di per sé un errore: un watcher ordinario
scrive `yano_watcher_scan` con `status: waiting` e `reason: not_initialized` e
continua il polling senza escalation. Il valore `blocked` è riservato alle
passate con contesto esplicito di validazione.

Per ogni segnale nuovo viene creato un ticket Markdown deduplicato nel checkout
del repository Yano:

```text
<yano-orchestrator>/.scratch/optimize-orchestrator/issues/<NN>-yano-watcher-<signal>.md
```

Il ticket contiene progetto, run, round, agente, record di evidenza, impatto e
criteri di chiusura per l'LLM che dovrà correggere Yano. Le rilevazioni
successive dello stesso problema non ricreano il file. Il watcher aggiunge
anche un evento `yano_watcher_finding` nel trace del progetto.

La configurazione usa il `.env` del checkout Yano quando si lavora dal
repository di sviluppo, oppure la configurazione globale dell'utente quando
Yano è installato soltanto via npm. Il file globale si gestisce senza copiare
segreti nel pacchetto:

```bash
yano config set YANO_ORCHESTRATOR_REPO /Users/alessiobacin/Development/testCode/yano-orchestrator
yano config set TELEGRAM_DESTINATION_CHAT_ID 5228139669
printf '%s' "$TELEGRAM_BOT_TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
```

`YANO_ORCHESTRATOR_REPO` non viene mai letto dal progetto osservato, né da un
flag CLI. Se una scansione trova un difetto Yano e manca una variabile davvero
necessaria, il comando termina indicando la variabile mancante e il comando
`yano config set` esatto per valorizzarla.

Poi si può eseguire:

```bash
yano watch --project-root /path/al/progetto --once
```

Il watcher non stampa mai il token.

`--lookback-ms 3600000` significa “analizza i record degli ultimi 60 minuti”;
non significa eseguire una scansione ogni 60 minuti. Per una scansione unica
usa `--once`; per il polling continuo usa `--interval-ms 3600000`.
Ogni scansione produce un evento `yano_watcher_scan`, anche quando non trova
anomalie. L'evento contiene `started_at`, `completed_at`, `duration_ms`,
`status`, `findings`, `stalls`, `interval_ms` e `lookback_ms`; `ts` è l'orario
di completamento. `yano_watcher_round_ok` resta invece riservato alle passate
positive di validazione bounded con `--validation-run`.

Per i flussi conversation il watcher verifica anche il contratto operativo
senza usare un LLM. Quando il trace mostra una consultazione del
`conversation-researcher`, aggiunge `yano_watcher_conversation_check` con
`status: healthy` oppure `violation`. Un `conversation_policy_violation`
segnala solo tool Yano di consegna vietati, comandi shell mutanti o un lancio
fallito dello specialista; i comandi di lettura (`curl`, `grep`, `git status`,
`yano trace`) non sono errori. Le violazioni sono deduplicate e instradate al
planner live, oppure a Telegram se non c'è un planner.

Il watcher persistente ascolta inoltre `run_completed` e
`planner_task_completed` sul broker. Ogni evento accoda una sola passata
finale immediata, registrando prima `yano_watcher_final_scan_requested` e poi
un normale `yano_watcher_scan` con `once: true`; il polling configurato non
viene sostituito né fermato.

Per elencare gli scan con data e ora di inizio/fine:

```bash
yano trace events --instance yano-watcher --type yano_watcher_scan --limit 50
yano trace events --instance yano-watcher --type yano_watcher_scan --limit 50 --json
yano trace events --instance yano-watcher --type yano_watcher_finding --limit 50
find /Users/alessiobacin/Development/testCode/yano-orchestrator/.scratch/optimize-orchestrator/issues -type f -maxdepth 1 -print
```

La consegna Telegram è best-effort: un errore di rete non blocca il watcher e
resta nel campo `telegram.detail` dell'evento senza credenziali.

## Modalità di raccolta

```bash
yano trace status
yano trace enable --mode events
yano trace enable --mode standard
yano trace enable --mode full
yano trace disable
```

`yano start` imposta automaticamente `full` per la sessione e propaga la stessa
modalità a tutti gli agenti. Per ridurre intenzionalmente la raccolta usa
`yano start --trace-mode events|standard|off` oppure `YANO_TRACE_MODE`.

- `off`: nessun nuovo evento di tracing;
- `events`: lifecycle, coordinamento, MQTT, watchdog e metadati essenziali;
- `standard`: aggiunge risposte visibili dell'assistente e metadati dei tool;
- `full`: conserva anche il ramo visibile della sessione, dopo redazione dei
  dati sensibili.

La modalità è configurabile per progetto. Il logging è best-effort: un errore
di scrittura del trace non deve bloccare l'agente o il task.

## Feedback dell'utente

Alla fine di un round il planner registra il testo dell'utente senza
reinterpretarlo:

```bash
yano trace feedback \
  --status accepted|partial|rejected \
  --text "<testo fedele dell'utente>" \
  --run <run-id> \
  --round <numero> \
  --task <slug>
```

`feedback` scrive `feedback.jsonl` e crea automaticamente uno snapshot
deterministico in `summaries.jsonl`. Lo snapshot contiene conteggi e segnali
disponibili fino a quel momento; non è una diagnosi LLM e non modifica il
codice.

## Contesto filtrato

Per non caricare l'archivio intero nel contesto del modello:

```bash
yano trace context \
  --run <run-id> \
  --round <numero> \
  --task <slug> \
  --limit 120 \
  --json
```

Filtri disponibili: `--project`, `--run`, `--round`, `--task`, `--since` in
formato ISO-8601 e `--limit`. `--json` produce un bundle strutturato per LLM o
script.

Quando viene passato `--run`, Yano ricava anche il progetto dal run persistito
nello SQLite locale, se disponibile. Questo evita che un vecchio nome progetto
o uno scope MQTT esplicito faccia risultare vuoto un contesto esistente.

Ogni avvio registra un `trace_preflight` con modalità attesa/reale, directory
dati, versione Yano attesa e versione runtime effettivamente caricata. Serve a
distinguere un bug di orchestrazione da una CLI o estensione globale rimasta
vecchia.

Per leggere gli eventi raw del flusso, con filtri mirati:

```bash
yano trace events --project <scope-mqtt> --run <run-id> --limit 100
yano trace events --project <scope-mqtt> --instance coder-01 --type tool_execution_end
yano trace events --project <scope-mqtt> --follow
```

`--follow` stampa gli eventi già presenti e poi segue il file mentre gli
agenti lavorano. Gli eventi legacy privi di `project_key` vengono ricostruiti
dal percorso canonico del progetto, quindi restano consultabili dopo
l'aggiornamento.

Coder, reviewer e specialisti usano normalmente questo comando per capire
una correzione, un disaccordo o un evento inatteso. Nel report devono separare
requisito atteso, risultato osservato ed evidenza. Non devono inventare un
feedback dell'utente, modificare il trace o trasformare un episodio isolato in
una diagnosi sistemica.

## Opinione del planner

Dopo aver letto il contesto il planner salva la propria ipotesi:

```bash
yano trace opinion \
  --text "La causa probabile è un gap nella verifica comportamentale." \
  --summary "Il reviewer ha validato i test ma non il flusso reale." \
  --root-cause "La checklist non richiede una prova end-to-end." \
  --recommendation "Rafforzare il playbook del reviewer." \
  --change playbook \
  --confidence high \
  --roles planner,coder,reviewer \
  --run <run-id> --round <numero> --task <slug>
```

`--change` può essere `existing-agent`, `new-agent`, `prompt`, `tool`,
`playbook` o `none`. L'opinione è un'osservazione persistente, non
un'autorizzazione automatica a modificare Yano. Un nuovo agente va proposto
solo quando la stessa capacità distinta manca in più task o progetti e non è
coperta da prompt, playbook, gate o tool esistenti.

## Overview tra progetti

```bash
yano trace overview --all-projects --json
yano trace overview --all-projects \
  --since 2026-08-01T00:00:00Z --limit 500 --json
```

L'overview aggrega feedback accettati/parziali/rifiutati, distribuzione per
progetto e round, pattern testuali, tool failure, timeout, stall, agenti orfani
e conflitti di merge, oltre a feedback e opinioni recenti.

L'overview è evidenza per una proposta, non prova automatica di causalità. La
relazione tra segnale e modifica va motivata dal planner e verificata nei round
successivi.

## Cancellazione

La cancellazione è sempre protetta da `--yes`:

```bash
yano trace clear --yes
yano trace clear --run <run-id> --yes
yano trace clear --instance coder-01 --yes
yano trace clear --before 2026-08-01T00:00:00Z --yes
yano trace clear --all --yes
```

Durante una diagnosi non usare `clear`: conserva prima il contesto e salva
l'opinione. `--all` rimuove tutto il temp globale di Yano, inclusa la
configurazione delle modalità.

## Procedura dopo un errore

```text
feedback utente → context filtrato → bug prodotto / bug Yano
→ overview cross-project → opinion del planner → nuovo round nello stesso worktree
```

La skill condivisa
[`yano-planner-trace-analysis`](../skills-vendor/yano/yano-planner-trace-analysis/SKILL.md)
contiene il contratto operativo che tutti gli agenti ricevono; al planner
spetta la decisione finale sulle modifiche sistemiche.

## Embeddings locali

Yano usa `nomic-embed-text` tramite Ollama come backend locale per
l'indicizzazione semantica dei trace. `yano doctor` verifica quattro
livelli distinti: CLI Ollama, server HTTP, modello scaricato e probe reale su
`/api/embed`. `yano init` tenta di installare Ollama e di eseguire:

```bash
ollama pull nomic-embed-text
```

Non viene aggiunta una dipendenza npm: Node usa `fetch` verso l'API locale di
Ollama. Il server predefinito è `http://127.0.0.1:11434`; si può modificare con
`YANO_OLLAMA_URL`. Il modello non è `EmbeddingGemma`, ma svolge lo stesso
ruolo tecnico di encoder per la fase embeddings e viene mantenuto come default
riproducibile di Yano.

## Indicizzazione e ricerca semantica

L'indice è un database SQLite globale, separato dai JSONL: i JSONL restano la
fonte forense originale e l'indice può essere ricreato. Ogni documento contiene
metadati, testo osservabile, payload JSON e il vettore generato da Ollama. I
vettori sono memorizzati come JSON in SQLite e confrontati con cosine similarity
in Node; non è richiesta un'estensione nativa `sqlite-vec`.

L'indicizzazione è esplicita e incrementale, così il runtime degli agenti non
subisce la latenza di una chiamata Ollama per ogni evento:

```bash
yano trace index --project <nome> --run <run-id>
yano trace index --project <nome> --since 2026-08-23T00:00:00Z --batch-size 16
yano trace index --project <nome> --run <run-id> --force
```

La seconda esecuzione salta i documenti invariati tramite hash del contenuto e
modello. La ricerca genera un solo embedding per la domanda e restituisce le
evidenze più simili:

```bash
yano trace search \
  --project <nome> --run <run-id> \
  --query "perché la migrazione è andata in timeout?" \
  --limit 10 --json
```

La risposta è compatta e non include il payload completo. Aggiungi
`--include-payload` solo quando servono i campi esatti dell'evento.

Sono disponibili anche `--round`, `--task`, `--instance`, `--type`, `--since`
e `--all-projects`. Il planner deve preferire run/round/task mirati; la vista
cross-project è utile per pattern sistemici, ma va usata solo quando serve.
`yano trace clear` elimina anche i documenti corrispondenti dall'indice, mentre
`yano trace clear --all --yes` elimina l'intero database semantico insieme al
temp globale.

## Memoria consolidata e recupero mirato

L'indice contiene anche una seconda proiezione, derivata dai record raw ma non
sostitutiva: `trace_memories`, `trace_memory_context` e
`trace_memory_links`. Le memorie hanno tipo e livello espliciti:

- `trace_run_summary`, `trace_observation`, `trace_failure` e `trace_opinion`
  sono memorie episodiche con gli ID dei record sorgente;
- `trace_pattern` è una memoria sistemica creata solo quando lo stesso segnale
  ricorre almeno due volte nello scope analizzato;
- ogni link dichiara una relazione (`failure_observed_in`,
  `feedback_observed_in`, `opinion_based_on`, `supports_pattern`) e conserva la
  propria evidenza.

La consolidazione è deterministica e quindi ripetibile: non pretende di
ricostruire il chain of thought privato e non trasforma una correlazione in una
causa certa. L'LLM può leggere le memorie e proporre un'opinione, ma la
provenienza resta sempre il JSONL osservabile.

```bash
# Dopo la fine di un round
yano trace index --run <run-id>
yano trace consolidate --run <run-id> --round <n> --json

# Pattern tra più progetti
yano trace consolidate --all-projects --json

# Piano di recupero con limite token e comandi suggeriti
yano trace plan --run <run-id> --round <n> \
  --query "perché il risultato è stato rifiutato?" --budget 6000 --json
```

La consolidazione genera nella cartella globale del progetto:

```text
traces/<project-key>/projections/
├── planner-context.json
└── recurring-failures.md
```

La ricerca usa per default `hybrid`: embedding 65%, corrispondenza lessicale
25%, recency 5% e salienza 5%. Si può limitare la ricerca alla memoria
consolidata oppure chiedere la spiegazione dei punteggi:

```bash
yano trace search --query "timeout delega agente" --mode hybrid --explain
yano trace search --query "errore di verifica" --memory-only --limit 8 --json
yano trace search --query "migration" --mode keyword
```

`yano trace plan` serve al planner per scegliere prima summary/pattern e solo
dopo i record raw necessari. Per dataset attuali SQLite + JSONL + Ollama sono
sufficienti: non è richiesta una vector database esterna né una estensione
`sqlite-vec`; l'indice è ricostruibile dalla fonte raw.

Le tabelle derivate sono mantenute nello stesso `semantic-index.sqlite`:
`trace_memories` contiene le memorie e i vettori, `trace_memory_context` i
ruoli/tool/file/entity associati e `trace_memory_links` i rapporti tra memorie.
Queste tabelle non sostituiscono i file JSONL e possono essere eliminate e
ricreate.

## Backup e ripristino

Per spostare o archiviare un'indagine usa un bundle JSON. Contiene i record
osservabili e, quando presenti, le proiezioni dell'indice e della memoria; il
JSONL resta comunque la fonte primaria.

```bash
yano trace export --run <run-id> --output ./trace-run.json
yano trace import --input ./trace-run.json --reindex
yano trace consolidate --run <run-id>
```

L'importazione è idempotente sugli ID dei record e non considera le memorie
derivate come autorità: le reindicizza e le riconsolida dal raw per evitare di
portare nel nuovo workspace link o chiavi di progetto obsolete.
