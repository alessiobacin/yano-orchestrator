# Watcher: ticket per falle di Yano

Questa funzione è separata dagli errori del progetto osservato. Il watcher
crea un ticket solo quando il trace contiene un segnale attribuibile al flusso
interno di Yano; non trasforma un test applicativo fallito in un bug di Yano.
I file seguono la convenzione del tracker locale: `01-...`, `02-...`, ecc.

## Controllo delle identità

Ad ogni supervisione il watcher confronta le identità live con la root del
progetto e segnala agenti duplicati o planner non numerati. La scansione non
avvia un secondo planner quando trova una collisione: restituisce
`recovery: "identity_conflict"` e registra `watcher_identity_conflict` nel
trace. Anche `yano start` applica lo stesso rifiuto prima di creare il processo

```bash
yano watcher supervise --json
```

## Configurazione

Per un'installazione globale, salva la configurazione nel profilo utente:

```bash
yano config set YANO_ORCHESTRATOR_REPO /Users/alessiobacin/Development/testCode/yano-orchestrator
yano config set TELEGRAM_DESTINATION_CHAT_ID 5228139669
printf '%s' "$TELEGRAM_BOT_TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
```

In sviluppo, le stesse variabili possono stare nel `.env` del checkout Yano:

```dotenv
YANO_ORCHESTRATOR_REPO=/Users/alessiobacin/Development/testCode/yano-orchestrator
```

Il watcher non legge mai queste impostazioni dal `.env` del progetto osservato
e non accetta un override `--yano-repo`. Se una rilevazione richiede Telegram
o il repository di manutenzione e la variabile manca, il comando fallisce
indicando la variabile e il comando `yano config set` da eseguire.

## Avvio di una scansione zero-token

`yano watch` è il comando bounded/read-only che esegue la scansione senza
aprire una sessione LLM. È utile per cron, smoke test e diagnosi manuali:

Da un progetto inizializzato con Yano:

```bash
yano watch --once
```

Per osservare un progetto da un'altra directory:

```bash
yano watch \
  --project-root /Users/alessiobacin/Development/testCode/focusboard-trace-test \
  --once
```

`--once` è utile per una verifica manuale o per un job esterno. Il lookback
predefinito è 24 ore:

```bash
yano watch --project-root /path/progetto --lookback-ms 3600000 --once
```

### Controllo e compaction del contesto

Ogni agente registra nel proprio JSONL globale un evento `context_usage` a
`session_start`, `turn_end` e `agent_end`. I campi `context_tokens` (quando Pi
ha già una misura del provider), `effective_context_tokens`,
`context_window_tokens`, `context_ratio`, `context_chars` e `context_entries`
permettono al watcher di distinguere un contesto cresciuto da un semplice
heartbeat. La compaction è generale e non dipende dal playbook:

```bash
yano watch --project-root /path/progetto --interval-ms 60000 --away \
  --context-compact-ratio 0.82
```

Quando la soglia è superata, il watcher registra
`yano_watcher_context_check`, invia `context_compact_request` all'agente e
l'estensione chiama la compaction nativa di Pi. Il risultato è visibile come
`context_compaction_completed` con `restart_mode: pi_native_compaction`, seguito
da una nuova misura più bassa. Se l'agente non è live, il watcher instrada il
finding al planner per il recovery della sessione. La soglia predefinita è
`0.82` e può essere impostata anche con
`YANO_WATCH_CONTEXT_COMPACT_RATIO`; `--lookback-ms` continua a definire la
finestra osservata, mentre `--interval-ms` definisce la cadenza.

Questo analizza gli ultimi 3.600.000 ms e termina. Per controllare ogni ora:

```bash
yano watch --project-root /path/progetto --interval-ms 3600000
```

`--lookback-ms` indica la finestra temporale analizzata; `--interval-ms`
indica l'intervallo tra le scansioni. Con `--once` viene eseguita una sola
scansione e il processo termina.

`yano watch --help` e `yano watcher <init|start|status|pause|resume> --help`
sono sempre read-only: stampano l'uso senza aprire il broker, creare il registro
o avviare un processo. Se il progetto è appena inizializzato e manca
`orchestrator.db`, un watcher continuo ordinario resta vivo, registra la
scansione come `waiting` con motivo `not_initialized` e ritenta al giro
successivo senza notificare un errore. Questo resta il percorso normale per
una conversazione senza evidenza di dibattito. Se invece il trace contiene un
debate già avviato, la mancanza del DB è una violazione: il watcher registra
`yano_watcher_debate_check` con `missing-orchestrator-init`, avverte il planner
e non crea il database al suo posto. Il planner deve quindi chiamare
`orchestrator_init` come primo preflight, prima di framing o lancio agenti.
Solo una scansione avviata con contesto esplicito di validazione
(`--validation-run`, `--playbook-proposal`, `--playbook-id` o round/checksum)
usa inoltre `blocked` e la relativa escalation.

