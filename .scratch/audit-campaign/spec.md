# Audit campaign: QA, architecture, product and toolchain

Status: implementation and verification complete; live audit execution remains on demand
Kind: task
Scope: analyze + implement reusable audit infrastructure

## Stato implementazione

L’infrastruttura è stata implementata e verificata nel repository: playbook parent e
specialistici, varianti `standard`/`medium`/`deep`, prompt, ruoli, manifest e
script D0/D1, resource ledger, metadata `campaign_id`/`chapter_id`/`phase_id`
nel tracing e routing Architect prioritizzato. Restano volutamente fuori da
questa tranche la remediation dei finding dell’app osservata e l’eventuale GUI
di code-mem: sono output della campagna, non prerequisiti del coordinatore.

La verifica finale ha completato `npm test` con 140 controlli: 28 file e 365
unit test, 31 playbook lintati, smoke test audit/routing, watcher MQTT e E2E
reale. È stato inoltre eseguito un audit iniziale read-only su code-mem usando
il report giornaliero esistente e la nuova discovery deterministica; la suite
di code-mem ha prodotto 18 pass e 10 failure condizionati dal download remoto
di `cm update --memory` in un ambiente senza rete, da riesaminare con fixture
offline nella campagna media/profonda.

## Decision summary

Yano deve distinguere cinque responsabilità, orchestrate da una sola campagna:

1. **Functional QA**: verificare che comandi, feature, API, stati e flussi
   facciano ciò che il contratto documentato e l'aspettativa umana indicano.
2. **Architecture health**: verificare se il codice è comprensibile,
   manutenibile, testabile e rifattorizzabile senza confondere igiene stilistica
   con problemi reali di design.
3. **Product health**: valutare utilità, casi d'uso, UX, GUI, comandi mancanti,
   visualizzazioni, trend, concorrenti e opportunità di mercato.
4. **Audit toolchain**: verificare prima dell'esecuzione che planner, agenti,
   skill, CLI, MCP, script e playbook siano quelli giusti per il lavoro, che le
   loro capability siano disponibili e che non si duplicino.
5. **AI-vs-deterministic delegation**: verificare per ogni fase se una parte
   possa essere eseguita da uno script deterministico, lasciando al modello
   soltanto interpretazione, scelta e gestione delle eccezioni.

La campagna non passa il repository intero a ogni agente. Un agente di discovery
crea una mappa strutturata con riferimenti a file, simboli, test, comandi e
confini; gli specialisti ricevono soltanto le sezioni assegnate. L'eventuale
riesame indipendente viene riservato ai punti critici.

Il primo incremento deve essere read-only e produrre un piano di refactor,
non modificare automaticamente codice, test, log o configurazioni del progetto
analizzato.

La delega deterministica non è un dettaglio cosmetico: è una decisione di
architettura del lavoro. L'audit deve spiegare perché un passaggio resta AI,
perché diventa script oppure perché richiede una combinazione script + AI.

Il deliverable è un **dossier capitolato**, non una relazione monolitica. Ogni
capitolo è una relazione completa, scritta da uno specialista responsabile,
con metodo, domande, evidenze, analisi, limiti, raccomandazioni e dipendenze.
Il planner governa due grafi distinti:

1. il **chapter DAG**, che stabilisce quali relazioni possono partire, quali
   dipendono da altre e quali possono essere prodotte in parallelo;
2. l'**implementation DAG**, creato dopo la sintesi, che stabilisce quali
   interventi sviluppare, in quale ordine, con quali prerequisiti e quali
   possono essere eseguiti in worktree paralleli.

Un capitolo non è pronto quando contiene una conclusione: è pronto quando ha
superato il proprio ciclo `scope -> evidence -> analysis -> review -> accepted`
oppure è stato marcato `blocked` con la causa documentata.

Ogni capitolo deve inoltre avere un **resource ledger**: tempo, token, round
visibili di inferenza, tool call, retry e modello effettivamente utilizzato.
Questo dato viene raccolto deterministicamente dal trace, non dichiarato a
memoria dallo specialista.

## Stato attuale verificato

La base esistente è utile ma incompleta per questa campagna:

- `qa-full-audit` possiede già una matrice funzionale con evidenze, effetti
  cross-command, remediation e riesecuzione completa.
- `qa-hardening` copre TDD, mutation, E2E, accessibilità e regressioni, ma non
  formalizza ancora il rapporto tra casi d'uso e test sufficienti.
- `auto-improvement-360` copre già parte di performance, architettura,
  backend/API, UX e feature, ma è un flusso sequenziale affidato a un unico
  agente generalista.
- Esistono già specialisti per sicurezza, dipendenze, performance, browser,
  accessibilità, design, benchmark di repository, osservabilità e refactor.
- Non esiste un playbook esplicito per la salute architetturale complessiva,
  né una fase condivisa che materializzi una mappa del progetto e dei tool.
- Non esiste ancora una policy che valuti sistematicamente quali passaggi AI
  possano essere sostituiti da script deterministici, né una metrica per il
  risparmio effettivo di token, tempo e retry.
