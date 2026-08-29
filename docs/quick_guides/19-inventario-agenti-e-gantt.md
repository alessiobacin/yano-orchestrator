# Inventario agenti, repair e Gantt

## Vedere i progetti seguiti dai worker esterni

```bash
yano architect projects
yano watcher projects
yano debugger projects
yano auto-improve projects       # alias: yano auto-improver projects
yano suggester projects
```

Questi comandi mostrano solo agenti Pi realmente live in Herdr. Per includere
proposte, registrazioni offline e worker in pausa:

```bash
yano watcher projects --all --json
```

`active_projects` è l'elenco operativo; `registered_projects` comprende anche
lo storico registrato. Architect è normalmente transitorio: può essere
terminato dopo aver creato/verificato il playbook, mentre il record della
proposta resta disponibile.

Il Planner e gli altri agenti del progetto si vedono così:

```bash
yano fleet --project-root "$PWD"
yano fleet --project-root "$PWD" --json
```

## Riallineare un progetto senza perdere il lavoro

```bash
yano repair --project-root "$PWD" --dry-run
yano repair --project-root "$PWD" --yes --init-db
```

`repair` salva prima uno snapshot. Se trova una pane retained non riutilizzabile
crea una pane nuova, avvia l'agente con `herdr agent start` e, solo dopo la
readiness, chiude le copie stale di Planner/Architect/Watcher. `--force` va
aggiunto solo se un processo non termina in modo graceful.

## Inizializzare il DB per Gantt

```bash
yano repair --project-root "$PWD" --yes --init-db
yano gantt --project-root "$PWD" --project "$(basename "$PWD")"
```

Senza `--port`, Gantt sceglie automaticamente una porta libera nel range
`10000-19999`. È quindi possibile eseguire contemporaneamente una dashboard
per ogni progetto. Se vuoi fissare manualmente la porta, usa per esempio
`--port 10055` (sempre nel range `10000-19999`).

Per mantenere il link nel catalogo globale e recuperarlo in seguito:

```bash
yano gantt --project-root "$PWD" --persistent --open
yano gantt --project-root "$PWD" --link
yano gantt --links
```

`--persistent` non crea un processo nascosto: il server resta aggiornato finché
la relativa istanza è in esecuzione. Salva però il link nel data-root globale;
`--link` mostra quello del progetto corrente e `--links` mostra tutti i Gantt
registrati, indicando `attivo` o `fermo`. Se il processo è stato chiuso, il
link resta recuperabile ma va riavviato con `--persistent`.

La registry è condivisa da tutte le directory e si trova sotto
`<YANO_DATA_DIR>/gantt/instances.json`; `yano gantt --links --json` eseguito da
una directory qualunque è quindi sufficiente per l'inventario globale. Per
aggiornare questa guida quando cambia il comando, segui
[`docs/documentation-sync.md`](../documentation-sync.md).

Il DB può essere presente ma vuoto: Gantt mostrerà `runs=[]` finché il Planner
non chiama `orchestrator_init` e `run_create`. Questo è diverso da un DB
mancante, per il quale Gantt suggerisce `repair --yes --init-db`.