Per un Watcher persistente lanciato dall'Architect, la prima verifica è
bounded e poi il processo resta in polling read-only ogni dieci minuti:

~~~bash
yano watch --project-root /path/progetto \
  --lookback-ms 3600000 --interval-ms 300000 --away
~~~

Il polling zero-token controlla stall, heartbeat e segnali Yano ad alta
confidenza. Non equivale a una rilettura LLM completa di ogni conversazione:
per una revisione semantica approfondita il Watcher deve ricevere un round o
un controllo esplicito e deve riportare evidenze, non dichiarare il flusso sano
solo perché il processo di polling è vivo.

Ogni passata lascia nel trace un evento `yano_watcher_scan`, con data e ora di
inizio (`started_at`), fine (`completed_at`), durata, esito, numero di finding e
stall. Per controllare la ricorrenza:

```bash
yano trace events \
  --project sales-companion \
  --instance yano-watcher \
  --type yano_watcher_scan \
  --limit 20
```

L'evento `yano_watcher_round_ok` non conta tutti i polling: indica soltanto una
validazione bounded positiva associata a `--validation-run`.

## Watcher persistente su un progetto esistente (registro)

`yano watch --interval-ms 300000 --away` lanciato a mano in un terminale o in
una tab Herdr qualsiasi **non sopravvive** a un riavvio: se il terminale si
chiude, il Mac va in sleep o la tab/pane muore, il polling si ferma senza che
nulla lo segnali — `yano watcher projects` mostra solo presenza Herdr/Pi già
esistente (incluso il flusso ephemeral dell'Architect legato a una proposta,
sotto), non "dovrebbe essere attivo ma non lo è più".

`yano watcher init|start|status|pause|resume|leave` chiude questo buco con un
piccolo registro persistente (stessa logica già in uso per
`yano debugger init|start|pause|resume`, vedi `docs/yano-debugger.md`):

~~~bash
yano watcher init --project-root /path/progetto --interval-ms 300000 --lookback-ms 3600000
yano watcher start --project-root /path/progetto
~~~

`start` (e `resume`) aprono/riusano una tab nel workspace Herdr condiviso
`yano-watcher` (tab `watcher-<nome-progetto>` — la stessa convenzione usata
dal flusso Architect qui sotto, così un progetto ha sempre e solo una tab)
e ci lanciano lo stesso comando bounded/zero-token già documentato sopra:
nessun agente LLM viene avviato solo per il polling.

Il punto centrale è `status`:

~~~bash
yano watcher status --json              # tutti i progetti registrati
yano watcher status --project-root /path/progetto --json
~~~

Confronta lo stato registrato con quello reale in Herdr e, salvo
`--no-heal`, **rilancia da solo** un pane che risulta morto, annotando un
evento `watcher_worker_recovered` nel trace del progetto osservato. È il
controllo che il cron utente esegue ogni minuto. Installalo una volta:

~~~bash
yano watcher cron install
yano watcher cron status
# per modificare il crontab si usa `crontab -e`, non `cron -e`
# su Windows lo stesso comando usa Task Scheduler (schtasks) al posto di crontab
~~~

Il cron esegue `yano watcher supervise`, che controlla tutti i watcher
registrati come attivi e rilancia quelli il cui pane Herdr è morto. Verifica
anche i run SQLite: se un planner non ha prodotto attività durevole per 15
minuti e non attende una decisione dell'utente, lo ripristina esclusivamente
nel workspace Herdr con l'etichetta del progetto (mai in un workspace condiviso
di uno specialista). I progetti completati, oppure privi di run oltre il breve
periodo di grazia iniziale, restano comunque visibili: solo `pause` nasconde
temporaneamente la tab e `leave` rimuove definitivamente il controllo.
Lo snapshot Herdr di ogni passata ritenta con backoff breve invece di
arrendersi al primo tentativo fallito (`scripts/yano-herdr-client.mjs`); se
resta irraggiungibile, il supervisore controlla prima se è registrato un
servizio esterno chiamato esattamente `herdr` (vedi `yano services` sopra) e,
in tal caso, prova il suo comando di restart dichiarato prima di rinunciare
per quel giro:

```bash
yano services add --name herdr \
  --healthcheck-command "herdr api snapshot >/dev/null 2>&1" \
  --restart-command "<comando reale di avvio di Herdr sulla tua macchina>"
```

Il job viene installato automaticamente solo dal lifecycle di un'installazione
globale di Yano, non da `yano start`; un lock impedisce recovery concorrenti.
`pause`/`resume` sospendono/riattivano senza
perdere la registrazione; una pausa esplicita non viene mai recuperata.
Per rimuovere solo questo job: `yano watcher cron remove`.

Per smettere definitivamente di controllare un solo progetto (e impedire che
venga riaperto dopo un riavvio), usare `yano leave --yes` dalla sua root, oppure
`yano leave --project-root /path/progetto --yes`. È l'alias di
`yano watcher leave`: rimuove solo la registrazione watcher, non cancella il
progetto né chiude un run con `yano end`.

Ad ogni passata il supervisore riconcilia anche i run SQLite dei progetti
registrati. Se un run è ancora `active`, oppure è `completed` ma non ha ancora
`finalization_status=finalized`, la perdita di Herdr provoca la ricreazione del
workspace e di `planner-01`; il planner riceve un prompt di recovery con trace,
ticket e worktree da verificare. Quando tutti i run risultano finalizzati, la
tab `watcher-<project>` resta aperta senza generare recovery. Una pausa esplicita
resta rispettata. Nella stessa passata il supervisore ripristina anche i worker
globali con intento durevole: proposte Architect installate, anche nella fase
`ready_ephemeral`, debugger `running`, analisi Suggester pendenti e lo
scheduler dell'auto-improver. Per un auto-improver `idle` ricrea anche la sua
tab persistente senza avviare un audit prima della scadenza; il Suggester resta
senza tab finché non esiste una proposta pendente.

## Watcher LLM per un playbook ephemeral

Quando l'Architect prepara un nuovo playbook, il watcher non deve essere
avviato come una semplice shell nella tab Herdr. Il comando corretto è:

```bash
yano architect provision --proposal-id <PROP-ID> --install
```

Questo riusa/crea il workspace globale `yano-watcher`, crea una tab chiamata
`watcher-<project-name>` e avvia un vero agente Pi con:

```text
herdr agent start <nome-normalizzato> --kind pi --pane <pane-id> -- <argomenti-pi> ... --role watcher
```

`--kind pi` seleziona già l'eseguibile: non aggiungere un secondo `pi` dopo
`--`, altrimenti Herdr proverebbe a lanciare `pi pi ...`.

La tab da sola non è una prova di attività: verificare sempre l'agente reale:

```bash
herdr agent list
yano fleet --project-root /path/progetto --json
```

Il suo prompt invoca poi `yano watch --once` per il controllo bounded. Se
Architect non riesce ad avviare l'agente, `provision` ora ritorna `blocked` e
registra `external_agent_launch_failed`, invece di lasciare una tab vuota e
segnalare erroneamente il playbook come pronto.

Se viene rilevato un problema e c'è un planner live, il watcher invia un
comando MQTT direttamente alla sua tab. Se non c'è alcun planner live, invia
Telegram all'utente. La semplice assenza di agenti, senza un problema rilevato,
non genera notifiche.

Nel playbook `conversation` il watcher controlla anche che l'eventuale
`conversation-researcher` resti read-only: registra
`yano_watcher_conversation_check`, accetta le sole letture e segnala come
`conversation_policy_violation` tool di consegna, scritture shell o lanci
falliti. La segnalazione viene deduplicata e inviata al planner live per il
recupero; con nessun planner viene usato Telegram. Un `curl` o un `grep` di
documentazione non è una violazione.

Nel playbook `debate` il controllo è separato: quando il trace contiene un
intent esplicito di dibattito, il watcher registra
`yano_watcher_debate_check` e segnala `debate_policy_violation` se il planner
usa `conversation-researcher`, termina con meno di due `debater`, non mostra
una proposta `yano model-advisor recommend` oppure lancia il roster senza una
proposta e una conferma esplicita dell'utente. Un researcher read-only
non rende sano un dibattito instradato male: il finding debate viene inviato al
planner per il recupero, o a Telegram se non è più online.

Se il trace mostra un errore 4xx/5xx del modello pinnato, il watcher registra
anche `model-runtime-fallback`: il planner deve dichiarare il fallback e
verificarne l'esito, invece di considerare automaticamente valido il modello
proposto.