- Il catalogo capability registra CLI, ma il preflight MCP/skill/script non è
  espresso con lo stesso livello di dettaglio.
- La richiesta corrente, provata con `yano architect assess`, viene oggi
  instradata verso `refactor`: è un errore di classificazione perché manca
  l'intento di audit coordinato.

Il caso `code-mem` ha già dimostrato perché servono tutti gli assi: sono emersi
disallineamento tra documentazione/test e `cm update --memory`, installazione di
dipendenze durante `scan --deep`, lock SQLite in concorrenza, comportamento di
`gx html` diverso dall'help e assenza di una vista storica sufficiente delle
statistiche. Alcuni sono bug funzionali, altri sono problemi di contratto,
operatività, osservabilità o prodotto.

Sul pilot la delega sarebbe concreta: uno script può eseguire in modo ripetibile
help, matrice comandi, hash del bundle, sequenze di init/scan/recall, snapshot
prima-dopo e harness di concorrenza; l'AI deve poi interpretare se un mismatch
è un bug, un contratto ambiguo o una scelta di prodotto. La decisione su come
dividere un file, se rimuovere una feature o se aggiungere un comando resta
invece un giudizio AI/human, perché non è riducibile a un confronto formale.

## Target architecture

### Struttura di ogni capitolo

Ogni specialista produce un file indipendente, per esempio:

```text
.scratch/<audit-id>/chapters/01-toolchain-readiness.md
.scratch/<audit-id>/chapters/02-functional-qa.md
.scratch/<audit-id>/chapters/03-test-adequacy.md
...
```

Il capitolo deve contenere sempre:

1. obiettivo e perimetro;
2. domande a cui rispondere;
3. input ricevuti dal manifesto e capitoli predecessori;
4. piano degli step e classificazione AI/script/human;
5. comandi, tool e script eseguiti con exit code e timestamp;
6. evidenze collegate a `evidence_id`;
7. fatti osservati, inferenze e ipotesi separati;
8. casi d'uso coperti, non coperti e non verificabili;
9. problemi, severità, impatto, confidenza dell'evidenza e confidenza dell'LLM nel proprio giudizio;
10. raccomandazioni motivate e alternative considerate;
11. candidate task con dipendenze e possibilità di parallelizzazione;
12. limiti, blocchi e domande rimaste aperte;
13. stato del capitolo e handoff al planner.

Il dossier contiene inoltre:

```text
.scratch/<audit-id>/chapters/<NN>-<chapter>.md
.scratch/<audit-id>/chapter-index.json
.scratch/<audit-id>/chapter-dag.json
.scratch/<audit-id>/implementation-dag.json
.scratch/<audit-id>/synthesis.md
```

`chapter-index.json` registra proprietario, stato, checksum, dipendenze,
evidence ID e ultimo aggiornamento. Il planner non deve rileggere i capitoli
completi per ogni decisione: usa l'indice, il sommario strutturato e le
evidenze puntuali.

### Resource ledger per relazione

Il dossier contiene un ledger globale e un riepilogo per capitolo:

```text
.scratch/<audit-id>/resource-ledger.jsonl
.scratch/<audit-id>/chapters/<NN>-<chapter>.usage.json
.scratch/<audit-id>/resource-summary.md
```

Ogni record deve distinguere chiaramente i diversi significati di “round”:

```text
campaign_id:
chapter_id:
phase_id:
agent_instance:
role:
model_provider:
model_id:
model_pin_or_version:
campaign_round:
agent_turn:
inference_index:
retry_index:
remediation_round:
inference_id:
started_at:
ended_at:
wall_clock_ms:
queue_or_wait_ms:
input_tokens:
output_tokens:
total_tokens:
context_tokens:
context_window_tokens:
token_source: provider | pi | estimate | unknown
tool_calls:
deterministic_calls:
retry_count:
compaction_count:
status: completed | failed | blocked | fallback
measurement: measured | estimated | unknown
trace_event_ids:
```

Il riepilogo per capitolo mostra almeno:

- durata totale, tempo in coda e tempo attivo del modello;
- token input/output/totali e contesto massimo;
- numero di inferenze, turni, retry, compattazioni e tool call;
- distribuzione per provider e modello;
- eventuali fallback di modello, con modello iniziale e sostitutivo;
- attività deterministicamente eseguite e tempo risparmiato rispetto alla
  baseline AI;
- risultato del capitolo e qualità dell'evidenza prodotta.

Le regole di misurazione sono:

- fonte primaria: eventi trace e usage metadata del provider, quando esistono;
- fonte secondaria: `context_usage` di Pi, marcato come Pi o estimate;
- se input/output token non sono esposti, valore `unknown`, mai inventato;
- il contenuto dei prompt, delle risposte e del ragionamento interno non viene
  salvato nel ledger;
- i totali devono riconciliarsi: somma delle inferenze, tool e fasi non può
  superare il parent senza spiegazione;
- il cambio modello per fallback è un evento distinto e non va conteggiato
  come se fosse lo stesso modello;
- i dati di costo monetario sono opzionali e dipendono da un listino verificato;
  token, tempo e round restano obbligatori anche quando il prezzo è unknown.

