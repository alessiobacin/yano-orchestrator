# Yano Debugger: guida rapida

## Avviare il debugger per un progetto

```bash
cd /path/del/progetto
yano debugger init --base-port 3055
yano debugger start
```

Per una verifica locale senza aprire Herdr e senza avviare processi persistenti:

```bash
yano debugger start --once --json
```

`--once` esegue una sola preflight read-only su trace, bug e stato del worker,
poi termina. Non modifica il progetto e non apre una tab Herdr.

## Segnalare un bug

```bash
yano debugger report \
  --title "Titolo breve" \
  --description "Cosa succede" \
  --severity medium \
  --source user \
  --expected "comportamento atteso" \
  --actual "comportamento osservato" \
  --steps $'passo 1\npasso 2' \
  --environment '{"browser":"Chrome","os":"macOS","version":"1.0.0"}' \
  --json
```

`--expected`, `--actual`, `--steps` e `--environment` sono obbligatori. Il
dettaglio completo, inclusa la cronologia diagnostica, si legge con:

```bash
yano debugger status --bug-id BUG-... --json
```

Salva l'`bug_id` restituito. Le segnalazioni equivalenti vengono deduplicate.

## Controllare, mettere in pausa e riprendere

```bash
yano debugger status --json
yano debugger status --bug-id BUG-...
yano debugger pause
yano debugger resume
```

`pause` non chiude la tab Herdr. `resume` riusa la tab se è ancora presente o
ne crea una nuova nel workspace globale `yano-debugger`; la tab segue il nome
`debugger-<project-name>`.

## Flusso di validazione

Il debugger deve avanzare il bug nell'ordine diagnostico `triaged`,
`reproducing`, `not_reproducible` oppure `blocked`:

```bash
yano debugger claim --bug-id BUG-... --actor debugger-app
yano debugger transition --bug-id BUG-... --to triaged --actor debugger-app
yano debugger transition --bug-id BUG-... --to reproducing --actor debugger-app
yano debugger transition --bug-id BUG-... --to blocked --actor debugger-app
```

Gli stati `fixing`, `testing`, `staging`, `awaiting_validation` e `production`
non appartengono al debugger. Dopo la diagnosi, il planner decide se aprire il
normale task con coder/reviewer e deployment-agent; il debugger non corregge,
non deploya e non promuove codice.

Per analizzare l'origine del problema, usare il trace del progetto:

```bash
yano trace context --json
yano trace search --query "BUG-..." --json
```

## API REST (per chi non usa la shell)

`yano debugger` è un'unica istanza che gestisce molti progetti registrati
(esattamente come in CLI: ogni progetto ha un id deterministico, il
`project_key`). Per aggiungere o consultare bug senza CLI, avvia l'API REST
locale:

```bash
yano debugger serve --port 4177
```

Di default resta in ascolto solo su `127.0.0.1`. Per configurare porta e un
token opzionale in modo permanente:

```bash
yano config set YANO_DEBUGGER_API_PORT 4177
yano config set YANO_DEBUGGER_API_TOKEN --stdin   # opzionale: richiede
                                                    # 'Authorization: Bearer <token>'
```

Endpoint principali (uno per ogni sottocomando CLI sopra):

```text
GET  /projects                     elenca i progetti registrati con il loro id
POST /projects                     registra un progetto — { project_root, base_port? }
GET  /projects/:id/bugs            elenca i bug del progetto
POST /projects/:id/bugs            segnala un bug — { title, description, severity, ... }
GET  /bugs/:bugId                  stato di un bug
POST /bugs/:bugId/claim            assegna il bug — { actor }
POST /bugs/:bugId/transition       avanza lo stato — { to, actor? }
POST /projects/:id/start|pause|resume   gestisce il worker Herdr
```

Esempio, per registrare llmproxy e segnalare un bug:

```bash
curl -s -X POST http://127.0.0.1:4177/projects \
  -H 'Content-Type: application/json' \
  -d '{"project_root": "/path/assoluto/di/llmproxy"}'
# -> restituisce project.project_key, es. "workspace-a1b2c3d4e5f6": usalo come :id

curl -s -X POST http://127.0.0.1:4177/projects/workspace-a1b2c3d4e5f6/bugs \
  -H 'Content-Type: application/json' \
  -d '{"title": "Login rotto", "description": "401 dopo login corretto", "severity": "high", "expected": "200", "actual": "401"}'
```

Una collection Postman pronta all'uso (con variabili `baseUrl`/`token` e
salvataggio automatico di `projectId`/`bugId` dalle risposte) è in
`docs/postman/yano-debugger.postman_collection.json` (+ `docs/postman/yano-debugger.postman_environment.json`).

Per l'implementazione completa e i confini di sicurezza, vedere
[Yano Debugger](../yano-debugger.md).
