# Configurazione globale di Yano

La configurazione globale serve quando Yano è installato con npm e non si sta
lavorando dentro il checkout sorgente. Non viene salvata nella cartella del
pacchetto e non viene sovrascritta da `yano update`.

## `YANO_DATA_DIR`

È la radice opzionale dei dati utente di Yano: trace, indice semantico,
snapshot, catalogo playbook e database degli agenti esterni. Normalmente non
va valorizzata: Yano sceglie automaticamente `~/Library/Application
Support/yano/data` su macOS, `~/.local/share/yano` su Linux e
`%LOCALAPPDATA%/yano/data` su Windows. Per vedere il percorso effettivo usa:

```bash
yano trace status
```

Imposta un percorso personalizzato solo se vuoi spostare i dati o migrare una
vecchia installazione; il valore va nel file globale mostrato da `yano config
path`, non nel `.env` del progetto applicativo:

```bash
yano config set YANO_DATA_DIR /percorso/dati/yano
yano trace status
```

`YANO_TEMP_DIR` resta disponibile soltanto come alias legacy. Il checkout di
sviluppo di Yano può avere un `.env` per variabili di sviluppo, ma il pacchetto
globale non dipende da quel file.

Se aggiorni da una versione che scriveva nel `temp/` del pacchetto, controlla e
migra lo store senza cancellare l'origine:

```bash
yano data path
yano data migrate --dry-run
yano data migrate --yes
```

La migrazione copia trace, indice, snapshot, catalogo e database nel nuovo
data-root per-user. Il vecchio `temp/` resta conservato finché non lo rimuovi
manualmente dopo avere verificato il risultato.

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

Porta e token dell'API REST del feedback (`yano feedback serve`, vedi
[guida rapida del feedback](./12-yano-feedback.md)):

```bash
yano config set YANO_feedback_API_PORT 4177
printf '%s' "$YANO_feedback_API_TOKEN" | yano config set YANO_feedback_API_TOKEN --stdin
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

## Estensioni Pi richieste dalla versione Yano

`yano doctor` verifica anche il catalogo delle estensioni Pi richieste dalla
versione installata, incluse `pi-image-paste` e
`@guwidoe/pi-clipboard-image` per incollare screenshot nella chat. Se una
estensione manca, `yano doctor` mostra il comando `pi install` corretto; il
preflight di `yano init` la installa automaticamente e ripete il controllo.