Nel runtime attuale Yano possiede già parte dei segnali necessari — identità
`provider:model`, `context_usage`, `turn_end`, tool start/end e compaction — ma
non ancora un ledger chapter-aware con input/output token provider-reported.
L'implementazione dovrà aggiungere correlazione `campaign_id/chapter_id` e
registrare gli usage fields disponibili; ciò che il provider non espone resterà
esplicitamente `unknown`.

Il conteggio deve essere prodotto da uno script deterministico, per esempio
`scripts/audit-resource-ledger.mjs`, che aggrega il trace e genera JSON/Markdown.
Il planner e l'AI usano poi il risultato per decidere se ridurre agenti,
ridurre contesto, cambiare modello o spostare un passaggio su script.

### Capitoli e dipendenze

| Capitolo | Proprietario | Può partire dopo | Dipendenze forti |
|---|---|---|---|
| Toolchain readiness | `toolchain-evaluator` | discovery parziale | manifest, ruoli, playbook, MCP |
| Architecture health | `architecture-health-reviewer` | discovery | grafo e ownership |
| Maintainability | `maintainability-reviewer` | discovery | file/symbol inventory |
| Functional QA inventory | `qa-inventory-analyst` | discovery + capability | docs, help, API, test map |
| Automation logic | `automation-control-auditor` | discovery + capability | control graph |
| Product/UX | `product-ux-analyst` | feature/GUI inventory | UI reale se presente |
| Market/competitive | `market-researcher` o ruolo product | product/UX preliminare | fonti e data di osservazione |
| AI delegation | `delegation-efficiency-auditor` | piano e manifest | trace, costi e candidate steps |
| Deterministic evidence | script specialistici | AI delegation | decisioni D0/D1 approvate dal planner |
| Functional verification | `qa-functional-verifier` | QA inventory + evidence | command/use-case matrix |
| Test adequacy | `test-adequacy-analyst` | QA inventory + test map | use-case matrix e risultati |
| Observability/performance/security | specialisti esistenti | capability gate + runtime evidence | rischio applicativo |
| Cross-chapter review | reviewer selezionati | capitoli draft | evidenze e contratti |
| Synthesis | `audit-synthesizer` | capitoli accettati | chapter index + finding IDs |

Le relazioni di architecture, maintainability, toolchain e automation possono
partire in parallelo dopo discovery. Market aspetta almeno la feature map e
una prima lettura product/UX. Functional verification e test adequacy aspettano
la matrice di QA, ma poi possono procedere in parallelo. Gli script D0/D1
devono essere eseguiti prima dell'interpretazione AI che usa la loro evidenza.

### Ciclo di vita di un capitolo

```text
planned -> assigned -> scoped -> collecting -> analyzing -> draft
    -> peer_review -> accepted
                         \\-> revision_requested -> analyzing
                         \\-> blocked
```

Il peer review non riscrive il capitolo del proprietario: segnala evidenze
mancanti, contraddizioni, claim non supportati e duplicazioni. Il proprietario
aggiorna il capitolo; il planner lo accetta solo quando i criteri sono
soddisfatti.

### Dal dossier al piano di sviluppo

La sintesi non deve generare immediatamente ticket indipendenti. Il planner
trasforma ogni raccomandazione in una scheda di implementazione:

```text
task_id:
capitolo/evidence di origine:
problema o opportunità:
tipo: bug | refactor | test | observability | feature | docs | tooling
prerequisiti:
conflitti di file/stato:
può andare in parallelo: sì/no + motivo
worktree richiesto:
test di accettazione:
rollback:
human gate:
```

Ordine di default:

1. blocchi funzionali e contratti errati;
2. logging, trace e test-oracle mancanti che servono a lavorare in sicurezza;
3. refactor strutturali che riducono il rischio dei task successivi;
4. remediation di performance, security e reliability;
5. feature e miglioramenti UX ad alto valore;
6. opportunità di mercato e miglioramenti a bassa priorità.

L'ordine effettivo dipende dal grafo: un refactor può anticipare una feature se
riduce il rischio e abilita più task, ma non va fatto senza baseline e test.

### Playbook pubblici

| Playbook | Responsabilità | Decisione |
|---|---|---|
| `audit-campaign` | Coordina discovery, preflight capability, workstream e sintesi | Nuovo; user-facing per “valuta tutto” |
| `qa-full-audit` | QA funzionale, casi d'uso, regressioni e adeguatezza dei test | Estendere; mantenere ID e compatibilità |
| `architecture-health-audit` | Confini, complessità, duplicazioni, dead code, refactor e logica degli automatismi | Nuovo |
| `auto-improvement-360` | Prodotto, UX, GUI, comandi, trend, competitor e opportunità | Estendere; chiarire il perimetro product-health |
| `qa-hardening` | Approfondimenti di test: mutation, fuzzing, E2E, a11y e robustezza | Riutilizzare come specialista |
| `performance-observability` | Performance, logging, metriche, trace e diagnosi runtime | Riutilizzare come specialista |
| `security-review` | Sicurezza applicativa e dipendenze | Riutilizzare solo se il profilo di rischio lo richiede |
| `design-redesign` | Review visuale, GUI, prototipo e design-to-code | Riutilizzare solo se esiste una UI |
| `get-the-best-from` | Confronto con repository indicati dall'utente | Riutilizzare per benchmark tecnico specifico |

