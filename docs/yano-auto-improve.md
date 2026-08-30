# Yano Auto-Improver

`yano auto-improve` è il terzo agente esterno di Yano. Esegue audit periodici
su un progetto e invia al planner proposte motivate su qualità, affidabilità,
performance, documentazione, UX e funzionalità mancanti.

## Confini di sicurezza

L'auto-improver è un osservatore read-only. Non modifica il progetto, non crea
branch/worktree, non installa dipendenze, non esegue migrazioni, commit, push o
deploy e non apre ticket operativi in autonomia. Scrive solo nella directory
globale `<YANO_DATA_DIR>/auto-improver/` e nel database SQLite globale. Il planner resta
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
  --report-file /path/alla/YANO_DATA_DIR/auto-improver/...md \
  --summary-file /path/alla/YANO_DATA_DIR/auto-improver/...json
```

Il comando registra l'esito, scrive l'evento nel trace del progetto, cerca i
planner vivi via MQTT e invia il report. `--notify none` disattiva le
notifiche utente; `auto` prova Telegram, WhatsApp ed email usando la
configurazione globale disponibile.

Il planner non considera automaticamente una raccomandazione come approvata:
valuta le evidenze, chiede conferma quando l'impatto è concettuale e, se
accetta, usa `to-spec → to-tickets` e il normale ciclo coder/reviewer.

## API REST (`yano auto-improve serve`)

L'auto-improver, come il debugger, è pensato come un'unica istanza logica
che gestisce molti progetti (lo stesso registro `auto_projects` usato dalla
CLI): `yano auto-improve serve` espone questo registro su HTTP, per chi vuole
avviare/consultare audit da uno strumento diverso dalla shell (uno script, un
altro servizio). Gli handler REST richiamano le stesse funzioni della CLI
(`doInit`, `doRunOrStart`, `doPauseOrStop`, `completeAudit`, ...), quindi i
due canali non possono divergere nel comportamento.

```sh
yano auto-improve serve --port 4178          # default 127.0.0.1:4178
yano config set YANO_AUTO_IMPROVER_API_PORT 4178      # oppure fisso via config
yano config set YANO_AUTO_IMPROVER_API_TOKEN --stdin  # opzionale: richiede Bearer token
```

Il bind di default è solo su `127.0.0.1`: senza token configurato l'API non
richiede autenticazione, per questo resta bene esporla solo in loopback (usa
`--host` solo se sai cosa stai facendo, e in quel caso imposta sempre un
token).

| Metodo | Path                         | Equivalente CLI                       |
|--------|-------------------------------|-----------------------------------------|
| GET    | `/health`                     | —                                        |
| GET    | `/projects`                   | (elenco con id, non disponibile in CLI) |
| POST   | `/projects`                   | `yano auto-improve init`                |
| GET    | `/projects/:id`               | —                                        |
| GET    | `/projects/:id/audits`        | `yano auto-improve status`              |
| GET    | `/projects/:id/reports`       | `yano auto-improve reports`             |
| POST   | `/projects/:id/run`           | `yano auto-improve run`/`start`         |
| POST   | `/projects/:id/pause`         | `yano auto-improve pause`               |
| POST   | `/projects/:id/resume`        | `yano auto-improve resume`              |
| POST   | `/projects/:id/stop`          | `yano auto-improve stop`                |
| POST   | `/audits/:auditId/complete`   | `yano auto-improve complete`            |

`:id` è il `project_key` restituito da `POST /projects` o da `GET /projects`
(lo stesso valore che la CLI calcola internamente da `--project-root`). Le
stesse regole della CLI si applicano identiche: un `project_root` mancante o
un audit inesistente restituiscono lo stesso errore che vedresti da shell,
solo come JSON con lo status HTTP appropriato (400/404).
