# Job ricorrenti e Yano Scheduler (script-first)

`yano-local-pc` è il runtime globale supervisionato: il cron Yano lo controlla
ogni minuto, ricrea la sua tab Herdr se manca e legge il registro persistente
nel data-root globale (`<data>/scheduler/jobs.json`). I job restano
disponibili dopo logout, riavvio di Herdr o riavvio del computer.

Dal modello storico ("il cron passa il testo del task a un planner") lo
scheduler è passato a un modello **script-first**: al trigger si esegue **lo
script registrato**; l'LLM entra solo se lo script lo decide (routing).

## Che cosa fa lo scheduler

- È un agente **minimale**: scrive script deterministici e li registra come
  schedule. Non coordina altri agenti e non fa handoff broadcast: risponde
  solo al chiamante (utente nella chat dello scheduler, o un planner che chiede
  "schedula X una volta / in modo ricorrente").
- **Audit locale alla creazione**: ogni script è scritto e validato prima di
  essere registrato, e l'agente lo testa con `yano schedule run --id <id>` prima di
  renderlo ricorrente.
- È **read-only di default**: non modifica il progetto né committa; scrive
  solo nel folder script persistente. Azioni distruttive o che modificano il
  progetto passano sempre dal planner di progetto con gate umani.

## Scheduler ESECUTORE: imposta ED esegue

Quando l'utente chiede uno schedule ("ogni giorno alle X fai Y", o una
tantum), lo scheduler non si limita a registrare: ESEGUE SUBITO il compito
in chat come primo giro con la cadenza richiesta, lo salva nello script
registrato, e al tick esegue lui stesso lo script (mode self). Per le email
il primo giro è sempre dry-run con gate di conferma: mostra il report,
chiede conferma con `yano mail-triage --confirm`, poi i giri successivi
eseguono davvero (solo Cestino, mai definitiva). Ha MCP/CLI pieni (node,
npx, yano, chrome-devtools) e sceglie autonomamente gli strumenti per
compito; playwright solo se chrome-devtools risulta insufficiente.

## Delega bidirezionale scheduler↔local-pc (max 1 hop, mai loop)

Per compiti generici sul PC (promemoria, calendario, note, contatti, mappe,
posta, messaggi, memo vocali) lo scheduler delega allo yano-local-pc via
`yano invoke --role yano-local-pc --prompt "..."` dallo script, con
`YANO_DELEGATION_HOPS=1` e `YANO_DELEGATION_ORIGIN=scheduler` nell'env: il
local-pc esegue e NON rimbalza indietro (il bridge rifiuta il secondo hop).
Specularmente, i local-pc generici non creano MAI schedule: se gli chiedono
una schedulazione, delegano in un solo hop con
`yano invoke --role scheduler --prompt "..."` e si fermano; se arrivano già
dallo scheduler (hop esaurito), eseguono e basta.

```bash
yano invoke --role scheduler --prompt "ogni giorno alle 8 riepilogami la posta"  # return-hop esecutore
```

## Regole persistenti interrogabili (`yano schedule-rules`)

Gli schedule stanno in `jobs.json`, le regole utente in
`<data>/scheduler/scheduler-rules.json` (sopravvivono al reset chat). CRUD
+ query semantica in italiano (stemming + sinonimi cestino/cancellazione/
trash…): "quali schedule hai?", "quali regole cancellazione sono
attive?". Modifica/cancellazione semantica di singole regole o dell'intero
schedule; `seed` idempotente installa le regole email iniziali.

```bash
yano schedule-rules seed                                    # regole email iniziali (idempotente)
yano schedule-rules query "quali regole cancellazione sono attive?"
yano schedule-rules add --pattern "promo@" --kind unsubscribe --action unsubscribe_then_trash --note "..."
yano schedule-rules list [--schedule-id <id>] [--all] [--json]
yano schedule-rules update --id <id> [--pattern ...] [--kind ...] [--action ...] [--note ...] [--enable|--disable]
yano schedule-rules remove --id <id>
```

## Regole email: blocklist, unsubscribe, solo Cestino, gate primo giro

- **Regole prima dell'LLM**: la blocklist (a) `support@mail.xtb.com` →
  sempre Cestino scatta senza coinvolgere l'LLM.
