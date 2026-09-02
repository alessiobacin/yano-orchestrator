Type: human
Kind: task
Status: claimed

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

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02. Nota di rischio: non
  è stato possibile testare `schtasks` dal vivo in questo sandbox Linux —
  l'implementazione va validata su una macchina Windows reale.
