# Watcher: ticket per falle di Yano

Questa funzione è separata dagli errori del progetto osservato. Il watcher
crea un ticket solo quando il trace contiene un segnale attribuibile al flusso
interno di Yano; non trasforma un test applicativo fallito in un bug di Yano.
I file seguono la convenzione del tracker locale: `01-...`, `02-...`, ecc.

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
successivo senza notificare un errore. Questo è il percorso normale per una
conversazione che non ha ancora bisogno di persistenza operativa. Solo una
scansione avviata con contesto esplicito di validazione (`--validation-run`,
`--playbook-proposal`, `--playbook-id` o round/checksum) usa `blocked` e la
relativa escalation. Quando il Planner esegue `orchestrator_init`, le scansioni
successive entrano nel normale controllo dei ticket.

Per un Watcher persistente lanciato dall'Architect, la prima verifica è
bounded e poi il processo resta in polling read-only ogni dieci minuti:

~~~bash
yano watch --project-root /path/progetto \
  --lookback-ms 3600000 --interval-ms 600000 --away
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

`yano watch --interval-ms 600000 --away` lanciato a mano in un terminale o in
una tab Herdr qualsiasi **non sopravvive** a un riavvio: se il terminale si
chiude, il Mac va in sleep o la tab/pane muore, il polling si ferma senza che
nulla lo segnali — `yano watcher projects` mostra solo presenza Herdr/Pi già
esistente (incluso il flusso ephemeral dell'Architect legato a una proposta,
sotto), non "dovrebbe essere attivo ma non lo è più".

`yano watcher init|start|status|pause|resume` chiude questo buco con un
piccolo registro persistente (stessa logica già in uso per
`yano debugger init|start|pause|resume`, vedi `docs/yano-debugger.md`):

~~~bash
yano watcher init --project-root /path/progetto --interval-ms 600000 --lookback-ms 3600000
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
comando da ripetere periodicamente (dopo ogni risveglio del Mac, o da un
cron/launchd dell'utente) per essere certi che il watcher sia ancora vivo,
invece di scoprirlo solo quando manca un ticket segnalato. `pause`/`resume`
sospendono/riattivano senza perdere la registrazione; una pausa esplicita
non viene mai "recuperata" automaticamente da `status`.

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

Il watcher persistente mantiene anche la sottoscrizione MQTT agli eventi di
fine turno (`planner_task_completed`) e di fine run (`run_completed`). Ricevuto
uno di questi eventi, accoda una sola scansione finale immediata e avvisa il
planner se trova un problema; poi riprende la cadenza configurata. Il trace
contiene `yano_watcher_final_scan_requested` e lo scan finale con `once: true`.

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
