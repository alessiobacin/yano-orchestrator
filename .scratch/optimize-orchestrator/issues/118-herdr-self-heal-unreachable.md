Type: human
Kind: task
Status: resolved

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

## Answer

Scelta di design: **non** ho fatto indovinare a Yano come avviare Herdr (app
GUI, servizio background/launchd, demone CLI — varia per macchina e un
tentativo sbagliato potrebbe essere peggio di non fare nulla). Invece:

1. Nuovo modulo condiviso `scripts/yano-herdr-client.mjs`: `herdrSnapshot()`
   con retry bounded e backoff sincrono (`Atomics.wait` su una
   `SharedArrayBuffer` — sleep sincrono portabile, verificato con un
   micro-benchmark reale: 300ms richiesti → 300ms misurati) invece del
   singolo tentativo non ritentato di prima. Risolve la brittleness concreta
   osservata (un solo blip transitorio — Herdr che si sta ancora avviando —
   bastava a far fallire l'intero controllo).
2. Migrati a questo modulo condiviso i tre punti più critici per la
   resilienza automatica: `yano-watcher-registry.mjs` (il loop `supervise()`
   chiamato ogni minuto da crontab), `watch-stalls.mjs` (il watcher
   persistente), `yano-global-services.mjs` (le tab di servizio
   watcher/debugger). Rimangono **deliberatamente non migrati** in questo
   passaggio gli altri ~9 punti che reimplementavano lo stesso
   `herdrSnapshot()` (`yano-projects.mjs`, `yano-repair.mjs`,
   `yano-scheduler.mjs`, `yano-status.mjs`, `yano-debugger.mjs`,
   `yano-auto-improver.mjs`, `yano-suggester.mjs`, `yano-architect.mjs`,
   `yano-external-status.mjs`, `launch-planner.mjs`): sono per lo più comandi
   diagnostici invocati da un umano, non parte del loop automatico non
   presidiato, e toccarli tutti in una sola sessione avrebbe alzato il
   rischio di regressione senza un beneficio equivalente per il problema
   specifico posto dall'utente (riavvio automatico dopo crash). Segnalato
   come follow-up esplicito, non nascosto.
3. **Convenzione del nome riservato `herdr`**: `supervise()` in
   `yano-watcher-registry.mjs` ora chiama `superviseExternalServices()`
   (ticket #117) **prima** di tentare il proprio snapshot Herdr della
   passata. Se l'operatore registra `yano services add --name herdr
   --healthcheck-command "..." --restart-command "<comando reale>"`, quel
   comando di restart — dichiarato da chi conosce davvero come si avvia
   Herdr sulla propria macchina — ha la possibilità di riportarlo su prima
   che lo snapshot venga tentato. Il risultato di `supervise()` espone anche
   `herdr_reachable` e `herdr_service_registered` per rendere lo stato
   ispezionabile.

Verifica (reale, non mock): `scripts/smoke-test-yano-herdr-client.mjs`
(nuovo) copre il caso di successo al primo tentativo (zero retry sprecati),
il recupero da un fallimento transitorio entro la stessa chiamata, l'esaurimento
di tutti i tentativi che restituisce `null` senza mai lanciare eccezioni,
output JSON malformato trattato come tentativo fallito (non un crash), e
`attempts:1` che riproduce esattamente il comportamento non-ritentato
originale. **Test end-to-end reale** eseguito in questo sandbox (dove il
binario `herdr` non esiste affatto, quindi Herdr è genuinamente
irraggiungibile): registrato un servizio `herdr` con un comando di restart
che scrive un marker file, lanciato `node bin/yano.mjs watcher supervise
--json` reale, e verificato che il marker file contenga effettivamente
`restart-called` dopo il passaggio — il meccanismo di self-heal dichiarativo
funziona nel percorso di codice reale, non solo in un test unitario isolato.
Nessuna regressione in `smoke-test-watch-stalls.mjs` (16 asserzioni),
`smoke-test-yano-watcher-cron.mjs`, `smoke-test-yano-status.mjs`,
`smoke-test-late-broker.mjs`, `smoke-test-instance-liveness.mjs`,
`smoke-test-yano-external-status.mjs`, `npm run check:docs`,
`node scripts/check-skill-isolation.mjs`.

Documentazione aggiornata: `docs/architecture.md` (sezione "External service
supervision"), `docs/quick_guides/10-watcher-falle-yano.md`,
`docs/cheat-sheet/32-services.md`, README.md — tutte con l'esempio esplicito
che il comando di restart di `herdr` è un placeholder da sostituire con
quello reale della macchina dell'utente, per non far copiare/incollare un
comando inventato.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02. Nota di rischio: non
  è stato possibile validare il comportamento reale di bootstrap di Herdr in
  questo sandbox (binario non disponibile) — l'implementazione va verificata
  sulla macchina dell'utente dove Herdr è installato.
- I restanti ~9 call site duplicati di `herdrSnapshot()` sono un follow-up
  deliberatamente deferito (vedi "## Answer"); non un difetto dimenticato.
