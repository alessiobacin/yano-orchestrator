Type: human
Kind: task
Status: resolved

## Question

L'utente propone di installare Yano in un container Docker per risolvere
l'avvio cross-platform, con MQTT e Yano nello stesso container e la CLI `yano`
installata localmente sull'host (fuori dal container). Chiede anche, in ogni
caso, il riavvio deterministico del daemon Docker quando è giù.

Da valutare prima di implementare:

- Yano orchestra processi `pi` dentro pane Herdr sull'host, fa `git
  worktree`, apre editor/terminali, e legge/scrive file di progetto
  nell'albero di lavoro dell'utente — tutte operazioni che presuppongono
  esecuzione **sull'host**, non in un container isolato. Mettere "Yano" (il
  processo orchestratore) dentro un container lo isolerebbe proprio dalle
  risorse che deve orchestrare (Herdr, worktree Git, filesystem di progetto),
  a meno di bind-mount pervasivi e passthrough del socket Herdr — complessità
  che rischia di introdurre più problemi cross-platform di quanti ne risolva.
  Il broker MQTT invece è già distribuito in Docker (`mqtt/compose.yaml`,
  usato anche da `runDoctor({ autoStartBroker })`) proprio perché è uno
  servizio stateless senza queste dipendenze sull'host.
- Il riavvio deterministico del daemon Docker è invece un miglioramento valido
  indipendentemente dalla decisione sul bundling: oggi `yano doctor` rileva
  "Docker è installato ma il daemon non sembra in esecuzione" e si ferma lì,
  senza tentare di riavviarlo (verificato dal vivo in questa sessione,
  `yano doctor --json` in ambiente senza dockerd attivo). Questo è un caso
  particolare del registro `yano services` (#117): il daemon Docker stesso è
  un servizio esterno di cui Yano dipende (per il broker MQTT auto-avviato) e
  di cui oggi non tenta mai il restart.

## Answer

### Raccomandazione sulla containerizzazione: no, non conviene bundlare la CLI Yano nello stesso container di MQTT

Confermata l'analisi in apertura di ticket, senza modifiche. Yano orchestra
`pi`, Herdr, `git worktree` e il filesystem di progetto **sull'host**; il
broker MQTT è già distribuito in Docker (`mqtt/compose.yaml`) proprio perché
è l'unico componente realmente stateless e senza dipendenze sull'host. Mettere
anche la CLI Yano in un container la isolerebbe esattamente dalle risorse che
deve orchestrare, a meno di bind-mount pervasivi (socket Herdr, `~/.ssh`,
`~/projects/`, credenziali) e passthrough che avrebbero un costo di
manutenzione cross-platform (path Windows vs POSIX dentro il container, named
pipe vs socket Unix per Herdr, permessi UID/GID sui bind-mount Linux) più alto
del problema che risolverebbero. Non implemento questa parte: la valutazione
stessa era la parte "in dubbio" della richiesta, e la conclusione è di non
procedere. Se in futuro cambiano le circostanze (per esempio Herdr acquisisse
un'API di rete invece di un socket locale), vale la pena rivalutare.

### Riavvio deterministico del daemon Docker: implementato "in ogni caso", come richiesto esplicitamente

A differenza di Herdr (ticket #118, dove Yano non indovina deliberatamente il
comando di avvio perché varia per installazione), Docker Desktop/Engine ha un
comando di avvio noto e standard per ciascun sistema operativo maggiore — è
sicuro e corretto che Yano lo conosca direttamente:

- macOS: `open -a Docker`
- Linux: `systemctl start docker || service docker start`
- Windows: avvio del servizio `com.docker.service` via PowerShell, con
  fallback al lancio di Docker Desktop

Nuovo modulo `scripts/yano-docker-daemon.mjs`: `isDockerDaemonRunning()`,
`dockerDaemonRestartCommand(platform)`, `ensureDockerDaemonRunning()` (verifica,
tenta il comando di avvio se giù, poi fa polling bounded fino a
`waitMs`/`pollIntervalMs` invece di ricontrollare una sola volta subito dopo —
Docker Desktop può impiegare diversi secondi ad avviarsi davvero). Cablato in
`scripts/doctor.mjs`: quando `autoStartBroker` è attivo (già il caso di `yano
init`, ticket #41) e Docker è installato ma il daemon non risulta attivo, il
tentativo di riavvio deterministico avviene **prima** di arrendersi e passare
al fallback Mosquitto/messaggio di errore. Il messaggio di errore finale, se
il daemon resta giù, mostra ora anche il comando esatto per registrarlo come
servizio supervisionato in continuo:
`yano services add --name docker --healthcheck-command "docker info"
--restart-command "<stesso comando>"` — così il percorso one-shot (init) e
quello continuo (cron ogni minuto, ticket #117) non divergono mai sullo
stesso comando.

Verifica (reale, in questo sandbox, dove il daemon Docker era genuinamente
giù all'inizio del test):
- `isDockerDaemonRunning()` ha rilevato correttamente `false` con il vero
  binario `docker`.
- `ensureDockerDaemonRunning()` ha davvero tentato `systemctl start docker ||
  service docker start`, ha correttamente rilevato che questo container non
  ha systemd come PID 1 (fallimento reale, non simulato) e ha fatto polling
  per l'intera finestra richiesta (~3.4s per `waitMs:3000` — il loop di
  polling gira davvero, non è un placeholder).
- Avviato poi un vero `dockerd` a mano: `isDockerDaemonRunning()` è passato a
  `true` e `ensureDockerDaemonRunning()` ha correttamente evitato qualunque
  tentativo di restart (`attempted_restart:false`, ~100ms).
- `node bin/yano.mjs doctor` con `autoStartBroker:true` chiamato direttamente:
  nessuna regressione sulle altre righe del report.
- `scripts/smoke-test-yano-docker-daemon.mjs` (nuovo) copre con un `run`
  iniettato, deterministico e veloce, tutti i rami: già sano (nessun
  tentativo), giù→riavviato→tornato sano entro la finestra, comando di
  restart che fallisce a lanciarsi (riportato onestamente, mai nascosto), e
  comando che si lancia ma il daemon non torna mai sano (si arrende al
  timeout configurato, non attende all'infinito — verificato a cronometro).
- Nessuna regressione in `smoke-test-init-preflight.mjs`,
  `smoke-test-init-existing.mjs`, `npm run check:docs`,
  `node scripts/check-skill-isolation.mjs`. (`smoke-test-mcp-credential-preflight.mjs`
  fallisce per l'assenza di Code Mem in questo sandbox — verificato con `git
  stash` che fallisce identicamente anche sul codice non modificato: non è
  una regressione di questo lavoro.)

Documentazione aggiornata: `docs/architecture.md` (in coda alla sezione
"External service supervision"), `docs/cheat-sheet/32-services.md`,
README.md — entrambe con l'esempio `yano services add --name docker ...`
accanto a quello già esistente per `herdr`.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
