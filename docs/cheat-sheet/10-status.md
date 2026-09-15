# yano status

Mostra lo stato dei run e dei ticket del progetto.

~~~bash
yano status
yano status --run RUN_ID
yano status --project /percorso/progetto --json
~~~

Per la vista degli agenti live usare yano fleet --project-root "$PWD" --json.

## Contratto essenziale (2026-09-15)

`yano status --all --explain --json` espone decisioni watcher e fingerprint;
`yano feedback-api start` conserva API e dati senza GUI Kanban (`dash` è alias).
Il Gantt mostra fasi previste, dipendenze e round osservati con modelli/provider.
`yano frontend-review browser --url URL` abilita annotazioni DOM senza React.
Watcher/scheduler sono deterministici; Local PC resta il servizio LLM persistente.
Nuovi piani: `plan_set` richiede `scoping.status` e `scoping.rationale`.
Dettagli, compatibilità e limiti: [Yano essenziale](../quick-guides/yano-essential.md).

Ponytail è attivo in modalità `full` per tutti i ruoli Yano, anche con prompt
personalizzati. `yano ponytail status` mostra la policy; `yano ponytail off`
la disattiva nel progetto, `--global` cambia il default ereditato, `reset`
rimuove l’override. Le preferenze persistono fra i riavvii.
