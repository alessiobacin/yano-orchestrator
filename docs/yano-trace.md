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
└── traces/<project-key>/
    ├── events/*.jsonl
    ├── terminal/*.jsonl
    ├── snapshots/*.jsonl
    ├── feedback.jsonl
    ├── summaries.jsonl
    └── opinions.jsonl
```

`<project-key>` combina il nome del progetto con un hash della directory reale:
due checkout con lo stesso nome non condividono accidentalmente il trace.
La posizione può essere cambiata con:

```bash
export YANO_DATA_DIR="$HOME/.local/share/yano-trace"
```

È supportato anche `YANO_TEMP_DIR`; `YANO_DATA_DIR` ha precedenza.

## Modalità di raccolta

```bash
yano trace status
yano trace enable --mode events
yano trace enable --mode standard
yano trace enable --mode full
yano trace disable
```

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
