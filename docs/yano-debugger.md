# Yano Debugger

`yano-debugger` è il secondo agente esterno di Yano. Riceve segnalazioni di
bug applicativi, conserva il loro ciclo di vita in SQLite e avvia un worker
Herdr globale con una tab per progetto.

## Confini

- `project` è la modalità normale: il debugger opera solo sul progetto
  applicativo indicato da `--project-root`.
- `yano-maintenance` è riservata ai difetti di Yano e richiede la root esplicita
  del repository `yano-orchestrator`.
- Il debugger è esclusivamente diagnostico: non corregge, deploya o promuove
  codice. Il planner apre il normale flusso con coder/reviewer e
  deployment-agent quando la diagnosi viene accettata.

Il registro si trova in `<YANO_DATA_DIR>/debugger/debugger.sqlite` sotto la
directory globale di Yano. Gli eventi importanti vengono
anche scritti nel trace del progetto; il trace resta la fonte forense, mentre
SQLite è la fonte dello stato del bug.

## Avvio del worker

Inizializza un progetto e assegna una base-porta. Le porte vengono mantenute
allineate tra gli ambienti:

```bash
yano debugger init --project-root /path/app --base-port 3055
yano debugger start --project-root /path/app
yano debugger status --project-root /path/app --json
yano debugger start --project-root /path/app --once --json
```

La base `3055` produce backend `3055/4055/5055` e frontend
`6055/7055/8055` per development/staging/production. `start` crea o riusa il
workspace Herdr globale `yano-debugger`, crea una tab chiamata
`debugger-<project-name>` e lancia `yano start --role debugger` nella sua pane.
Per diagnostica e test
senza Herdr si può usare `--foreground`: registra il worker ma non apre una
tab. `start --once` esegue invece una sola preflight read-only su trace e bug,
non apre Herdr, non avvia processi persistenti e restituisce un report JSON.

```bash
yano debugger pause --project-root /path/app
yano debugger resume --project-root /path/app
```

La pausa è logica e non chiude la tab: questo conserva la possibilità di
riprendere. `resume` controlla il registro e riapre il worker quando manca.

## Ciclo di un bug

Il ciclo diagnostico è:

```text
reported → triaged → reproducing → not_reproducible|blocked
```

Sono disponibili anche `rejected` e `duplicate`. Ogni cambio di stato genera un
evento SQLite e un evento trace.

Segnala un bug con dati riproducibili:

```bash
yano debugger report \
  --project-root /path/app \
  --title "Salvataggio restituisce 500" \
  --description "Dopo l'invio del form il backend risponde 500" \
  --severity high \
  --source user \
  --reporter user@example.test \
  --expected "201 Created" \
  --actual "500 Internal Server Error" \
  --steps $'apri il form\ncompila i campi\ninvia' \
  --json
```

Il fingerprint rende idempotente la segnalazione: una segnalazione uguale
restituisce il bug esistente invece di crearne uno duplicato.

### Chi guarda il bug appena aperto

