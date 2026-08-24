# Configurazione globale di Yano

La configurazione globale serve quando Yano è installato con npm e non si sta
lavorando dentro il checkout sorgente. Non viene salvata nella cartella del
pacchetto e non viene sovrascritta da `yano update`.

## Vedere il percorso e le variabili

```bash
yano config path
yano config list --all
```

`list` oscura automaticamente token e chiavi API.

## Salvare variabili

Variabili normali:

```bash
yano config set YANO_ORCHESTRATOR_REPO /Users/me/Development/yano-orchestrator
yano config set TELEGRAM_DESTINATION_CHAT_ID 5228139669
yano config set YANO_EMBEDDING_MODEL nomic-embed-text
```

Segreti: usare stdin per evitare che il valore finisca nella cronologia della
shell:

```bash
printf '%s' "$TELEGRAM_BOT_TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
printf '%s' "$SENDGRID_API_KEY" | yano config set SENDGRID_API_KEY --stdin
```

Per rimuovere una variabile:

```bash
yano config unset TELEGRAM_BOT_TOKEN
```

## Quando una configurazione è obbligatoria

I canali di notifica restano indipendenti: WhatsApp, Telegram e SendGrid
possono essere configurati separatamente. Se però un ramo operativo richiede
una configurazione mancante, Yano termina con l'elenco delle variabili mancanti
e i comandi `yano config set` necessari.

Per esempio, il watcher che rileva un difetto Yano senza un planner live deve
avere Telegram configurato; per creare il ticket deve conoscere
`YANO_ORCHESTRATOR_REPO`:

```bash
yano watch --project-root /path/progetto --once
```

Non vengono stampati i valori dei segreti. In un checkout sorgente si può
usare anche `.env`; il `.env` del progetto osservato non viene usato per
indirizzare i ticket di manutenzione Yano.