`audit-campaign` è un coordinatore con dipendenze tra fasi, non una copia di
tutti i contenuti degli altri playbook. Un audit specialistico può essere
eseguito da solo; una campagna completa li compone usando gli stessi artefatti
di discovery.

### Varianti di profondità

Ogni campagna e `qa-full-audit` espongono esplicitamente `standard`, `medium` e
`deep`. Il nome `quick-gate` non va usato come sinonimo ambiguo di standard.

| Variante | Team indicativo | Copertura | Uso |
|---|---:|---|---|
| `standard` | 3-4 agenti | discovery, capability preflight, QA principale, test-gap essenziale, sintesi | controllo periodico o pre-merge |
| `medium` | 6-8 agenti in due ondate | aggiunge architettura, automatismi, osservabilità, UX e test adequacy approfondita | revisione mensile o prima di una release importante |
| `deep` | 9-12 agenti in ondate limitate | cross-check indipendenti, mutation/fuzz, concorrenza, browser, sicurezza, performance, mercato, refactor map e full rerun | revisione tecnica/prodotto completa |

Budget iniziali da calibrare durante il pilot:

- standard: 100 comandi, 250 file, 45 minuti, 15k token;
- medium: 220 comandi, 500 file, 90 minuti, 30k token;
- deep: 450 comandi, 1.000 file, 180 minuti, 60k token.

I budget sono massimali globali e devono essere suddivisi per workstream. Un
agente non può consumare tutto il budget lasciando senza evidenza gli altri
assi.

## Fasi della campagna

### Fase 0 — Scope e rischio

Il planner chiarisce progetto, checkout/worktree, variante, obiettivi e vincoli.
Classifica i rischi iniziali: CLI, backend, frontend, dati, concorrenza,
security, AI/LLM, deployment, mercato. Definisce anche ciò che resta fuori.

### Fase 1 — Discovery condivisa

`repo-cartographer` produce:

- inventario dei file con hash e categoria;
- simboli, file grandi e punti ad alta complessità;
- grafo import/chiamate/dipendenze;
- inventario comandi, flag, API, GUI routes e feature;
- matrice documentazione/codice/help/test;
- mappa dei test e dei runner;
- mappa di persistenza, stato, side effect e lock;
- grafo di automatismi: hook, watcher, scheduler, agenti, script e playbook;
- mappa preliminare delle capability richieste;
- aree sconosciute e motivi per cui richiedono lettura aggiuntiva.

Output nel workspace di audit, non nel prodotto:

```text
.scratch/<audit-id>/audit-manifest.json
.scratch/<audit-id>/project-map.md
.scratch/<audit-id>/evidence/index.jsonl
.scratch/<audit-id>/handoffs/<agent>.md
```

Ogni elemento ha un `evidence_id`, riferimenti a file/simbolo/intervallo,
proprietario di lettura e stato `verified`, `inferred` o `unknown`.

### Fase 2 — Toolchain and capability preflight

Prima di lanciare i workstream, `toolchain-evaluator` controlla ogni capability
proposta con questa scheda:

```text
Capability:
Tipo: skill | cli | mcp | script | playbook | api
Scopo:
Workstream che la richiede:
Disponibile e versione:
Probe eseguita:
Permessi e superficie di scrittura:
Rete/autenticazione necessarie:
Output machine-readable:
Timeout e cleanup:
Determinismo e ripetibilità:
Costo stimato:
Fallback:
Duplicata da:
Verdetto: required | optional | unavailable | rejected
```

Regole:

- non installare dipendenze durante un audit read-only;
- non usare `npx -y ...@latest` come prova di ripetibilità senza registrare
  versione e rischio;
- non assegnare MCP browser a un progetto senza frontend verificabile;
- non usare Stitch per una semplice analisi statica;
- non usare GitHub/MCP per dati che il repository locale già contiene;
- usare MongoDB/Postman solo se il progetto espone davvero quel contratto;
- ogni capability mancante diventa `BLOCKED` con fallback, mai un'invenzione;
- il planner riceve una lista minima di capability per ruolo, non l'intero
  catalogo disponibile.

Capability baseline già presenti e da riusare quando applicabili:

- `rg`, `git`, `node`, `npm`, `npx`, `curl`, `yano`, `cm`;
- runner e script nativi del progetto;
- Playwright/Cypress e `chrome-devtools` per browser;
- `semgrep` per SAST quando disponibile;
- Docker/Compose per ambienti isolati;
- MCP `chrome-devtools`, `agentation`, `stitch`, `github`, `mongodb` solo con
  requisito dimostrato.

Il registro capability va esteso per descrivere anche MCP, skill e script:
probe, versione, rete, rischio, output, fallback e ruoli autorizzati. Il lint
deve verificare che una dichiarazione in playbook/ruolo sia risolvibile e che
non assegni una capability adatta a un altro workstream solo per comodità.