- **Unsubscribe (b)**: pubblicità con link di disiscrizione → tentativo GET
diretto + nota browser-fallback (chrome-devtools se serve); altrimenti
Cestino. Opt-out: `YANO_MAIL_UNSUBSCRIBE=0`.
- **Solo Cestino**: unica chiamata distruttiva è `delete_message` (sposta
nel Cestino); nessuna empty-trash; azioni chiuse
(`trash|unsubscribe_then_trash|review|keep`); cap 200/run; dubbio → REVIEW.
- **Gate primo giro**: senza marker `mail-triage-confirmed` il giro reale
diventa dry-run + errore esplicativo; `--confirm` persiste il marker
(opt-out `YANO_MAIL_CONFIRM_GATE=0`, skip in `YANO_TEST_MODE`).
- **Report per-run**: `<data>/scheduler/mail-triage-reports/*.json` (keep 50).

```bash
yano mail-triage --dry-run    # classifica soltanto, nessuna delete
yano mail-triage --confirm    # registra la conferma del primo giro
yano mail-triage --no-notify  # salta la notifica globale
```

## Creare un job (script-first)

L'agente scheduler scrive lo script nel folder persistente utente
(`<data>/scheduler/scripts/` — mai dentro il pacchetto, un upgrade non lo
cancella) e registra lo schedule:

```bash
yano schedule add --name <nome> --project-root "$PWD" \
  --script /percorso/assoluto/dello/script.mjs \
  --mode self \
  --cron '0 14,21 * * *' \
  --expected-consequence "riepilogo inviato"
```

Flag chiave:

- `--mode self|planner:<progetto>|yano-local-pc` — dichiara il routing:
  - `self` — lo script gira da solo, nessun LLM;
  - `planner:<progetto>` — lo script (o il job) sveglia il planner del
    progetto target con il task, via `yano invoke --role planner:<progetto>`;
  - `yano-local-pc` — lo script delega a yano-local-pc (promemoria,
    calendario, note, contatti, mappe, messaggi, memo vocali — mai la posta
    schedulata, che gira in mode self);
- `--once` — one-shot: il job si auto-disabilita dopo la prima esecuzione;
- `--timeout-ms N` — timeout massimo di esecuzione dello script
  (default 120000 ms);
- `--expected-consequence <testo>` — conseguenza attesa documentata nel job.

La sintassi storica in linguaggio naturale resta disponibile per i job legacy:
`yano cron --add "ogni giorno alle 14 e alle 21 esegui ..." --project-root "$PWD"`
(dispatch planner col testo, come in passato — non a script).

## Job di default: digest giornaliero

Oltre ai job creati manualmente, Yano installa da sé — idempotentemente, ad
ogni passata del supervisore — un job di sistema: `yano-daily-digest`,
`mode: self`, `0 6 * * *` nel fuso `Europe/Rome` esplicito (i job creati con
`--cron` restano invece nel fuso del server, comportamento invariato). Invia
sul canale di notifica globale un riepilogo cross-progetto: run non
completati, `decision_hold` aperti con il testo della domanda, recovery
recenti, streak di Herdr non raggiungibile e progetti oltre la soglia di log.
Vedi `docs/quick-guides/10-watcher-falle-yano.md#digest-giornaliero-0600-europerome`
per il dettaglio; `yano schedule disable --id yano-daily-digest` lo disattiva
in modo durevole (il bootstrap non lo riabilita mai da solo).

## Testare e gestire

```bash
yano schedule run --id <job-id> --dry-run --json # valida senza eseguire
yano schedule run --id <job-id>        # esegue subito SOLO su richiesta esplicita
yano schedule list                # inventario compatto con ID, nome, cron, stato, modalità
yano schedule list --json --pretty # inventario JSON indentato per lettura manuale
yano schedule disable --id <job-id>
yano schedule enable --id <job-id>
yano schedule remove --id <job-id>

# Cronologia e retry delle esecuzioni
yano schedule instances --id <job-id> --limit 20 --json
yano schedule retry --id <instance-id> --json
```

Regola d'oro: **prima di rendere ricorrente uno script, validalo con
`yano schedule run --id <id> --dry-run --json`**. Se lo script manca o fallisce,
il dispatch registra `failed` e disabilita il job (`enabled:false`) con un
fallback loggato — mai testo libero verso un planner dal cron.

## Bridge invocabile dagli script: `yano invoke`

Dentro uno script si sveglia il planner di progetto o yano-local-pc con un
comando deterministico (nessuna shell, nessun broker da gestire a mano):

