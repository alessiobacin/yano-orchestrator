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

Per impostazione predefinita i dati sono fuori dal progetto, nella directory
`temp/` dell'installazione globale di Yano:

```text
<installazione-yano>/temp/
├── tracing.json
├── semantic-index.sqlite
└── traces/<project-key>/
    ├── events/*.jsonl
    ├── terminal/*.jsonl
    ├── snapshots/*.jsonl
    ├── feedback.jsonl
    ├── summaries.jsonl
    └── opinions.jsonl
```

`<project-key>` è derivato dalla directory reale del workspace. Il nome umano e
lo scope MQTT sono alias, non identità di persistenza: così `FocusBoard` e
`focusboard-trace-test` non dividono più lo stesso trace. Le directory legacy
nome-hash restano leggibili durante la migrazione.
La posizione può essere cambiata con:

```bash
export YANO_DATA_DIR="$HOME/.local/share/yano-trace"
```

È supportato anche `YANO_TEMP_DIR`; `YANO_DATA_DIR` ha precedenza.

`yano start` propaga automaticamente la stessa directory al processo Pi e agli
agenti che il planner avvia. Questo evita che CLI npm globale ed estensione
caricata da un clone Pi scrivano in due `temp/` diversi. Per ispezionare un run
avviato da una vecchia versione si può indicare temporaneamente il suo store
con `--data-dir`.

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