Una segnalazione nuova (non duplicata) sveglia in automatico, via MQTT, ogni
istanza `debugger` live su quel progetto (`pi/<project>/roles/debugger/tasks`
— stesso meccanismo di `agent_send`, nessun bisogno di conoscere l'id esatto
dell'istanza) e, come rete di sicurezza, anche un'istanza `planner` live: se
non c'è ancora un debugger avviato per il progetto, il planner sa che può
avviarne uno con `yano debugger start` o gestire la triage direttamente. È
best-effort (broker MQTT irraggiungibile o nessuno online non è un errore: il
bug resta comunque nel registro, visibile con `yano debugger status`), ma
chiude il buco per cui un bug segnalato — da `qa-full-audit`, da un utente, da
qualunque fonte — restava silenzioso finché qualcuno non ricordava di
controllarlo a mano. La decisione di stato diagnostico resta sempre del
debugger, mai di chi ha aperto il ticket, anche quando la segnalazione arriva
già con evidenza riproducibile pronta (comando, exit code, expected/actual).

Il debugger prende in carico e avanza solo gli stati diagnostici con evidenza:

```bash
yano debugger claim --project-root /path/app --bug-id BUG-... --actor debugger-app
yano debugger transition --bug-id BUG-... --to triaged --actor debugger-app
yano debugger transition --bug-id BUG-... --to reproducing --actor debugger-app
yano debugger transition --bug-id BUG-... --to not_reproducible --actor debugger-app
yano debugger transition --bug-id BUG-... --to blocked --actor debugger-app
```

Le fasi `fixing`, `testing`, `staging`, `awaiting_validation` e `production`
non sono responsabilità del debugger: invia la diagnosi al planner, che decide
se aprire un normale task e coinvolgere coder/reviewer/deployment-agent.

## API REST (`yano debugger serve`)

Il debugger è pensato come un'unica istanza logica che gestisce molti
progetti (esattamente come il registro `debugger_projects` già fa per la
CLI): `yano debugger serve` espone lo stesso registro su HTTP, per chi vuole
integrare il debugger da uno strumento diverso dalla shell (Postman, uno
script, un altro servizio). Gli handler REST richiamano le stesse funzioni
della CLI (`reportBug`, `transitionBug`, `ensureProject`, `launchHerdrWorker`,
...), quindi i due canali non possono divergere nel comportamento.

```bash
yano debugger serve --port 4177          # default 127.0.0.1:4177
yano config set YANO_DEBUGGER_API_PORT 4177     # oppure fisso via config
yano config set YANO_DEBUGGER_API_TOKEN --stdin # opzionale: richiede Bearer token
```

Il bind di default è solo su `127.0.0.1`: senza token configurato l'API non
richiede autenticazione, per questo resta bene esporla solo in loopback (usa
`--host` solo se sai cosa stai facendo, e in quel caso imposta sempre un
token).

| Metodo | Path                              | Equivalente CLI                              |
|--------|------------------------------------|-----------------------------------------------|
| GET    | `/health`                          | —                                               |
| GET    | `/projects`                        | (elenco con id, non disponibile in CLI)        |
| POST   | `/projects`                        | `yano debugger init`                           |
| GET    | `/projects/:id`                    | —                                               |
| GET    | `/projects/:id/bugs`               | `yano debugger status --project-root <dir>`    |
| POST   | `/projects/:id/bugs`               | `yano debugger report`                         |
| POST   | `/projects/:id/start`              | `yano debugger start`                          |
| POST   | `/projects/:id/pause`              | `yano debugger pause`                          |
| POST   | `/projects/:id/resume`             | `yano debugger resume`                         |
| GET    | `/bugs/:bugId`                     | `yano debugger status --bug-id <id>`           |
| POST   | `/bugs/:bugId/claim`               | `yano debugger claim`                          |
| POST   | `/bugs/:bugId/transition`          | `yano debugger transition`                     |

`:id` è il `project_key` restituito da `POST /projects` o da `GET /projects`
(lo stesso valore che la CLI calcola internamente da `--project-root`, es.
`workspace-a1b2c3d4e5f6`). Le stesse regole di validazione della CLI si
applicano identiche: severità/source non validi, transizioni di stato non
consentite, bug duplicati (fingerprint) e il divieto di usare stati non
diagnostici (`fixing`, `testing`, `staging`, `awaiting_validation`,
`production`) restituiscono lo stesso errore che vedresti da shell, solo come
JSON con lo status HTTP appropriato (400/401/404/409).

Collection Postman pronta all'uso in `postman/yano-debugger.postman_collection.json`
(più l'environment `postman/yano-debugger.postman_environment.json`).

## Integrazione con trace e planner

Il prompt `prompts/debugger.md` obbliga l'agente a leggere il contesto minimo
con `yano trace context`, riprodurre il bug in modo non distruttivo e passare
la diagnosi al planner. Il debugger non crea worktree di sviluppo, non modifica
file e non passa review al posto del planner. Non vengono salvati chain-of-
thought nascosti: restano disponibili messaggi osservabili, eventi tool, report
e prove diagnostiche.