### Fase 3 — AI-vs-deterministic delegation

`delegation-efficiency-auditor` analizza il piano di lavoro e crea una scheda
per ogni step significativo:

```text
step_id:
Owner attuale: AI | script | human | mixed
Input e precondizioni:
Output richiesto:
Serve giudizio semantico?
Serve contesto non strutturato?
È ripetitivo e verificabile?
Ha side effect?
Costo attuale: turni, token, tempo, tool calls, retry
Alternativa: deterministic | script_plus_ai | keep_ai | human_gate
Risparmio atteso:
Rischio di automazione:
Fallback:
Prova di equivalenza:
Verdetto:
```

La classificazione operativa è:

- **D0 — deterministic now**: inventory di file, hash, `--help`, parsing JSON,
  raccolta exit code, snapshot before/after, confronto di output, deduplica,
  controlli di stato, timeout, cleanup, scheduling e validazioni di schema;
- **D1 — script + AI**: lo script raccoglie e normalizza evidenza, il modello
  interpreta anomalie, ambiguità o priorità;
- **AI required**: aspettativa umana, trade-off architetturali, UX, mercato,
  root cause non evidente, decisioni di prodotto e casi nuovi;
- **Human gate**: azioni distruttive, promozioni, refactor ad alto rischio,
  cambi di scope e decisioni di valore.

Uno script candidato deve essere deterministico o avere la variabilità
dichiarata, idempotente, riproducibile, versionato, limitato al worktree
assegnato, esplicito su `stdout`, `stderr`, exit code e JSON, dotato di timeout,
cleanup, dry-run e redazione dei segreti, capace di produrre `evidence_id`,
timestamp, versione e checksum, privo di installazioni o rete implicite e
verificabile con fixture e test di regressione. Deve inoltre essere più
economico del passaggio AI che sostituisce.

Per ogni delega approvata si misurano prima e dopo:

- token di input/output e dimensione del contesto;
- numero di turni, tool call, retry e riletture;
- tempo di wall-clock e tempo attivo del modello;
- errori, falsi positivi, falsi negativi e BLOCKED;
- costo di manutenzione dello script;
- qualità e riproducibilità dell'evidenza.

Le primitive Yano già adatte sono lo scheduler script-first (`yano schedule
add/run`), i check deterministici del watcher, `yano trace`, `yano test-env
allocate`, i runner nativi del progetto e i comandi JSON. Il modello deve essere
invocato solo quando serve interpretazione, tramite il percorso controllato del
planner; lo script non deve aggirare i gate di sicurezza o il tracciamento.

### Fase 4 — Workstream paralleli controllati

Dopo il manifesto, il planner apre soltanto le sezioni necessarie.

#### A. Functional QA

Confronta quattro fonti:

1. documentazione e requisiti;
2. help e interfacce realmente esposte;
3. codice e stato persistente;
4. test e comportamento osservato.

Per ogni comando o feature registra:

- aspettativa umana;
- precondizioni;
- input validi, invalidi e limite;
- output e exit code;
- effetto sullo stato;
- conseguenze sui comandi successivi;
- errori leggibili e recovery;
- idempotenza, retry, timeout e concorrenza;
- evidenza PASS/FAIL/BLOCKED.

#### B. Test adequacy

`test-adequacy-analyst` non chiede soltanto “la suite passa?”. Costruisce una
matrice:

```text
use_case -> requisito -> stato/percorso -> test -> oracle -> evidenza
```

Controlla almeno:

- casi d'uso documentati e casi d'uso impliciti;
- happy path, input invalidi, boundary e partizioni di equivalenza;
- transizioni di stato e flussi cross-command;
- errori, timeout, retry, rollback e dati corrotti;
- prima installazione, upgrade, ambiente vuoto e dipendenze mancanti;
- idempotenza e concorrenza;
- persistenza, import/export e migrazioni;
- API contract e CLI contract;
- GUI/E2E, responsive e accessibilità quando applicabili;
- proprietà invarianti, fuzzing e mutation testing;
- flaky test, test senza oracle e test che verificano soltanto output parziali.

La line coverage è solo un segnale. L'adeguatezza usa anche percentuale di
use case critici mappati, transizioni coperte, mutation score sui moduli critici,
forza degli oracle, flakiness e casi BLOCKED.

#### C. Architecture health

Controlla:

- responsabilità e confini dei moduli;
- dimensione e complessità di file/funzioni;
- dipendenze circolari e accoppiamento;
- duplicazione sintattica e semantica;
- dead code candidato, feature flag e percorsi legacy;
- nomi, API interne, import/export e source of truth;
- side effect, stato globale, error handling e resource lifecycle;
- testabilità e seam di refactor;
- build/generated files e deriva tra codice e configurazione.

Ogni proposta di estrazione specifica invarianti, export pubblici, effetti
collaterali, test-oracle e rollback. Il refactor non parte nello stesso round
della diagnosi.

#### D. Automation/control logic

Per ogni hook, watcher, scheduler, script, playbook, agente e controllo
automatico verifica:

