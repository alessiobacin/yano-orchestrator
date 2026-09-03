# Diagrammi operativi Yano

Il flusso `clean-repo` comprende l'audit delle categorie documentali e la
creazione approvata dei file mancanti, inclusa la collection Postman quando il
progetto ha un backend.

`docs/architecture/architecture.mmd` resta il diagramma complessivo. Questa
cartella contiene viste più piccole, utili durante diagnosi e onboarding:

- [`01-inventario-agenti.mmd`](./01-inventario-agenti.mmd) — stato dei cinque
  agenti esterni e del Planner;
- [`02-repair-riallineamento.mmd`](./02-repair-riallineamento.mmd) — snapshot,
  stop controllato, restart Herdr e pulizia delle copie stale;
- [`03-architect-playbook.mmd`](./03-architect-playbook.mmd) — catalogo,
  proposta ephemeral, readiness, Watcher e promozione;
- [`04-watcher-routing.mmd`](./04-watcher-routing.mmd) — supervisione globale
  ogni minuto, log/heartbeat, recovery di agenti e schedule, route al Planner/Telegram;
- [`05-trace-db-gantt.mmd`](./05-trace-db-gantt.mmd) — distinzione tra trace
  globale, DB operativo e dashboard Gantt;
- [`06-agenti-esterni.mmd`](./06-agenti-esterni.mmd) — confini read-only e
  consegna al Planner.
- [`07-update-installazione.mmd`](./07-update-installazione.mmd) — distinzione
  tra checkout dev, copia npm permanente, clone Pi e Docker complementare.
- [`08-auto-improvement-360.mmd`](./08-auto-improvement-360.mmd) — fasi,
  checkpoint, scoring e handoff dell'auto-improver al Planner.

I file `.mmd` sono sorgenti Mermaid: possono essere aperti in VS Code con una
preview Mermaid o renderizzati con uno strumento Mermaid compatibile.

Quando cambia un flusso, aggiorna sia `architecture.mmd` sia la vista operativa
interessata e verifica la matrice in
[`docs/guides/documentation-sync.md`](../guides/documentation-sync.md). Il Gantt persistente
è descritto in `05-trace-db-gantt.mmd`: porte `10000-19999`, registro globale e
comandi `--persistent`, `--link`, `--links`.
