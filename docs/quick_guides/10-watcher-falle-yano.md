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

## Avvio di una scansione

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

Se viene rilevato un problema e c'è un planner live, il watcher invia un
comando MQTT direttamente alla sua tab. Se non c'è alcun planner live, invia
Telegram all'utente. La semplice assenza di agenti, senza un problema rilevato,
non genera notifiche.

## Dove leggere il risultato

I ticket sono nel repository Yano e sono pensati per essere presi da un LLM:

```bash
YANO_REPO_DIR=/Users/alessiobacin/Development/testCode/yano-orchestrator
find "$YANO_REPO_DIR/.scratch/optimize-orchestrator/issues" -maxdepth 1 -type f -print
sed -n '1,220p' "$YANO_REPO_DIR"/.scratch/optimize-orchestrator/issues/*.md
```

Il trace del progetto conserva il collegamento:

```bash
yano trace events \
  --instance yano-watcher \
  --type yano_watcher_finding \
  --limit 50 \
  --json
```

Il watcher non corregge, non chiude ticket e non modifica il codice: segnala e
prepara il contesto per il futuro `yano-debugger` o per un LLM incaricato.
