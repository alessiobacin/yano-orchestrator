# Yano Debugger

`yano-debugger` è il secondo agente esterno di Yano. Riceve segnalazioni di
bug applicativi, conserva il loro ciclo di vita in SQLite e avvia un worker
Herdr globale con una tab per progetto.

## Confini

- `project` è la modalità normale: il debugger opera solo sul progetto
  applicativo indicato da `--project-root`.
- `yano-maintenance` è riservata ai difetti di Yano e richiede la root esplicita
  del repository `yano-orchestrator`.
- Il debugger non promuove automaticamente codice in produzione. La
  promozione richiede staging validato, un `deployment-id`, un attore
  autorizzato e `--yes`.

Il registro si trova in `debugger/debugger.sqlite` sotto la directory globale
di Yano (`YANO_DATA_DIR`, normalmente `temp/`). Gli eventi importanti vengono
anche scritti nel trace del progetto; il trace resta la fonte forense, mentre
SQLite è la fonte dello stato del bug.

## Avvio del worker

Inizializza un progetto e assegna una base-porta. Le porte vengono mantenute
allineate tra gli ambienti:

```bash
yano debugger init --project-root /path/app --base-port 3055
yano debugger start --project-root /path/app
yano debugger status --project-root /path/app --json
```

La base `3055` produce backend `3055/4055/5055` e frontend
`6055/7055/8055` per development/staging/production. `start` crea o riusa il
workspace Herdr globale `yano-debugger`, crea una tab con il nome del progetto
e lancia `yano start --role debugger` nella sua pane. Per diagnostica e test
senza Herdr si può usare `--foreground`: registra il worker ma non apre una
tab.

```bash
yano debugger pause --project-root /path/app
yano debugger resume --project-root /path/app
```

La pausa è logica e non chiude la tab: questo conserva la possibilità di
riprendere. `resume` controlla il registro e riapre il worker quando manca.

## Ciclo di un bug

Il ciclo principale è:

```text
reported → triaged → reproducing → fixing → testing → staging
         → awaiting_validation → production
```

Sono disponibili anche `blocked`, `not_reproducible`, `rejected`, `duplicate`
e `rolled_back`. Ogni cambio di stato genera un evento SQLite e un evento
trace.

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

Il debugger prende in carico e avanza il bug solo con evidenza:

```bash
yano debugger claim --project-root /path/app --bug-id BUG-... --actor debugger-app
yano debugger transition --bug-id BUG-... --to triaged --actor debugger-app
yano debugger transition --bug-id BUG-... --to reproducing --actor debugger-app
yano debugger transition --bug-id BUG-... --to fixing --actor debugger-app
yano debugger transition --bug-id BUG-... --to testing --actor debugger-app
yano debugger transition --bug-id BUG-... --to staging --actor debugger-app
yano debugger transition --bug-id BUG-... --to awaiting_validation --actor debugger-app
```

Dopo la validazione esplicita del deploy staging:

```bash
yano debugger promote \
  --project-root /path/app \
  --bug-id BUG-... \
  --deployment-id staging-deploy-42 \
  --actor superadmin \
  --yes
```

Questa versione registra l'identità del deployment e protegge la transizione;
non contiene ancora un adapter Docker/cloud universale. L'esecuzione del
deploy resta responsabilità del playbook di deployment e del relativo adapter,
che dovranno essere aggiunti prima di automatizzare davvero staging e
production.

## Integrazione con trace e planner

Il prompt `prompts/debugger.md` obbliga l'agente a leggere il contesto minimo
con `yano trace context`, riprodurre il bug, lavorare in worktree e passare la
review al reviewer. Non vengono salvati chain-of-thought nascosti: restano
disponibili messaggi osservabili, eventi tool, report e prove di test.
