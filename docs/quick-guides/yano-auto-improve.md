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
L'auto-improver non interroga direttamente l'utente e non apre decision hold:
consegna report e riepilogo al planner del progetto. È il planner che esegue il
triage, sceglie il batch, raccoglie eventuali conferme e assegna il lavoro.

## Evidence pack

Ogni audit salva nel data-root globale un evidence pack bounded: manifest e
script dichiarati, marker reali di test/build/lint (per esempio `tests/`, file
`*.test.*`, `build/` e config ESLint/Biome), stato Git, trace, failure signal e
recupero semantico. La presenza di test o build non dipende quindi soltanto da
uno script npm; se manca uno script standard, il report lo segnala come limite
di riproducibilità separato dall'assenza della suite. La discovery è solo
metadati e non autorizza modifiche al progetto.

Ogni audit include anche una valutazione a 360°: il worker ricostruisce la
capability principale del progetto, cerca almeno tre alternative comparabili
su indici pubblici GitHub/npm e verifica le fonti ufficiali HTTPS. Il confronto
copre feature, qualità, performance, sicurezza/privacy, documentazione, UX
utente e UX per LLM/agent, tool/API, MCP, connettori, plugin/estensioni,
deployment, test, maturità e licenza. Il report deve contenere una gap matrix
`attuale vs alternativa`, URL delle fonti, limiti della ricerca e proposte
classificate per bug, miglioramento tecnico, feature, tool, connettore, plugin
o UX. Le proposte indicano sempre valore, complessità, rischio, confidenza e
`requires_human_decision`.

## Avvio

```sh
yano auto-improve init --project-root /path/progetto --interval 5d --notify auto
yano auto-improve start --project-root /path/progetto
yano auto-improve start --project-root /path/progetto --once --dry-run --json
```

`start` crea o riusa il workspace Herdr `yano-auto-improver`, riusa e rinomina
la tab iniziale numerica libera (non lascia una tab `1` inutile), avvia un
transcript Pi nuovo per l'audit tramite `herdr agent start` con argomenti
separati e avvia lo scheduler detached. La tab/istanza può essere riusata, ma gli audit non
riprendono transcript precedenti, così il confine read-only resta verificabile. Per
verificare il comando senza Herdr:

Il report finale viene salvato nel progetto osservato in
`docs/reports/auto-improvement-<gg-mm-HH_MM>.md`; l'evidence pack tecnico resta
nel data-root globale di Yano per consentire audit e recovery senza appesantire
la repository.

Il supervisore globale esegue anche `yano auto-improve supervise`: dopo un
riavvio ricrea la tab persistente di un worker `idle` e lo scheduler, senza
creare un nuovo audit prima della scadenza. Un audit precedente in
`awaiting_agent`/`running` viene segnato `superseded` se esiste un audit più
recente già completato per lo stesso progetto: resta tracciabile ma non può
riaprire un lavoro obsoleto.

Il worker reale riceve una allow-list di tool (`read`, `grep`, `find`, `ls`,
`auto_improve_web_search`, `auto_improve_web_fetch`, coordinamento MQTT e
`auto_improve_complete`); `bash`, `edit` e `write` non sono disponibili. I due
tool web cercano soltanto indici pubblici e leggono fonti HTTPS bounded, senza
creare o modificare risorse. `auto_improve_complete` può scrivere solo il report globale
associato all'audit (accetta `reports/<audit-id>.md` relativo al data-root o il
percorso assoluto equivalente) e poi chiude l'audit tramite la CLI.

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

### Playbook sequenziale `auto-improvement-360`

L'auto-improver non esegue più un audit monolitico: il ruolo è collegato al
playbook `playbooks/auto-improvement-360.yaml`, che conserva un checkpoint
prima di ogni fase. L'ordine è: preflight, modalità (`backend-only`,
`frontend-only` o `full-stack`), indice degli improvement precedenti, evidence
pack, performance/architettura, backend/API/dati, frontend/UX quando applicabile,
feature/prodotto, micro-validazione, scoring/deduplicazione, report e handoff.

Il ruolo usa il prompt dedicato `prompts/auto-improver.md`, allineato alla skill
`skills-vendor/yano/yano-auto-improvement/SKILL.md`: audit read-only, nessuna
invenzione, evidenze classificate e score/confidence per ogni parere, finding e
raccomandazione.

Il report è schietto e evidence-first: non può inventare metriche, bug, fonti,
alternative o feature. Ogni finding e ogni raccomandazione contiene tipo di
evidenza (`FACT`, `INFERENCE` o `HYPOTHESIS`), riferimenti, `score: X/10`,
motivazione dello score, `confidence: X/10` e motivazione della confidenza.
Una proposta già presente viene classificata e non duplicata; un'area non
applicabile viene registrata come tale. Se una verifica manca, il valore resta
`UNKNOWN` o `REQUIRES_VALIDATION`.

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

L'auto-improver, come il feedback, è pensato come un'unica istanza logica
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
