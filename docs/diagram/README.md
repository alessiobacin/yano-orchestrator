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
- [`09-heartbeat-liveness.mmd`](./09-heartbeat-liveness.mmd) — scrittore unico
  (file + MQTT) e i due lettori canonici (servizi globali, planner di
  progetto), incluso il rilevamento del caso "processo vivo, event loop
  bloccato".
- [`10-digest-giornaliero.mmd`](./10-digest-giornaliero.mmd) — bootstrap del
  job di default, aggregazione dello stato esistente, invio sul canale
  globale.
- [`11-notifica-canale-globale.mmd`](./11-notifica-canale-globale.mmd) —
  priorità env > `.env` di progetto > config globale per un agente; solo
  config globale per un job cross-progetto.
- [`12-pulizia-tab-agenti.mmd`](./12-pulizia-tab-agenti.mmd) — le due passate
  di chiusura tab (agente vivo, agente sparito del tutto), le eccezioni
  planner/`human`, e la copertura anche di un progetto in pausa.
- [`13-scheduler-dispatch-dedup.mmd`](./13-scheduler-dispatch-dedup.mmd) — il
  fix del duplicate-fire (self-mode sincrono, tetto sui retry asincroni
  stantii).

I file `.mmd` sono sorgenti Mermaid: possono essere aperti in VS Code con una
preview Mermaid o renderizzati con uno strumento Mermaid compatibile.

Quando cambia un flusso, aggiorna sia `architecture.mmd` sia la vista operativa
interessata e verifica la matrice in
[`docs/guides/documentation-sync.md`](../guides/documentation-sync.md). Il Gantt persistente
è descritto in `05-trace-db-gantt.mmd`: porte `10000-19999`, registro globale e
comandi `--persistent`, `--link`, `--links`.