```bash
yano invoke --role planner:<progetto> --prompt "riepiloga lo stato del progetto" --project-root "$PWD"
yano invoke --role yano-local-pc --prompt "promemoria tra 10 minuti: pausa caffè"
```

`--role planner[:<scope>]` compone il lancio `yano start --herdr --role
planner --project <scope> --print-only` dal root target; `yano-local-pc`
delega all'esistente `yano local-pc ask` (broker-aware, timeout, mai hang);
`--role scheduler` compone il lancio dello scheduler-service ESECUTORE
(return-hop della delega bidirezionale scheduler↔local-pc, max 1 hop via
`YANO_DELEGATION_HOPS`/`YANO_DELEGATION_ORIGIN` — il secondo rimbalzo è
rifiutato, il chiamante esegue localmente).

## Supervisore e cron di sistema

Il supervisore globale gira ogni minuto dal cron di sistema: fa tick dei job in
scadenza, garantisce il runtime `yano-local-pc` (ricrea `planner-01` se manca —
il solo processo LLM persistente del control plane, evitando l'errore Herdr
`agent_kind_mismatch`) e reinstalla il digest di default se manca. Non esiste
una tab Herdr `scheduler-service`: lo scheduler è il processo cron stesso e il
suo stato è il registro `jobs.json`. Lo stato della riga cron
marcata si controlla con `yano schedule cron status`; `yano schedule cron
install|remove` gestiscono la riga di sistema (su Windows `schtasks`), mentre
`yano uninstall` pulisce automaticamente i cron posseduti da Yano.

## Triage posta in mode self (scheduler autonomo)

Lo scheduler-service esegue MATERIALMENTE le schedulazioni: il motore
`scripts/yano-mail-triage.mjs` implementa l'intero flusso "leggi INBOX →
classifica → sposta nel Cestino" in `mode: self`, senza passare da
yano-local-pc (che resta per i soli one-off interattivi non schedulati).
Accesso a Mail.app via server MCP apple-mail su stdio (puro wrapper
osascript, zero credenziali); classificazione via llmProxy su loopback
(stessa convenzione degli agenti Pi). Dubbio → NON cancellare; solo Cestino
(mai definitiva); cap 200/run; idempotenza via `mail-triage-seen.json`.
Procedura di migrazione post-merge: [28-migrazione-posta-self](./28-migrazione-posta-self.md).

## Debito noto (review T2, fuori scope — non implementato)

- **P2 — hop MQTT**: il ramo scheduler→local-pc passa per MQTT e
  `askLocalPc` manda `hops: 0` hardcoded — il contatore env non attraversa
  il boundary MQTT, quindi il guard anti-loop non scatta se un
  planner/computer-local rinvoca lo scheduler senza env (lì la prevenzione
  è solo disciplina da prompt). Raccomandazione: propagare l'hop env nella
  request MQTT invece di `hops: 0`.
- **P3 — report run falliti**: gli early-return di errore del triage
  (non-macOS, `list_mailboxes` fallita) bypassano `saveTriageRunReport` —
  i run falliti non lasciano report persistente (la notifica scatta
  comunque).
- **P3 — side-effect smoke su data-root**: la §1 dello smoke
  (`runYanoInvoke --role scheduler`) scrive
  `mcp/agents/scheduled-invoke-scheduler.json` nel data-root reale come
  side-effect di `yano start --print-only` (innocuo, deterministico, ma non
  zero-side-effect) — documentarlo o isolarlo.

## Sicurezza

Niente shell arbitrari, token, pipe, redirezioni o comandi liberi nei job:
l'unico eseguibile è lo script registrato e validato (eseguito dal runtime
Node come file, mai da una shell). Token e credenziali si leggono da `.env`
dentro lo script, mai incorporati. Le modalità che modificano il progetto
passano dal planner con gate umani.
## Standby e perdita di connessione

Il cron globale esegue la supervisione ogni minuto. Controlla DNS Google
(`8.8.8.8`/`8.8.4.4`), broker MQTT, Herdr e l'esecuzione della passata cron.
Se la macchina perde la connettività, salva checkpoint e mette in pausa i run
attivi dei progetti; quando tutti i segnali tornano disponibili riprende solo i
progetti messi in pausa automaticamente. Il registro dettagliato è
`<YANO_DATA_DIR>/logs/scheduler-connectivity-YYYY-MM-DD.jsonl` (un file per
giorno solare, cosicché la retention esistente possa raggiungerlo una volta
concluso — un file in append continuo ha sempre `mtime: ora`).