- scopo e trigger;
- input e precondizioni;
- output e destinatari;
- stato modificato;
- dipendenze downstream;
- retry, timeout, idempotenza e cleanup;
- falsi positivi/negativi;
- logging e trace;
- comportamento in caso di errore;
- corrispondenza tra nome, help, prompt e implementazione;
- sovrapposizione con altri controlli;
- capacità di riprodurre il risultato.

#### E. Observability, reliability, performance and security

Gli specialisti verificano, solo quando applicabili:

- presenza di log strutturati con correlation/run ID;
- distinzione tra evento, errore, warning e risultato;
- redazione di token, PII e prompt sensibili;
- metriche di latenza, throughput, errori, retry e lock;
- trace per ricostruire un fallimento;
- cleanup di processi, file temporanei, lock e server;
- benchmark ripetibili e baseline;
- CVE, secrets, injection, autenticazione e autorizzazione;
- dipendenze e licenze.

L'assenza di log non viene “risolta” automaticamente dall'audit: viene
registrata come gap e indirizzata a un successivo task di observability.

#### F. Product, UX, GUI and market

Controlla casi d'uso umani, naming, onboarding, opzioni mancanti, comandi per
trend/metriche, GUI, visualizzazioni, messaggi di errore, accessibilità,
concorrenti e white-space. Le conclusioni di mercato richiedono fonti e data
di osservazione; le impressioni vengono marcate come ipotesi.

### Fase 5 — Boundary cross-check

Il planner seleziona solo i finding ad alto rischio per un riesame indipendente:

- QA verifica se il comportamento osservato è riproducibile;
- architecture verifica se la causa è strutturale;
- automation verifica se il controllo che avrebbe dovuto rilevarla funziona;
- test adequacy verifica se esiste un oracle sufficiente.

Gli agenti non rileggono i moduli interi: il cross-check parte da interfacce,
evidence ID, simboli e intervalli già indicati nel manifesto.

### Fase 6 — Synthesis and refactor map

`audit-synthesizer` deduplica e ordina i finding con:

```text
finding_id
categoria
classificazione: fact | inference | hypothesis
evidence_ids
file/simbolo
impatto utente/tecnico
severità
confidenza
duplicato_di
dipendenze
azione proposta
test di regressione
```

Deliverable:

- executive summary;
- matrice feature/comando/use-case/test;
- architecture review;
- automation/control matrix;
- toolchain readiness report;
- observability and risk gaps;
- product/UX/market gap matrix;
- refactor map con ordine e prerequisiti;
- quick wins separati dai refactor strutturali;
- backlog prioritizzato;
- limiti, BLOCKED e domande per l'utente.

## Roster proposto

### Ruoli da riusare

`planner`, `qa-inventory-analyst`, `qa-functional-verifier`, `mutation-tester`,
`e2e-simulator`, `a11y-tester`, `speed-benchmarker`, `security-evaluator`,
`dependency-health`, `design-redesign-specialist`, `repo-benchmarker`,
`auto-improver`, `watcher`, `refactoring-specialist`, `docs-sync`.

`observability-agent` non va usato come auditor perché il brief attuale gli
consente di iniettare logging: serve un ruolo read-only distinto.

### Nuovi ruoli da progettare

| Ruolo | Input | Output | Scrittura progetto |
|---|---|---|---|
| `repo-cartographer` | repository e manifesto precedente | project map, manifest, file/symbol ownership | no |
| `toolchain-evaluator` | manifest, ruoli, playbook, config MCP | capability readiness e fallback | no |
| `delegation-efficiency-auditor` | piano di lavoro, trace, costi e controlli | AI-vs-script classification e stima risparmio | no |
| `test-adequacy-analyst` | use-case matrix, test map, trace | coverage envelope e test gaps | no |
| `architecture-health-reviewer` | moduli, grafo, finding strutturali | architecture review | no |
| `maintainability-reviewer` | file/function inventory, ownership | duplication/dead-code/complexity review | no |
| `automation-control-auditor` | control graph, script, prompt, playbook | control matrix e failure modes | no |
| `observability-reviewer` | logging, trace, runtime evidence | observability/reliability review | no |
| `product-ux-analyst` | feature map, GUI evidence, user journeys | product/UX gap report | no |
| `refactor-planner` | findings approvati dal planner | refactor map sequenziata | no |
| `audit-synthesizer` | report e evidence ID di tutti i ruoli | report finale deduplicato | solo workspace audit |

Nessun ruolo nuovo deve ricevere automaticamente tutte le capability. Il
manifesto genera un brief specifico per workstream con sezione `already_read`,
`do_not_reread`, `assigned_files`, `allowed_expansion` e budget residuo.

## Protocollo anti-rilettura

1. **Read once, publish many**: discovery legge la struttura; i risultati
   diventano evidenza riutilizzabile.
2. **Ownership dei simboli**: ogni file/simbolo ha un agente principale.
3. **Boundary-only overlap**: gli altri agenti leggono solo interfacce e
   intervalli necessari, salvo richiesta motivata.
4. **Evidence expansion**: un agente può chiedere al planner un'espansione
   circoscritta; non può spawnare liberamente subagenti.
