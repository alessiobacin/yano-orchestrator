Type: human
Kind: task
Status: claimed

## Question

Riprodotto dal vivo in questa sessione (`node scripts/smoke-test-yano-watcher-registry.mjs`
senza Herdr installato):

```
Error: yano watcher: Herdr non raggiungibile; avvia Herdr e riprova
    at launchHerdrWorker (scripts/yano-watcher-registry.mjs:350)
```

La stringa "Herdr non raggiungibile" compare in 12 punti su 10 file
(`yano-watcher-registry.mjs`, `yano-repair.mjs`, `yano-recovery.mjs`,
`yano-global-services.mjs`, `yano-suggester.mjs`, `yano-debugger.mjs`,
`yano-auto-improver.mjs`, `yano-scheduler.mjs`, `yano-external-status.mjs`,
`yano-projects.mjs`): in ognuno, quando `herdr api snapshot` fallisce, il
codice si arresta con un messaggio per l'operatore e non tenta nulla di
automatico. Dato che ogni agente Pi (planner incluso) vive dentro un pane
Herdr, un crash di Herdr equivale a un arresto totale della flotta che il cron
"ogni minuto" (`yano watcher supervise`) non è in grado di sanare da solo — il
supervisore stesso dipende da Herdr per fare qualunque riconciliazione.

Nota utile già presente nel codice (`scripts/init-herdr.mjs:112-114`): la
chiamata `herdr workspace create` "è anche il comando che può portare su il
server Herdr locale su una macchina pulita" — quindi esiste già un precedente
di bootstrap-by-side-effect da poter riusare deliberatamente, invece di
limitarsi a fallire su un semplice `herdr api snapshot`.

Cosa serve: centralizzare la chiamata `herdr api snapshot` (oggi duplicata in
ogni file) in un helper condiviso che, prima di arrendersi, tenti un bootstrap
bounded (retry con backoff breve + un tentativo di comando che sappiamo
avviare il server, es. `herdr workspace list`/`create` a vuoto) e segnali
l'esito nel trace; solo se anche questo fallisce, propagare l'errore attuale
all'operatore.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02. Nota di rischio: non
  è stato possibile validare il comportamento reale di bootstrap di Herdr in
  questo sandbox (binario non disponibile) — l'implementazione va verificata
  sulla macchina dell'utente dove Herdr è installato.
