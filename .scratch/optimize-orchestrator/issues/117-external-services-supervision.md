Type: human
Kind: task
Status: claimed

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

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
