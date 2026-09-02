Type: human
Kind: task
Status: resolved

## Question

Yano non supervisiona alcun servizio esterno di cui dipende operativamente.
Caso concreto citato dall'utente: `llmProxy` (router LLM locale, di default
`http://127.0.0.1:7045`, tipicamente eseguito in un container Docker o gestito
da pm2 sulla macchina dell'utente). `scripts/yano-model-advisor.mjs` lo
interroga via HTTP con fallback CLI-spawn, ma se entrambi falliscono
**degrada silenziosamente ad "auto"** (commento esplicito in `.env.example`:
"optional; CLI-only, degrades to auto"). Non esiste in tutto il repo:

- un registro di servizi esterni dichiarati dall'utente (nome, tipo di
  health-check, comando/target di restart);
- un health-check periodico di questi servizi dentro `yano watcher supervise`
  (che già gira ogni minuto via crontab);
- una logica che, rilevato un servizio giù, tenti un restart deterministico
  (`docker restart <container>`, `pm2 restart <app>`, o un comando arbitrario)
  con backoff e alert solo se anche il restart fallisce.

Il solo precedente esistente è l'auto-start del broker MQTT ufficiale durante
`yano init` quando Docker è disponibile ma la porta non risponde (ticket #41,
`runDoctor({ autoStartBroker })`) — utile ma one-shot al momento dell'init, non
un loop di supervisione continuo, e limitato al broker MQTT del pacchetto
stesso.

Cosa serve: un nuovo comando `yano services` (registro dichiarativo via
`yano config`/file dedicato) + integrazione nel loop di
`yano watcher supervise` che esegua l'health-check di ogni servizio registrato
a ogni passata e, se fallito, tenti il restart dichiarato con backoff
esponenziale bounded, tracciando l'esito nel trace globale e alertando (stesso
canale Telegram/notifiche già usato dal watcher) solo se il restart stesso
fallisce ripetutamente.

## Answer

Nuovo modulo `scripts/yano-services.mjs` + comando CLI `yano services
add|list|remove|enable|disable|check|supervise`:

- Registro JSON (`<YANO_DATA_DIR>/services/services.json`, scrittura atomica
  tmp+rename come `gantt-registry.mjs`/`yano-rules.mjs`), un record per
  servizio con `healthcheck` (`http` con URL, o `command` con exit-code),
  `restart` (`docker restart <target>`, `pm2 restart <target>`, o un comando
  arbitrario via shell), `backoff` (`base_ms`/`max_ms`/`max_attempts`,
  default 5s/5min/6) e `state` persistito.
- `superviseExternalServices()`: un health-check per servizio abilitato a ogni
  passata; se non sano e il backoff è scaduto, un tentativo di restart con
  backoff esponenziale bounded; dopo `max_attempts` tentativi consecutivi
  falliti lo stato diventa `giving_up` (resta osservato, mai più riavviato
  automaticamente, evitando di martellare un target che non può tornare su da
  solo). Un ritorno a sano dopo un restart viene marcato `recovered: true` e
  azzera il contatore.
- `checkExternalServices()`: controparte di sola lettura, non tocca mai lo
  stato persistito né tenta un restart — per diagnosi manuale.
- Wiring nel loop esistente: `yano-watcher-registry.mjs`'s `supervise(db)`
  (già chiamato ogni minuto da crontab via `yano watcher supervise`, stesso
  loop che risana i pane Herdr e i run SQLite non finalizzati) ora chiama
  anche `superviseExternalServices()` e aggiunge `external_services` al
  risultato. Questo ha richiesto di rendere `withSupervisorLock`/`supervise`
  asincroni (unico call site aggiornato con `await`) perché l'health-check
  HTTP/comando è intrinsecamente asincrono.

Verifica (tutta con processi reali, nessun mock):
`scripts/smoke-test-yano-services.mjs` (nuovo) copre validazione, CRUD,
`check` realmente read-only contro un vero server HTTP, `supervise` che
riavvia realmente un comando dichiarato e poi rispetta il backoff, rilevamento
reale del recovery riavviando il vero server HTTP, `max_attempts` →
`giving_up` con verifica che il comando di restart smetta di essere invocato,
skip dei servizi disabilitati, costruzione esatta dei comandi
`docker restart`/`pm2 restart` (binari fittizi su PATH, stesso pattern di
`smoke-test-yano-watcher-cron.mjs`), e `remove` idempotente. Verificato anche
manualmente end-to-end con un vero server HTTP Node avviato/killato a mano
(vedi log della sessione): rilevamento down → tentativo di restart → rilevato
sano con `recovered:true` dopo aver rialzato il server → `giving_up` dopo aver
esaurito i tentativi con il server tenuto giù. Integrazione confermata con
`node bin/yano.mjs watcher supervise --json`: `external_services` compare nel
risultato reale insieme a `global_services`/`external_workers`. Nessuna
regressione in `smoke-test-yano-watcher-cron.mjs`, `smoke-test-yano-scheduler.mjs`,
`smoke-test-yano-config.mjs`, `npm run check:docs`, `npm run lint:capabilities`,
`npm run lint:playbooks`, `node scripts/check-skill-isolation.mjs`.

Documentazione aggiornata: `docs/architecture.md` (nuova sezione "External
service supervision" sotto "Failure and recovery"),
`docs/cheat-sheet/32-services.md` + indice, README.md (blocco comandi),
`skills-vendor/yano/yano-cli/references/command-reference.md` e `SKILL.md`.

Nota di sicurezza dichiarata esplicitamente in codice/documentazione: il
comando di restart/healthcheck dichiarato dall'utente viene eseguito senza
sandboxing (stesso modello di fiducia di `yano config set`, dati
locali/per-utente, non input dal progetto osservato o dalla rete) — un
operatore deve registrare solo comandi di cui si fida, perché
`yano watcher supervise` li esegue senza presidio ogni minuto.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
