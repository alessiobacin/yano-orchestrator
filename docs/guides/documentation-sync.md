# Documentation synchronization policy

La documentazione di Yano è parte del contratto operativo del codice: un
comando, un flag, un percorso dati, un ruolo o un flusso non è completato finché
gli utenti e gli agenti non possono trovarne la descrizione aggiornata.

## Contratto dell'agente `docs-sync`

Ogni invocazione di `docs-sync`, non solo il playbook `clean-repo`, verifica
questo inventario nei percorsi canonici. I percorsi legacy non sono equivalenti
validi: vanno migrati e tutti i riferimenti aggiornati. **Nessun documento può
restare direttamente sotto `docs/`**: ogni file va spostato nella categoria
canonica pertinente oppure, se nessuna calza, in un nuovo folder con nome
pertinente deciso dal curator/docs-sync; al massimo un `docs/README.md` come
indice. Dopo ogni spostamento la scan repository-wide dei riferimenti
(processi, agenti, skill, script, prompt, link md, CLI help) è obbligatoria.

| Categoria | Percorso convenzionale | Artefatto richiesto |
| --- | --- | --- |
| Architecture documents | `docs/architecture/` | Markdown sull'architettura effettiva |
| Development guides | `docs/guides/` | Guide operative per sviluppatori |
| User quick guides | `docs/quick-guides/` | Flussi completi con comandi, opzioni ed esempi verificati |
| Architecture Decision Records | `docs/adr/` | ADR con decisione e contesto |
| Technical/working notes | `docs/notes/` | Note tecniche pertinenti |
| Postman | `docs/postman/` | Collection JSON importabile se esiste un backend |
| Cheat sheet | `docs/cheat-sheet/` | Elenco dei comandi reali |
| Logic diagram | `docs/diagram/` | Diagramma Mermaid del flusso logico reale |

Directory vuote, TODO e template generici non soddisfano il contratto. Se non
esiste un backend, `postman` è l'unica categoria che può essere non applicabile:
la decisione e l'evidenza vanno riportate. Gli altri percorsi devono essere
creati quando assenti e aggiornati quando il task rende il contenuto obsoleto.
In questo repository la migrazione è già stata eseguita: la directory `quick_guides/` (underscore) è diventata `quick-guides/`, `diagramma/` è confluita in `diagram/` e la `postman/` alla radice è diventata `docs/postman/`. In qualunque altro repository i percorsi legacy `quick_guides/`, `diagramma/` e la `postman/` di root NON chiudono la gap: vanno migrati ai percorsi canonici sopra durante un `clean-repo` approvato, con scan dei riferimenti obbligatoria dopo ogni spostamento.

## Job ricorrenti

Lo scheduler è **script-first**: `yano schedule add --name <nome> --project-root
<dir> --script <path> --mode <self|planner:<progetto>|yano-local-pc>
[--cron '...'] [--once] [--timeout-ms N] [--expected-consequence <testo>]`
registra un job che al trigger esegue LO SCRIPT registrato (mai shell; folder
persistente utente `<data>/scheduler/scripts/`). `yano schedule run <id>` testa
lo script subito (obbligatorio prima di renderlo ricorrente); `yano schedule
list` mostra i campi del job (script_path, mode, expected_consequence, stato).
Il routing LLM avviene DENTRO lo script via `yano invoke --role
<planner[:<scope>]|yano-local-pc> --prompt "..."` (planner di progetto o
yano-local-pc). `yano cron` resta il CRUD legacy per i job testo+cron
(`--add` frase naturale, `--list`, `--remove <id>`, `--enable <id>`,
`--disable <id>`, `--run <id>`): dispatch planner col testo come in passato.
Il cron di sistema esegue ogni minuto `yano schedule tick|supervise` (o
`yano cron --supervise`): avvia le scadenze e ricrea i servizi nel runtime
persistente `yano-local-pc` se una tab
tab Herdr è stata chiusa. Il registro è nel data-root globale e sopravvive a
riavvii; l'uninstall di Yano rimuove soltanto le sue righe cron marcate.
Vincoli non negoziabili: niente shell/token/pipe/redirezioni nei job (unico
esecutore = script validato), token solo da `.env`, azioni distruttive sempre
mediate dal planner con gate umani.

