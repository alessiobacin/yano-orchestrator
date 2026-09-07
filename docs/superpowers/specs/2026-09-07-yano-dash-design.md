# `yano dash` — dashboard unificata bug/suggestions, sempre attiva

Data: 2026-09-07
Stato: approvato, in implementazione

## Contesto

Yano ha oggi due dashboard Kanban separate, avviate manualmente e su porte
diverse: `yano bug-dash` (porta preferita 11000, fallback 11000-11999) e
`yano suggest-dash` (porta preferita 12000, fallback 12000-12999). Entrambe
sono servite da `scripts/yano-feedback-dashboard.mjs`, che genera l'intera
pagina (HTML+CSS+JS) come un'unica stringa template lato server (~500 righe)
e duplica al suo interno una parte della logica REST già presente in
`scripts/yano-feedback.mjs`.

Questo file contiene un bug concreto già in produzione, non solo un difetto
estetico: le funzioni `shot()`, `wireCards()`, `wireColumns()` e `render()`
sono definite **due volte** — la seconda sovrascrive silenziosamente la
prima senza errori, lasciando nel file la versione vecchia come codice morto
confuso da mantenere. `scripts/smoke-test-feedback-dashboard.mjs` esiste
apposta perché in passato un errore di escaping nella stringa template ha
prodotto uno `SyntaxError` che uccideva **l'intero** script inline lato
browser — la board non si è mai renderizzata, in nessun browser, finché non
è stato scritto quel test. Questo conferma che il pattern "un'unica grande
stringa HTML generata lato server" è strutturalmente fragile per una UI di
questa complessità.

L'utente vuole un'unica GUI web (`yano dash`), semplice, che sostituisca
entrambe le dashboard, ispirata nell'interazione (board Kanban, drag&drop,
pannello di dettaglio laterale, aggiornamenti quasi live) a progetti maturi
come **kanban-code** (langwatch), **vibe-kanban** (BloopAI) e
**ai-agent-board** (DanWahlin) — non per l'infrastruttura (loro orchestrano
agenti/worktree), solo per il pattern di interazione Kanban.

**Fuori ambito, esplicitamente confermato dall'utente**: nessuna modifica a
newMioDOC o ad altri progetti esterni, né ora né come follow-up.

## Decisioni già prese con l'utente

1. Ambito: solo `yano-orchestrator`. NewMioDOC non viene toccato.
2. Stack UI: nessun build step. Preact + htm via CDN, Tailwind via CDN,
   moduli ES nativi serviti come file statici — coerente con le sole due
   dipendenze npm che il progetto ha oggi (`mqtt`, `yaml`).
3. Board: **unica**, con tab in alto Bug 🪲 / Suggestion 💡 / Tutti. Le
   colonne di stato cambiano in base al tab selezionato; in "Tutti" le card
   di entrambi i tipi condividono le colonne di stato comuni, distinte da
   un'iconcina.
4. Comandi legacy: **taglio netto**. `yano bug-dash` e `yano suggest-dash`
   vengono rimossi, non redirect/alias.
5. **Nuovo in questo giro**: la dashboard deve restare **sempre attiva** non
   appena Yano è installato globalmente, raggiungibile su
   `http://localhost:11000` senza dover lanciare alcun comando a mano. Se la
   11000 è occupata, Yano sceglie una porta di fallback nel range
   11000-11999 e manda un messaggio sul canale di notifica globale
   configurato (`yano config set ...`) indicando quale porta ha scelto.

## Architettura

### Riuso del layer dati (invariato)

