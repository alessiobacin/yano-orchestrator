# Agenti esterni Yano: versione corrente e roadmap

Questo documento è la fonte di verità per distinguere ciò che è già
implementato da ciò che è stato deciso ma deve ancora essere sviluppato. Le
future feature non devono essere interpretate come comportamento disponibile.

## Regola comune

Watcher, debugger, auto-improver e suggester sono sensori/analisti esterni.
Nessuno modifica il progetto di riferimento, crea commit o worktree, apre
ticket operativi nel progetto, fa deploy o promuove codice. Raccolgono
evidenze, producono un report e notificano il planner. Il planner, dopo
eventuale decisione del superadmin/utente, usa il flusso normale
`to-spec → to-tickets → coder → reviewer → docs-sync`.

## Watcher

### Implementato nella v1

- scansione bounded e read-only di liveness, ticket stall e trace;
- distinzione tra errore del progetto e finding ad alta confidenza di Yano;
- deduplicazione deterministica delle segnalazioni;
- ticket di manutenzione Yano in `yano-orchestrator/.scratch/optimize-orchestrator/issues`;
- `type: debugger`, `created_by: yano-watcher`, riferimenti trace e Telegram;
- handoff MQTT al planner vivo, Telegram se non esiste un planner vivo;
- risoluzione di `YANO_ORCHESTRATOR_REPO` dalla configurazione Yano autorizzata.
- comando di test singolo `yano watch --once`.
- ruolo `watcher` con skill observer e trace analysis;
- workspace globale `yano-watcher` con una tab per progetto, avviata come agente
  Pi reale tramite `herdr agent start` (non come semplice comando in un pane);
- nome Herdr normalizzato entro 32 caratteri e nome MQTT distinto per progetto.

### Da sviluppare dopo

- audit LLM del flusso tra planner e worker con rilevamento di sovrapposizioni;
- metriche cross-project su agenti stale, wake-up persi e round bloccati;
- digest e soppressione degli alert ripetitivi;
- intervallo adattivo e backoff quando un progetto è inattivo;
- dashboard read-only e integrazione diretta con il futuro `yano-debugger`.

## Debugger

### Implementato nella v1

- intake/registro globale dei bug e fingerprint per progetto;
- workspace Herdr `yano-debugger` con una tab per progetto;
- lifecycle diagnostico `reported → triaged → reproducing → not_reproducible|blocked`;
- evidenze di trace, Git e superfici osservabili;
- matrice porte paired dev/staging/production;
- vincolo esplicito: nessuna fix, modifica, deploy o promozione automatica.
- preflight singola `yano debugger start --once`, senza Herdr persistente.

### Da sviluppare dopo

- ricevitore HTTP/FAB autenticato per bug degli utenti;
- riproduzione automatica in sandbox isolata e raccolta di test evidence;
- correlazione con feedback di produzione, versioni e deployment digest;
- consumo automatico dei ticket Yano creati dal watcher;
- code review della diagnosi, trend di regressione e dashboard per il planner;
- eventuale percorso assistito verso staging, sempre come task deciso dal planner.

## Auto-improver

### Implementato nella v1

- audit periodico configurabile, default `5d`;
- workspace Herdr `yano-auto-improver`, una tab per progetto;
- evidence pack di manifest, Git, test/lint/build, trace, feedback e piano di retrieval;
- SQLite globale, report e raccomandazioni in `temp/auto-improver/`;
- notifiche Telegram, WhatsApp e SendGrid configurabili;
- report e handoff al planner, senza ticket o modifica del progetto.
- modalità singola `yano auto-improve run|start --once`, senza scheduler detached.

### Da sviluppare dopo

- embedding locale realmente usato per similarità cross-audit/cross-project;
- summarization per ogni round/task e memoria dei pattern sistemici;
- confronto con baseline di performance, costo e qualità;
- scheduling adattivo, digest e dashboard delle raccomandazioni;
- priorità calcolata da valore, rischio, evidenza e feedback accettati dal planner.

## Suggester

### Implementato nella v1

- `yano suggester init/start/submit/status/reports/complete/approve/reject/pause/resume/stop`;
- SQLite globale in `temp/suggester/suggester.sqlite`;
- workspace Herdr `yano-suggester`, una tab per progetto;
- intake CLI con source, user, priorità, route e app version;
- redazione di pattern comuni di segreti e fingerprint esatto;
- report/evidence read-only, classificazione `bug/feature/improvement/ux` e stato `awaiting_approval`;
- gate superadmin: il planner viene notificato soltanto dopo `approve`;
- notifica MQTT al planner e canali già configurati dopo l'approvazione.
- modalità singola `yano suggester start|submit --once` per test bounded.

### Da sviluppare dopo

- endpoint HTTP signed e FAB nell'app, installati solo tramite un task del planner;
- autenticazione per progetto, rate limiting, anti-spam e gestione PII/retention;
- deduplicazione semantica con embedding locale e clustering di suggerimenti simili;
- allegati, screenshot, contesto browser e associazione a bug/versioni;
- votazione, trend, consenso del superadmin e dashboard di triage;
- adapter verso il sistema ticket locale senza bypassare `to-tickets`;
- digest e notifiche mirate all'utente che ha inviato il suggerimento.

## Architect

### Implementato nella v1

- assessment dell'intento e scelta bounded di un playbook/ruoli candidati;
- proposta ephemeral con manifest, checksum e database globale;
- gate obbligatorio per skill, CLI e MCP, con MCP `pending` finché non è
  documentato un handshake reale;
- workspace Herdr globale `yano-architect` e watcher di validazione
  `yano-watcher` allo stesso livello degli altri agenti esterni;
- intervallo validation → feedback planner/utente → promozione esplicita;
- catalogo read-only `yano playbook` e `yano agent`;
- ruoli promossi risolti dal launcher tramite configurazione runtime unita,
  senza copiare infrastruttura nel progetto osservato;
- modalità `yano architect ... --once` per il capability gate senza Herdr.

### Da sviluppare dopo

- matching semantico tra intento e playbook esistenti prima di generare un
  nuovo flusso;
- install adapters firmati per skill, CLI e MCP con allowlist configurabile;
- handshake MCP automatico tramite adapter ufficiali e attestazioni con TTL;
- diff/patch conversazionale del playbook e confronto tra versioni;
- metriche cross-project su promozioni, revisioni e capability mancanti;
- rollback/promozione graduata del catalogo e firma degli artefatti.

## Ordine consigliato delle prossime iterazioni

1. Hardening comune: autenticazione, redazione, retention e metriche di
   consegna dei quattro agenti.
2. Watcher/debugger: correlazione dei finding Yano e riproduzione sandbox.
3. Suggester: receiver HTTP/FAB e matching semantico, mantenendo sempre il
   gate del superadmin.
4. Auto-improver: memoria cross-project, baseline e dashboard.

Ogni nuova feature va aggiunta qui con una sezione `Implementato nella vN`,
una sezione `Da sviluppare dopo` e almeno un test smoke/E2E prima di essere
presentata come disponibile.
