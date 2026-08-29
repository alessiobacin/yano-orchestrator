# Diagrammi operativi Yano

`architecture.mmd` resta il diagramma complessivo. Questa cartella contiene
viste più piccole, utili durante diagnosi e onboarding:

- [`01-inventario-agenti.mmd`](./01-inventario-agenti.mmd) — stato dei cinque
  agenti esterni e del Planner;
- [`02-repair-riallineamento.mmd`](./02-repair-riallineamento.mmd) — snapshot,
  stop controllato, restart Herdr e pulizia delle copie stale;
- [`03-architect-playbook.mmd`](./03-architect-playbook.mmd) — catalogo,
  proposta ephemeral, readiness, Watcher e promozione;
- [`04-watcher-routing.mmd`](./04-watcher-routing.mmd) — scansione bounded,
  polling, route al Planner/Telegram e ticket Yano;
- [`05-trace-db-gantt.mmd`](./05-trace-db-gantt.mmd) — distinzione tra trace
  globale, DB operativo e dashboard Gantt;
- [`06-agenti-esterni.mmd`](./06-agenti-esterni.mmd) — confini read-only e
  consegna al Planner.

I file `.mmd` sono sorgenti Mermaid: possono essere aperti in VS Code con una
preview Mermaid o renderizzati con uno strumento Mermaid compatibile.

Quando cambia un flusso, aggiorna sia `architecture.mmd` sia la vista operativa
interessata e verifica la matrice in
[`docs/documentation-sync.md`](../documentation-sync.md). Il Gantt persistente
è descritto in `05-trace-db-gantt.mmd`: porte `10000-19999`, registro globale e
comandi `--persistent`, `--link`, `--links`.