`scripts/yano-feedback.mjs` resta l'unica fonte di verità: SQLite
(`node:sqlite`), audit trail per ogni mutazione, cifratura delle credenziali
E2E dei bug, coda FIFO per progetto, notifica MQTT al planner. Non cambia lo
schema né la logica di dominio. L'unica modifica è **esportare** la funzione
che oggi gestisce le richieste REST (oggi `api(db, req, res)`, non
esportata, usata solo da `runYanoFeedback`'s `serve`) come
`handleFeedbackApi(db, req, res)`, così può essere montata anche dal nuovo
processo dashboard invece di essere reimplementata una seconda volta come
accade oggi in `yano-feedback-dashboard.mjs`.

`yano feedback serve` (porta 20002, headless, usato da chi integra
dall'esterno) resta invariato nell'uso esterno e continua a montare la
stessa funzione condivisa.

### Nuovo processo `yano dash`

- `scripts/yano-dash-state.mjs` (nuovo, minuscolo): path dello state file
  (`globalDataPath()/dashboards/dash.json`), lettura/scrittura atomica dello
  stato (`{pid, port, url, started_at, project_id, project_root}`),
  `processAlive(pid)`, costanti di porta `{ default: 11000, min: 11000, max:
  11999 }` (si riusa esattamente il vecchio range di bug-dash; il range
  12000 di suggest-dash viene ritirato, non serve più un secondo processo).
  Nessuna dipendenza pesante: viene importato sia da `yano-dash.mjs` sia da
  `yano-services.mjs`, che altrimenti non avrebbe motivo di dipendere dal
  server della dashboard.
- `scripts/yano-dash.mjs` (nuovo, sostituisce interamente
  `scripts/yano-feedback-dashboard.mjs`, che viene rimosso): un solo
  processo Node che
  1. apre il database (`openDatabase()` di `yano-feedback.mjs`);
  2. serve gli asset statici della UI da `scripts/dash-ui/`;
  3. monta `handleFeedbackApi` sotto le stesse route odierne
     (`/<project-id>/bugs[/<id>]`, `/<project-id>/suggestions[/<id>]`,
     `/attachments/<id>/<name>`, `/api/projects`);
  4. espone `/api/stream` (Server-Sent Events) per gli aggiornamenti live;
  5. sceglie una porta libera nel range 11000-11999 (11000 preferita); se il
     valore scelto non è 11000, chiama
     `sendGlobalNotification()` (già presente e pronto in
     `scripts/yano-notify.mjs`, usato oggi dal digest schedulato — legge
     sempre il canale di notifica **globale**, esattamente quello che serve
     qui) con un messaggio tipo: `"yano dash: la porta 11000 era occupata,
     dashboard avviata su http://127.0.0.1:<port>/"`. La notifica parte una
     sola volta per avvio, non a ogni passata del supervisore.
  6. gestisce `start`/`stop` con lo stesso pattern idempotente e
     singleton-per-macchina già collaudato nelle dashboard attuali
     (state file + PID, `stop` invia `SIGTERM` e aggiorna lo stato).

### Sempre attiva: riuso di `yano services`, zero nuovi cron

Non serve installare un nuovo cron/launchd: `yano watcher supervise` (cron a
un minuto, già installato da `postinstall` su ogni `npm install -g`) chiama
già `superviseExternalServices({ includeBuiltIns: true })` in
`scripts/yano-services.mjs`, che oggi scopre automaticamente `llmproxy` e
`mqtt` come container Docker/processi pm2, senza che l'operatore li
registri a mano.

Si aggiunge un terzo tipo di scoperta builtin, sempre inclusa (non condizionata
alla presenza di Docker): `builtinDashService()`, che ad ogni passata legge
lo state file corrente di `yano-dash-state.mjs` e produce una entry
`{ name: "yano-dash", healthcheck: { type: "http", target: <url dello state
file attuale, o un placeholder sicuramente irraggiungibile se non esiste
ancora> }, restart: { type: "command", target: "yano dash start --no-open" },
... }`. Questo riusa **senza modifiche** il motore esistente di
healthcheck/restart/backoff esponenziale di `superviseExternalServices` — la
stessa infrastruttura che già tiene in vita `llmproxy`/`mqtt` dopo un riavvio
del computer o un crash. Se la porta cambia da un avvio all'altro (fallback),
la prossima passata calcola l'URL di health-check dal nuovo state file, quindi
non c'è mai un falso "unhealthy" per un semplice cambio di porta.

Due leve di opt-out, entrambe verificate: la variabile globale già esistente
`YANO_DISABLE_BUILTIN_DEPENDENCY_SUPERVISION=1` (disattiva tutta la scoperta
builtin, non solo la dashboard) e una nuova `YANO_DASH_AUTOSTART=0` dedicata
solo a `yano-dash`, per chi vuole tenere attivi gli altri builtin ma non la
dashboard sempre-on.

`yano dash stop` resta un comando valido e ferma subito il processo, ma
essendo un builtin sempre-on il supervisore lo farà ripartire entro al
massimo un minuto, a meno che una delle due variabili sopra sia impostata —
il comando lo stampa esplicitamente nell'output per non sorprendere
l'operatore.

### UI (`scripts/dash-ui/`)

- `index.html`: import map per `preact`/`htm` da CDN, Tailwind via CDN,
  carica `app.js` come modulo.
- `app.js` + componenti separati in file propri (`Board.js`, `Card.js`,
  `Drawer.js`, `NewItemForm.js`, `ProjectSwitcher.js`, `Toasts.js`): niente
  bundler, ogni file è un modulo ES nativo caricato dal browser via
  `import`.
- Header: tab Bug/Suggestion/Tutti, selettore progetto, ricerca, orario
  ultimo aggiornamento.
- Colonne di stato dinamiche per tipo (bug: `received, processing,
  awaiting_user_confirmation, paused, retry, resolved, failed, cancelled`;
  suggestion: le stesse meno `failed`/`resolved`, più `processed`; "Tutti":
  unione delle colonne condivise, badge tipo sulla card).
- Click su una card apre un **drawer laterale** (non una modale a schermo
  intero): dettaglio completo, galleria screenshot con zoom/pan (riuso della
  logica esistente), **cronologia audit** (dato già presente via
  `listFeedbackAudit`, oggi mai mostrato in UI — viene aggiunto), pulsanti
  di transizione di stato rapidi oltre al select generico, nota
  obbligatoria per ogni modifica manuale (invariato).
- Drag&drop fra colonne: stesso comportamento di oggi (nota audit
  automatica "Spostato in ... via drag & drop"), ma con un toast invece di
  un reload dell'intera board.
- Aggiornamenti live via SSE (`/api/stream`); fallback automatico a polling
  ogni 5s se la connessione SSE cade.
- Form "Nuovo" per creare manualmente un bug/suggestion dalla GUI (uso da
  triage/test), invariato nella sostanza rispetto a oggi.

## Comandi CLI

- `yano dash start [--no-open] [--project-id ID] [--port N]` — avvia (se non
  già attivo) e stampa l'URL; apre il browser salvo `--no-open`. Uso tipico
  manuale: nessuno, dato che parte da sola; resta utile per forzare un
  progetto/porta specifici o per debug.
- `yano dash stop` — ferma il processo; stampa l'avviso sul riavvio
  automatico entro un minuto.
- Rimossi: `yano bug-dash`, `yano suggest-dash` (e l'import di
  `runFeedbackDashboard`/`scripts/yano-feedback-dashboard.mjs` da
  `bin/yano.mjs`).
- Invariati: `yano feedback serve|create|list|get|update|delete` (porta
  20002, headless).

## File impattati

Nuovi: `scripts/yano-dash.mjs`, `scripts/yano-dash-state.mjs`,
`scripts/dash-ui/index.html`, `scripts/dash-ui/app.js`,
`scripts/dash-ui/components/{Board,Card,Drawer,NewItemForm,ProjectSwitcher,Toasts}.js`,
`scripts/smoke-test-yano-dash.mjs`.

Rimossi: `scripts/yano-feedback-dashboard.mjs`,
`scripts/smoke-test-feedback-dashboard.mjs` (sostituito dal nuovo smoke
test).

Modificati: `scripts/yano-feedback.mjs` (esporta `handleFeedbackApi`),
`scripts/yano-services.mjs` (nuova scoperta builtin `yano-dash`),
`bin/yano.mjs` (comando `dash`, rimozione `bug-dash`/`suggest-dash`),
`docs/quick-guides/24-feedback-dashboards.md` (riscritta),
`docs/cheat-sheet/33-services.md` (menzione del nuovo builtin sempre-on),
`docs/architecture/architecture.md` (punto 10 dell'elenco architetturale),
`README.md` (dove cita i vecchi comandi).

## Testing (TDD — si scrive il test che fallisce prima del codice)

1. Unit test su `yano-feedback.mjs`: `handleFeedbackApi` esportata e
   funzionalmente identica al comportamento REST già coperto oggi
   (riutilizzo/estensione dei test esistenti).
2. Unit test su `yano-dash-state.mjs`: round-trip stato, scelta porta,
   `processAlive`.
3. Unit test su `yano-services.mjs`: `builtinDashService()` produce
   healthcheck che fallisce quando non c'è state file o il pid è morto, e
   che punta alla porta corrente quando il processo è vivo; rispetta
   `YANO_DASH_AUTOSTART=0`.
4. Nuovo `scripts/smoke-test-yano-dash.mjs`: avvia `yano dash start
   --no-open`, verifica `/healthz`, crea un bug e una suggestion via API,
   verifica che compaiano in `/<project>/bugs` e `/<project>/suggestions`,
   verifica un evento SSE al cambio di stato, verifica `yano dash stop`
   pulito. Sostituisce interamente `smoke-test-feedback-dashboard.mjs`.
5. Verifica manuale in browser (drag&drop, drawer, tab, notifica su porta
   di fallback simulata occupando la 11000) prima di dichiarare concluso.

## Rischi e mitigazioni

- **Falso "unhealthy" per cambio porta**: mitigato calcolando l'URL di
  health-check dal contenuto attuale dello state file a ogni passata
  (nessuna cache).
- **Notifiche ripetute**: la notifica sulla porta di fallback parte solo al
  momento dell'avvio effettivo del processo, non ad ogni passata del
  supervisore (che chiama solo l'health-check quando già sano).
- **Compatibilità con chi usava `bug-dash`/`suggest-dash` da script/cron
  personali**: taglio netto già concordato; la documentazione aggiornata
  segnala il cambio nel changelog/README.
