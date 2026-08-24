# Watcher: ticket per falle di Yano

Questa funzione è separata dagli errori del progetto osservato. Il watcher
crea un ticket solo quando il trace contiene un segnale attribuibile al flusso
interno di Yano; non trasforma un test applicativo fallito in un bug di Yano.
I file seguono la convenzione del tracker locale: `01-...`, `02-...`, ecc.

## Configurazione

Nel checkout di manutenzione di Yano (`.env`, mai nel progetto osservato):

```dotenv
TELEGRAM_BOT_TOKEN=<token-del-bot>
TELEGRAM_DESTINATION_CHAT_ID=5228139669
```

Se il comando `yano` arriva da un'installazione globale, indicare dove scrivere
i ticket:

```bash
export YANO_ORCHESTRATOR_REPO=/Users/alessiobacin/Development/testCode/yano-orchestrator
```

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

Il polling continuo usa l'intervallo configurato dal comando; `--once` è utile
per una verifica manuale o per un job esterno. Il lookback predefinito è 24 ore:

```bash
yano watch --project-root /path/progetto --lookback-ms 3600000 --once
```

## Dove leggere il risultato

I ticket sono nel repository Yano e sono pensati per essere presi da un LLM:

```bash
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

Il watcher non corregge, non chiude ticket e non modifica il codice: segnala e
prepara il contesto per il futuro `yano-debugger` o per un LLM incaricato.
