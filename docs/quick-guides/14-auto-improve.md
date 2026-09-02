# Auto-improve periodico

Dalla root di Yano o usando il percorso assoluto del progetto osservato:

```sh
yano auto-improve init \
  --project-root /Users/me/projects/my-app \
  --interval 5d \
  --notify auto
yano auto-improve start --project-root /Users/me/projects/my-app
```

Controlla audit e report:

```sh
yano auto-improve status --project-root /Users/me/projects/my-app --json
yano auto-improve reports --project-root /Users/me/projects/my-app
```

Per provare il flusso senza Herdr o scheduler:

```sh
yano auto-improve start \
  --project-root /Users/me/projects/my-app \
  --once --dry-run --json
```

`--once` esegue un solo audit e non avvia lo scheduler detached. `--dry-run`
evita anche l'avvio del worker Herdr, quindi questa è la modalità consigliata
per un test locale non invasivo. Per eseguire davvero un audit singolo usando
il worker, rimuovi `--dry-run`:

```sh
yano auto-improve run --project-root /Users/me/projects/my-app --once
```

Il worker usa il workspace globale `yano-auto-improver` e la tab
`auto-improver-<project-name>`, ma ogni audit parte da un transcript Pi nuovo:
non viene riutilizzato un vecchio `--continue` che potrebbe contenere un piano
di implementazione. Il worker è inoltre avviato con una allow-list senza
`bash`, `edit` o `write`; può usare `auto_improve_web_search` e
`auto_improve_web_fetch` per un confronto online bounded e read-only con fonti
ufficiali HTTPS. L'unica scrittura ammessa è `auto_improve_complete`
per il report globale dell'audit. Ogni report deve includere una valutazione a
360° della capability principale contro almeno tre alternative, con gap matrix
su feature, UX utente/LLM, tool/API, MCP, connettori, plugin, sicurezza,
performance, test, deployment, maturità e licenza. Ogni proposta indica
`requires_human_decision`. Il tool accetta `reports/<audit-id>.md` come
percorso relativo al data-root globale oppure il percorso assoluto equivalente.

Per sospendere, riattivare o fermare la pianificazione:

```sh
yano auto-improve pause --project-root /Users/me/projects/my-app
yano auto-improve resume --project-root /Users/me/projects/my-app
yano auto-improve stop --project-root /Users/me/projects/my-app
```

L'agente è solo osservatore: non modifica mai il progetto. Invia le
raccomandazioni al planner, che decide se aprire ticket di sviluppo.

L'evidence pack considera anche marker reali del repository (`tests/`, file
`*.test.*`, `build/` e config lint), non soltanto gli script di `package.json`.
Se una suite esiste ma non ha un comando standard, l'auto-improver propone di
esporre quel comando invece di segnalare erroneamente l'assenza dei test.

## API REST (per chi non usa la shell)

`yano auto-improve` è un'unica istanza che gestisce molti progetti registrati
(esattamente come in CLI: ogni progetto ha un `project_key` deterministico).
Per avviare/consultare audit senza CLI, avvia l'API REST locale:

```sh
yano auto-improve serve --port 4178
```

Di default resta in ascolto solo su `127.0.0.1`. Per configurare porta e un
token opzionale in modo permanente:

```sh
yano config set YANO_AUTO_IMPROVER_API_PORT 4178
yano config set YANO_AUTO_IMPROVER_API_TOKEN --stdin   # opzionale: richiede
                                                         # 'Authorization: Bearer <token>'
```

Endpoint principali (uno per ogni sottocomando CLI sopra):

```text
GET  /projects                     elenca i progetti registrati con il loro id
POST /projects                     registra un progetto — { project_root, interval_ms?, notify? }
GET  /projects/:id/audits          elenca gli audit del progetto
GET  /projects/:id/reports         elenca i report globali
POST /projects/:id/run             prepara/avvia un audit — { once?, dry_run?, force? }
POST /audits/:auditId/complete     chiude un audit — { report_file, summary_file?, summary? }
POST /projects/:id/pause|resume|stop   gestisce lo scheduler
```

Esempio, per registrare un progetto e verificare la registrazione:

```sh
curl -s -X POST http://127.0.0.1:4178/projects \
  -H 'Content-Type: application/json' \
  -d '{"project_root": "/path/assoluto/del/progetto"}'
# -> restituisce project.project_key, es. "workspace-a1b2c3d4e5f6": usalo come :id

curl -s http://127.0.0.1:4178/projects/workspace-a1b2c3d4e5f6/audits
```

Per l'implementazione completa vedere
[Yano Auto-Improver](./yano-auto-improve.md).
