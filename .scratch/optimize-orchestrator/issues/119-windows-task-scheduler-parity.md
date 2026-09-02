Type: human
Kind: task
Status: resolved

## Question

`docs/architecture.md` dichiara esplicitamente: "Su Windows il supervisore
deve usare Task Scheduler o un servizio equivalente, non il comando `cron`
POSIX." Verificato nel codice che questo non è mai stato implementato:
`scripts/install-yano-watcher-cron.mjs`, `scripts/install-yano-scheduler-cron.mjs`,
`scripts/yano-watcher-registry.mjs` e `scripts/yano-scheduler.mjs` chiamano
**solo** `spawnSync("crontab", ...)`. Non esiste alcun ramo `schtasks`/Task
Scheduler in tutto il repo.

Conseguenza: su Windows l'intero loop di self-healing (`yano watcher
supervise` ogni minuto, `yano scheduler supervise` per i job ricorrenti
utente) **non si installa mai**, e lo fa in silenzio — `postinstall` chiama
`install-yano-watcher-cron.mjs --if-global --quiet`, che intercetta l'errore
di `crontab` mancante e stampa solo un warning soppresso da `--quiet`.

Cosa serve: un installer `schtasks` equivalente, attivato quando
`process.platform === "win32"`, che:
- crei un'attività pianificata che esegua `yano watcher supervise --json` ogni
  minuto (stesso comando, stessa semantica del cron POSIX);
- sia removibile con lo stesso comando `yano watcher cron --uninstall`;
- sia idempotente come l'installer crontab esistente (non duplica righe/attività
  a install ripetute).

## Answer

Nuovo modulo `scripts/yano-os-scheduler.mjs`: `installOneMinuteWindowsJob`,
`removeOneMinuteWindowsJob`, `statusOneMinuteWindowsJob`. Ognuna controlla
`platform` (default `process.platform`, iniettabile) e restituisce `null` su
piattaforme non Windows — un no-op esplicito che lascia intatto il percorso
crontab POSIX esistente e già testato. Su `win32` compone:

```
schtasks /Create /F /SC MINUTE /MO 1 /TN <nome-derivato-dal-marker> /TR "<comando>"
schtasks /Query /TN <nome> /FO LIST
schtasks /Delete /F /TN <nome>
```

`/F` rende `install` idempotente esattamente come l'installer crontab
(strip-and-replace per marker); il nome dell'attività è derivato in modo
stabile e privo di punteggiatura dallo stesso marker già usato per
identificare la riga di crontab (`schtasksTaskName("# yano-watcher-supervisor")
→ "Yanoyanowatchersupervisor"`).

Cablato, con una patch minimale e additiva che **non tocca** il corpo
esistente delle funzioni crontab (solo un controllo di piattaforma
all'inizio, ritorno anticipato se Windows), in entrambi i supervisori
globali a cadenza di un minuto: `cronInstall`/`cronStatus`/`cronRemove` in
`yano-watcher-registry.mjs` (`yano watcher cron install|status|--uninstall`)
e `schedulerCronInstall`/`schedulerCronStatus`/`schedulerCronRemove` in
`yano-scheduler.mjs` (`yano cron --install|status|--uninstall`). Gli
installer di post-install (`install-yano-watcher-cron.mjs`,
`install-yano-scheduler-cron.mjs`) non hanno richiesto modifiche: delegano
già a queste funzioni, quindi ereditano automaticamente il ramo Windows.

Verifica (reale, senza una vera macchina Windows — non disponibile in questo
sandbox Linux, dichiarato come rischio in apertura di questo ticket, mitigato
così): `scripts/smoke-test-yano-os-scheduler.mjs` (nuovo) usa un binario
`schtasks` fittizio reale su `PATH` (stesso pattern già usato da
`smoke-test-yano-watcher-cron.mjs` per il vero `crontab`) con `platform:
"win32"` forzato esplicitamente, cosa che rende il ramo Windows realmente
eseguito e verificato — non solo letto. Copre: composizione esatta del
comando `/Create` (intervallo un minuto, nome dell'attività, comando
`/TR`), `status` che riflette il vero output di `/Query`, idempotenza di un
secondo `install`, `remove` reale e la sua idempotenza (rimuovere due volte
non lancia mai un'eccezione), e conferma per lettura del sorgente che
entrambi i file chiamante sono effettivamente cablati al modulo. Nessuna
regressione: `smoke-test-yano-watcher-cron.mjs` e `smoke-test-yano-scheduler.mjs`
(percorso crontab POSIX, invariato) restano verdi, così come `npm run
check:docs` e `node scripts/check-skill-isolation.mjs`.

Documentazione aggiornata: `docs/architecture.md` (paragrafo Windows ora
descrive l'implementazione reale invece del solo requisito),
`docs/quick_guides/10-watcher-falle-yano.md`,
`docs/cheat-sheet/31-scheduler.md`, commento in
`scripts/install-yano-watcher-cron.mjs` corretto (non parlava più
correttamente di "sistemi senza crontab" includendo Windows, che ora installa
comunque tramite `schtasks`).

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02. Nota di rischio: non
  è stato possibile testare `schtasks` dal vivo in questo sandbox Linux —
  l'implementazione va validata su una macchina Windows reale. Mitigato con un
  binario `schtasks` fittizio reale su PATH e `platform: "win32"` forzato
  esplicitamente nel test (vedi "## Answer"), che esercita davvero il ramo di
  codice invece di limitarsi a leggerlo — ma resta comunque opportuno un
  controllo su una macchina Windows reale prima di considerarlo definitivo al
  100%.