5. **Cache incrementale**: nei run giornalieri, file invariati riusano manifest
   e sintesi; i file modificati invalidano solo i nodi dipendenti.
6. **Critical dual review**: due letture indipendenti solo per blocker,
   cambiamenti di stato, sicurezza, concorrenza o refactor ad alto rischio.
7. **Code Mem disciplinato**: salvare in memoria termini, decisioni e mapping
   stabili; non salvare sorgente grezzo, segreti o dump di log.
8. **Synthesis per ID**: il report finale raggruppa per finding/evidence ID e
   non per agente, così la duplicazione viene eliminata prima della consegna.
9. **AI only where needed**: prima di spawnare un agente o passargli un nuovo
   blocco di codice, verificare se il lavoro può essere svolto da uno script
   deterministico o da uno script che prepara l'evidenza per un agente.

## Capability evaluation matrix

| Categoria | Capability candidata | Quando abilitarla | Controllo obbligatorio |
|---|---|---|---|
| discovery | `rg`, `git`, `node` | sempre | versione, root, no segreti |
| progetto | `npm`, runner nativo, `cm` | se presenti | script reali, exit code, isolamento |
| Yano | `yano`, `yano architect`, `yano trace`, `yano deps` | audit di Yano o agenti | help prima, JSON, root coerente |
| static | parser AST, typecheck, lint, dep graph, duplication | se supportati dal progetto | nessuna installazione implicita |
| test | unit/integration/E2E, coverage, mutation/fuzz | in base a rischio e varianti | oracle, flakiness, cleanup |
| browser | Playwright, `chrome-devtools`, Agentation | GUI/frontend reale | porte isolate, console/rete/screenshot |
| runtime | Docker/Compose, `curl` | integrazione o servizi | ambiente isolato e timeout |
| security | Semgrep, audit dipendenze, secret scan | sempre in `deep`, rischio alto in `medium` | redazione e versioni |
| data/API | Postman, OpenAPI, MongoDB | solo con API/DB dimostrati | dati sintetici e no produzione |
| research | web/official docs, GitHub | competitor o dipendenze attuali | fonte, data, licenza, HTTPS |
| design | Stitch | redesign/prototipo richiesto | auth/costo e perimetro UI |

MCP e CLI non sono intercambiabili: MCP è un canale d'interazione e va
verificato per server, autenticazione e superficie; CLI/script sono esecuzioni
locali e vanno verificati per versione, output, exit code, timeout e side effect.

## Piano di implementazione

### P0 — Contratto e routing

- definire schema di `audit-manifest`, `finding` e `capability verdict`;
- definire schema di `delegation decision` con costo baseline, alternativa,
  risparmio misurabile, rischio e prova di equivalenza;
- aggiungere intenti `audit campaign`, `architecture health`, `test adequacy`,
  `automation logic`, `toolchain readiness`, `product health` e
  `deterministic delegation`;
- correggere la precedenza in `scripts/yano-architect.mjs`: audit coordinato
  prima di `refactor`, QA generico e frontend generico;
- aggiungere smoke test per la selezione di standard/medium/deep e per la
  richiesta corrente;
- verificare che un refactor esplicito continui a usare `refactor`.

### P1 — Discovery e capability preflight

- progettare `scripts/audit-manifest.mjs` read-only e riutilizzabile;
- progettare `scripts/audit-delegation.mjs` o una sezione del manifesto che
  identifichi operazioni ripetitive candidabili a script;
- progettare `scripts/audit-resource-ledger.mjs` per aggregare il trace per
  campagna, capitolo, agente, modello e round;
- estendere gli eventi trace con la correlazione chapter-aware e usage metadata
  provider-reported quando disponibili;
- estendere `agents/capabilities.yaml` con metadati di probe, rischio,
  rete, output e fallback;
- estendere il lint per skill, CLI, MCP, script e playbook;
- introdurre `repo-cartographer` e `toolchain-evaluator` con prompt dedicati;
- aggiungere checkpoint e invalidazione incrementale per hash.

### P2 — Playbook

- creare `playbooks/audit-campaign.yaml`;
- creare `playbooks/architecture-health-audit.yaml`;
- definire nel coordinatore `chapter_dag`, `parallel_groups`, `checkpoint` e
  `implementation_dag` come deliverable distinti;
- inserire nel coordinatore una policy che privilegi script deterministici per
  raccolta, confronto, stato, retry, cleanup e validazione formale;
- modificare `qa-full-audit.yaml` con varianti reali e fase `test_adequacy`;
- chiarire `auto-improvement-360.yaml` come product/UX/market audit e togliere
  sovrapposizioni architetturali non necessarie;
- mantenere `qa-hardening`, performance, security e design come follow-up
  selezionabili dalla campagna.

### P3 — Ruoli e prompt

- aggiungere i nuovi ruoli elencati sopra in `agents/roles.yaml`;
- aggiungere prompt con brief, scope di lettura, output e divieti;
- fare in modo che ogni specialista sia autore di un capitolo completo, non
  soltanto produttore di una lista di osservazioni;
