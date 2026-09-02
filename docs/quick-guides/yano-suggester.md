# Yano suggester

`yano-suggester` è il quarto agente esterno di Yano. Raccoglie suggerimenti
degli utenti, li deduplica e prepara una proposta read-only. Non modifica mai
il progetto osservato: il planner resta l'unico agente che può trasformare una
proposta approvata in un task di sviluppo.

## Prima versione

- registro globale SQLite in `<YANO_DATA_DIR>/suggester/suggester.sqlite`;
- dati, evidence pack e report in `<YANO_DATA_DIR>/suggester/`;
- workspace Herdr globale `yano-suggester`, una tab per progetto chiamata
  `suggester-<project-name>`;
- intake CLI con testo redatto e fingerprint esatto per deduplicare;
- analisi worker con skill `yano-observer` e `yano-suggester`;
- lifecycle `received → analyzing → awaiting_approval → accepted|rejected`;
- gate esplicito `approve --actor ... --yes` prima dell'handoff;
- notifica del planner via MQTT e notifiche opzionali Telegram, WhatsApp,
  SendGrid dopo l'approvazione.

Il matching semantico è preparato tramite il piano di retrieval della trace,
ma la deduplicazione affidabile della v1 è deterministica. Non vengono
iniettati FAB o endpoint nell'applicazione.

## Comandi

```bash
yano suggester init --project-root /path/progetto --notify auto
yano suggester start --project-root /path/progetto
yano suggester start --project-root /path/progetto --once --dry-run
yano suggester submit --project-root /path/progetto \
  --title "Export CSV" \
  --description "Vorrei esportare la vista corrente" \
  --source user --priority medium
yano suggester status --project-root /path/progetto --json
yano suggester reports --project-root /path/progetto
yano suggester approve --suggestion-id SUG-... --actor superadmin --yes
yano suggester reject --suggestion-id SUG-... --actor superadmin \
  --reason "Fuori scope" --yes
yano suggester pause --project-root /path/progetto
yano suggester resume --project-root /path/progetto
yano suggester stop --project-root /path/progetto
```

Per fare solo intake e non aprire/risvegliare Herdr usare `--queue-only`.
`--once` processa al massimo una proposta pendente e termina senza scheduler;
con `--dry-run` verifica la composizione del comando senza Herdr. Anche
`submit --once` permette di testare un singolo intake/dispatch.
L'agente completa il report con:

```bash
yano suggester complete --project-root /path/progetto \
  --suggestion-id SUG-... \
  --report-file /path/assoluto/sotto/YANO_DATA_DIR/suggester/...md \
  --category feature --summary "..." --value "..." \
  --complexity medium --risk low --confidence high
```

Il report deve restare nella directory globale `<YANO_DATA_DIR>/suggester`; questa
barriera impedisce che il worker usi la CLI per scrivere nel progetto.

## Flusso di approvazione

Una proposta `awaiting_approval` non avvia alcuno sviluppo. Il superadmin la approva o
la rifiuta; soltanto nel primo caso Yano invia al planner il report. Il planner
decide se chiedere chiarimenti oppure eseguire il percorso
`to-spec → to-tickets → coder → reviewer → docs-sync`.

## API REST (`yano suggester serve`)

Il suggester, come il debugger, è pensato come un'unica istanza logica che
gestisce molti progetti (lo stesso registro `suggester_projects` usato dalla
CLI): `yano suggester serve` espone questo registro su HTTP, per chi vuole
integrare l'intake da uno strumento diverso dalla shell. Gli handler REST
richiamano le stesse funzioni della CLI (`doSubmit`, `doApproveOrReject`,
`completeSuggestion`, ...), quindi i due canali non possono divergere nel
comportamento — incluso il gate umano: `approve`/`reject` via REST richiedono
`{ actor, yes: true }` nel body esattamente come `--actor --yes` da shell, e
senza `yes: true` la richiesta viene rifiutata con `400`.

```bash
yano suggester serve --port 4179          # default 127.0.0.1:4179
yano config set YANO_SUGGESTER_API_PORT 4179      # oppure fisso via config
yano config set YANO_SUGGESTER_API_TOKEN --stdin  # opzionale: richiede Bearer token
```

Il bind di default è solo su `127.0.0.1`: senza token configurato l'API non
richiede autenticazione, per questo resta bene esporla solo in loopback.

| Metodo | Path                                | Equivalente CLI                       |
|--------|---------------------------------------|-----------------------------------------|
| GET    | `/health`                             | —                                        |
| GET    | `/projects`                           | (elenco con id, non disponibile in CLI) |
| POST   | `/projects`                           | `yano suggester init`                   |
| GET    | `/projects/:id`                       | —                                        |
| GET    | `/projects/:id/suggestions`           | `yano suggester status`                 |
| GET    | `/projects/:id/reports`               | `yano suggester reports`                |
| POST   | `/projects/:id/suggestions`           | `yano suggester submit`                 |
| POST   | `/projects/:id/pause`                 | `yano suggester pause`                  |
| POST   | `/projects/:id/resume`                | `yano suggester resume`/`start`         |
| POST   | `/projects/:id/stop`                  | `yano suggester stop`                   |
| POST   | `/suggestions/:suggestionId/complete` | `yano suggester complete`               |
| POST   | `/suggestions/:suggestionId/approve`  | `yano suggester approve`                |
| POST   | `/suggestions/:suggestionId/reject`   | `yano suggester reject`                 |

`:id` è il `project_key` restituito da `POST /projects` o da `GET /projects`.

## Sicurezza e limiti attuali

Il testo è input non fidato: vengono redatti pattern comuni di segreti, le
istruzioni contenute nel suggerimento non sono comandi e ogni progetto è
isolato dal proprio `project_key`. L'intake HTTP/FAB, autenticazione utente,
rate limiting, allegati, clustering semantico e dashboard amministrativa sono
funzioni future documentate nella [roadmap degli agenti esterni](../notes/agents/external-agents-roadmap.md).