Il `pinned_id` mostrato nel piano, per esempio
`z-ai/glm-5.3-flash@openrouter-glm`, appartiene al catalogo llmProxy. Il lancio
Pi corretto usa `--provider llmproxy --model
'z-ai/glm-5.3-flash@openrouter-glm'`; `openrouter-glm` non va mai usato come
provider Pi. Per evitare errori nel comando composto, il planner può usare
`yano start --llmproxy-pin 'z-ai/glm-5.3-flash@openrouter-glm' --print-only`.

L'avviso di Pi `Using custom model id` è atteso quando Pi conosce il solo
modello generico `llmproxy`: non equivale a un errore. Il watcher considera
fallimento solo un 4xx/5xx del modello, ad esempio `is returning: 400`, e in
quel caso registra `model-runtime-fallback`.

Un watcher registrato resta attivo anche se il progetto non ha ancora
`orchestrator.db`: la scansione segnala `waiting_for_initialization` e non lo
disattiva per timeout. Resta aperto anche quando non esistono run attivi,
finché non viene usato `pause` o `leave`.

Il watcher persistente mantiene anche la sottoscrizione MQTT agli eventi di
fine turno (`planner_task_completed`) e di fine run (`run_completed`). Ricevuto
uno di questi eventi, accoda una sola scansione finale immediata e avvisa il
planner se trova un problema; poi riprende la cadenza configurata. Il trace
contiene `yano_watcher_final_scan_requested` e lo scan finale con `once: true`.

## Rumore: fixture di test e ticket senza recidiva

Un progetto il cui nome segue la convenzione delle fixture degli smoke test di
Yano (`*-smoke`, `manual-e2e-*`/`manual e2e *`, case-insensitive) non apre mai
un ticket, un alert Telegram o un bug nel registro debugger: il finding resta
comunque visibile nel trace di quel progetto come
`yano_watcher_finding_suppressed`. È un'euristica sui nomi, non sul percorso:
personalizzabile con `YANO_WATCHER_TEST_FIXTURE_PATTERN` (una regex) o
disattivabile del tutto con `YANO_WATCHER_SKIP_TEST_FIXTURES=0`.

Un ticket aperto dal watcher che non si ripresenta più (stesso fingerprint) per
`YANO_WATCHER_STALE_TICKET_DAYS` giorni (default 14) viene chiuso in automatico
come `auto-closed-stale` da una sweep che gira, con un throttle di
`YANO_WATCHER_STALE_SWEEP_INTERVAL_MS` (default sei ore), dentro la normale
cadenza di polling — non tocca mai un ticket aperto da una persona o già
risolto. Se lo stesso guasto si ripresenta dopo la chiusura automatica, il
ticket viene riaperto al passaggio successivo invece di perdere il segnale.

## Dove leggere il risultato

I ticket sono nel repository Yano e sono pensati per essere presi da un LLM:

```bash
YANO_ORCHESTRATOR_REPO=/Users/alessiobacin/Development/testCode/yano-orchestrator
find "$YANO_ORCHESTRATOR_REPO/.scratch/optimize-orchestrator/issues" -maxdepth 1 -type f -print
sed -n '1,220p' "$YANO_ORCHESTRATOR_REPO"/.scratch/optimize-orchestrator/issues/*.md
```

Il trace del progetto conserva il collegamento:

```bash
yano trace events \
  --instance yano-watcher \
  --type yano_watcher_finding \
  --limit 50 \
  --json
```

Ogni ticket markdown appena creato (non un duplicato) viene anche instradato,
in modo additivo, nel registro `yano-debugger` in modalità `yano-maintenance`
(scoped al repository yano-orchestrator, mai al progetto osservato):

```bash
yano debugger status --project-root "$YANO_ORCHESTRATOR_REPO" --mode yano-maintenance --json
```

Questo dà al difetto "Yano su Yano" lo stesso ciclo di vita, la stessa
deduplicazione e lo stesso risveglio automatico di un debugger/planner live
(vedi "Chi guarda il bug appena aperto" in `docs/yano-debugger.md`) che ha
qualunque altro bug — senza sostituire il file markdown, che resta il
meccanismo primario. Un fallimento nell'instradamento (registro non
raggiungibile, sqlite non disponibile) non blocca mai la creazione del
ticket markdown.

Il watcher non corregge, non chiude ticket e non modifica il codice: segnala e
prepara il contesto per il futuro `yano-debugger` o per un LLM incaricato.
