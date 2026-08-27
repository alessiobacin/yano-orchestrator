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
yano gantt --project-root "$PWD" --project "$(basename "$PWD")" --port 8174
```

Il DB può essere presente ma vuoto: Gantt mostrerà `runs=[]` finché il Planner
non chiama `orchestrator_init` e `run_create`. Questo è diverso da un DB
mancante, per il quale Gantt suggerisce `repair --yes --init-db`.