- aggiungere un peer reviewer per i capitoli ad alto rischio e un gate di
  accettazione gestito dal planner;
- riusare gli specialisti esistenti senza duplicare capability;
- separare `observability-reviewer` da `observability-agent` mutante;
- definire topology per variante e massimo di agenti concorrenti.

### P4 — Report e integrazione

- produrre i report intermedi nel workspace `.scratch/<audit-id>`;
- registrare lifecycle, proprietario, dipendenze, checksum e stato di ogni
  capitolo in `chapter-index.json`;
- allegare a ogni capitolo il riepilogo di tempo, token, inferenze, modelli,
  tool call, retry, fallback e compattazioni;
- registrare per ogni fase se è stata eseguita da AI, script, human gate o
  combinazione script + AI;
- misurare token, tempo, tool call, retry, riletture e qualità prima/dopo ogni
  sostituzione proposta;
- aggiungere sintesi, deduplicazione e prioritizzazione per evidenza;
- integrare Code Mem solo per memoria stabile e recupero di report precedenti;
- far usare al watcher i checkpoint e gli evidence ID, non scansioni complete;
- distinguere finding, ticket di remediation e task di implementazione.

### P5 — Documentazione e validazione

- aggiornare catalogo playbook, quick guide, cheat-sheet, architecture docs,
  diagrammi e `yano-cli` reference;
- aggiungere smoke test di routing, capability readiness, resume e anti-duplicate
  reading;
- eseguire `npm run check:docs`, `npm test`, `npm run lint:playbooks`,
  `npm run lint:capabilities` e i check di sintassi;
- eseguire la campagna su Yano in modalità read-only;
- eseguire standard, medium e deep sul clone isolato di `code-mem`;
- confrontare i finding con l'ultimo report giornaliero e registrare ciò che
  il nuovo audit rileva in più o in meno.

## Criteri di accettazione

- La richiesta “valuta completamente architettura, test, comandi, tool, MCP,
  script, playbook, UX e mercato” raccomanda `audit-campaign`.
- Una richiesta di solo refactor continua a raccomandare `refactor`.
- Il manifesto viene creato una sola volta per run e ogni specialista riceve
  un perimetro verificabile.
- Il dossier contiene capitoli autonomi, ognuno con metodo, evidenze, analisi,
  limiti, raccomandazioni e stato `accepted` o `blocked`.
- Il planner non sintetizza né ordina lo sviluppo finché i capitoli necessari
  e i loro peer review non sono accettati.
- La sintesi produce un `implementation-dag` che distingue attività
  sequenziali, parallele, conflitti di file, prerequisiti e human gate.
- Ogni capitolo e il dossier complessivo mostrano tempo, token, round visibili
  di inferenza, modelli usati e distinzione tra dati misurati, stimati e
  unknown.
- Un tool assente produce `BLOCKED` e fallback esplicito, non una conclusione
  simulata.
- Ogni fase significativa ha una decisione AI/script esplicita; le operazioni
  ripetitive vengono candidate a script e il risparmio viene misurato, non
  soltanto stimato.
- Uno script promosso produce la stessa evidenza verificabile del passaggio AI,
  con exit code, JSON, checksum, timeout, cleanup e test di regressione.
- Il report mostra use case coperti, use case non coperti, test deboli, test
  mancanti e limiti ambientali.
- Il report separa fatti, inferenze e ipotesi di prodotto/mercato.
- Nessun agente di audit modifica il progetto osservato.
- Il run è riprendibile da checkpoint e i file invariati non vengono riletti
  inutilmente.
- La sintesi deduplica finding sovrapposti mantenendo tutte le evidenze.
- Tutte le superfici documentali richieste dal repository sono aggiornate e i
  test/lint del pacchetto passano.

## Rischi e decisioni da mantenere

- La mappa condivisa può diventare obsoleta: hash e invalidazione sono
  obbligatori.
- La line count non è una prova di cattiva architettura; va collegata a
  responsabilità, complessità, dipendenze e costo di modifica.
- Il dead code è sempre una candidatura finché import dinamici, reflection,
  plugin e runtime non sono stati esclusi.
- Un sistema di logging va progettato come remediation separata, con privacy,
  retention e performance; l'audit non deve iniettare log di propria iniziativa.
- Non tutto deve diventare script: uno script che cristallizza un'interpretazione
  incerta può ridurre token ma peggiorare la qualità. Il criterio è il rapporto
  tra costo risparmiato, rischio e forza della verifica.
- Il research web è obbligatorio solo per fatti variabili e competitor; il
  report deve indicare fonte e data.
- Più agenti non significano più qualità se analizzano lo stesso contesto: il
  planner deve imporre ownership, budget, overlap e sintesi per evidenza.
- La campagna deve restare read-only fino alla decisione dell'utente su quali
  remediation e refactor trasformare in lavoro.

## Next action

La prossima implementazione consigliata è P0 + P1 in un worktree separato,
seguita da una campagna `standard` su `code-mem`. Solo dopo aver verificato il
manifesto, il routing e la qualità dei report conviene attivare la variante
`deep` e promuovere il catalogo globale.