### Connessione, standby e ripristino

La supervisione globale (`yano schedule supervise`, eseguita dal cron ogni
minuto e anche dal watcher) verifica separatamente tre segnali: risoluzione di
`google.com` tramite i DNS pubblici Google `8.8.8.8`/`8.8.4.4`, connessione al
broker MQTT configurato e snapshot del server Herdr. Il cron stesso è
considerato vivo quando questa passata viene eseguita; il risultato è esposto
nel campo `checks.cron`. L'esito completo viene
registrato in `<YANO_DATA_DIR>/logs/scheduler-connectivity.jsonl` e nella
supervisione globale del watcher.

Quando lo stato passa da `online` a `offline`, il supervisore salva nel
registro scheduler i progetti attivi e mette in pausa i loro run con checkpoint
(non tocca `yano-local-pc`, scheduler o watcher). Al ritorno simultaneo dei tre
segnali riattiva esclusivamente i progetti che aveva messo in pausa lui; un
progetto messo in pausa manualmente non viene riattivato. Le transizioni sono
idempotenti e sopravvivono a spegnimento/standby del laptop: al primo tick dopo
il risveglio il supervisore riconcilia lo stato persistito.

## Matrice obbligatoria

| Modifica | Superfici da verificare |
| --- | --- |
| CLI, sottocomando o flag | `bin/yano.mjs`, `README.md`, `docs/quick-guides/quick-start.md`, quick guide pertinente, `skills-vendor/yano/yano-cli/references/command-reference.md`, `skills-vendor/yano/yano-cli/SKILL.md` |
| Stato, routing, persistenza o data-root | `docs/architecture/architecture.md`, `docs/architecture/architecture.mmd`, diagramma operativo pertinente, quick guide pertinente |
| Agente, ruolo, playbook o capability | `agents/`, prompt, `docs/guides/playbook-catalog.md`, documentazione dell'agente, skill CLI se il comando è usabile dagli agenti |
| Trace, database, indice o registro | `docs/quick-guides/yano-trace.md`, `docs/architecture/architecture.md`, diagramma trace pertinente, guide trace/Gantt |
| Installazione, harness o prerequisito | `README.md`, guida installazione, reference CLI, skill CLI, test/lint di installazione |

Quando una superficie non è applicabile, va verificato esplicitamente il
motivo nel report o nel commit. La documentazione globale descrive il
comportamento del pacchetto, le quick guide spiegano un'operazione concreta,
la skill insegna agli agenti come usare la CLI e i diagrammi descrivono
relazioni e flussi.

## Procedura per ogni modifica al codice

1. Cercare il comando, il flag, il ruolo o il percorso modificato con `rg`.
2. Aggiornare la superficie normativa (`README`, reference CLI e/o
   `docs/architecture/architecture.md`).
3. Aggiornare il percorso operativo: quick start, quick guide e cheat-sheet.
4. Aggiornare `docs/architecture/architecture.mmd` e il diagramma operativo se
   cambia un flusso o una relazione.
5. Eseguire il controllo deterministico e la suite:

   ```bash
   npm run check:docs
   npm test
   ```

Per una verifica locale che obblighi anche la presenza di modifiche documentali
quando ci sono file di codice non committati:

```bash
YANO_DOCS_ENFORCE_DIFF=1 npm run check:docs
```

Il controllo non genera testo automaticamente e non sostituisce il giudizio
del reviewer; fallisce invece quando mancano superfici fondamentali, quando il
contratto Gantt è disallineato o quando una modifica locale al codice non è
accompagnata da alcun aggiornamento documentale.

## Contratto Gantt corrente

Il Gantt è per progetto. Le porte automatiche sono nel range `10000-19999` e
la selezione usa uno slot stabile più il fallback su una porta libera. Il flag
`--persistent` registra il link nel data-root globale; `--link` recupera il
Gantt del progetto corrente e `--links` elenca tutte le registrazioni. Il
registro conserva anche un link fermo, ma il server resta un processo
foreground e il suo aggiornamento live vale finché il processo è in esecuzione.
