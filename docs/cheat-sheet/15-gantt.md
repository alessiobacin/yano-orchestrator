# yano gantt

Avvia il Gantt live del progetto. Ogni progetto riceve una porta libera stabile
nel range 10000-19999.

~~~bash
yano gantt --persistent --open
yano gantt --persistent --port 10055
yano gantt --link --json
yano gantt --links --json
~~~

La modalità persistent registra il link in
YANO_DATA_DIR/gantt/instances.json e mantiene il processo live in foreground.
--link restituisce il link del progetto corrente; --links elenca tutti i
progetti registrati.

## Contratto essenziale (2026-09-15)

`yano status --all --explain --json` espone decisioni watcher e fingerprint;
`yano feedback-api start` conserva API e dati senza GUI Kanban (`dash` è alias).
Il Gantt mostra fasi previste, dipendenze e round osservati con modelli/provider.
`yano frontend-review browser --url URL` abilita annotazioni DOM senza React.
Watcher/scheduler sono deterministici; Local PC resta il servizio LLM persistente.
Nuovi piani: `plan_set` richiede `scoping.status` e `scoping.rationale`.
Dettagli, compatibilità e limiti: [Yano essenziale](../quick-guides/yano-essential.md).
