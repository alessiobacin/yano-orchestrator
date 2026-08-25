# Yano Auto-Improver

`yano auto-improve` è il terzo agente esterno di Yano. Esegue audit periodici
su un progetto e invia al planner proposte motivate su qualità, affidabilità,
performance, documentazione, UX e funzionalità mancanti.

## Confini di sicurezza

L'auto-improver è un osservatore read-only. Non modifica il progetto, non crea
branch/worktree, non installa dipendenze, non esegue migrazioni, commit, push o
deploy e non apre ticket operativi in autonomia. Scrive solo nella directory
globale `temp/auto-improver/` e nel database SQLite globale. Il planner resta
l'unico responsabile di accettare una proposta e avviare il flusso di sviluppo.

## Avvio

```sh
yano auto-improve init --project-root /path/progetto --interval 5d --notify auto
yano auto-improve start --project-root /path/progetto
yano auto-improve start --project-root /path/progetto --once --dry-run --json
```

`start` crea o riusa il workspace Herdr `yano-auto-improver`, apre una tab con
il nome del progetto, lancia l'agente e avvia lo scheduler detached. Per
verificare il comando senza Herdr:

```sh
yano auto-improve start --project-root /path/progetto --dry-run --no-daemon --json
```

Per un audit singolo:

```sh
yano auto-improve run --project-root /path/progetto --once
```

Gli intervalli accettano millisecondi o `m`, `h`, `d`, `w`; ad esempio `30m`,
`12h`, `5d`, `2w`. L'intervallo minimo è un minuto.
Con `--once` viene preparato un solo audit e lo scheduler detached non viene
avviato; aggiungere `--dry-run` per verificare il comando senza Herdr.

## Stato e controllo

```sh
yano auto-improve status --project-root /path/progetto --json
yano auto-improve reports --project-root /path/progetto
yano auto-improve pause --project-root /path/progetto
yano auto-improve resume --project-root /path/progetto
yano auto-improve stop --project-root /path/progetto
```

`pause` sospende la pianificazione; `stop` disabilita il progetto senza
cancellare report, audit o tab. `resume` programma un audit immediato. Nessuno
di questi comandi cancella dati o modifica il progetto osservato.

## Handoff al planner

L'agente riceve un evidence pack e completa il report globale dell'audit. Poi
esegue:

```sh
yano auto-improve complete \
  --audit-id <id> \
  --report-file /path/alla/temp/auto-improver/...md \
  --summary-file /path/alla/temp/auto-improver/...json
```

Il comando registra l'esito, scrive l'evento nel trace del progetto, cerca i
planner vivi via MQTT e invia il report. `--notify none` disattiva le
notifiche utente; `auto` prova Telegram, WhatsApp ed email usando la
configurazione globale disponibile.

Il planner non considera automaticamente una raccomandazione come approvata:
valuta le evidenze, chiede conferma quando l'impatto è concettuale e, se
accetta, usa `to-spec → to-tickets` e il normale ciclo coder/reviewer.
