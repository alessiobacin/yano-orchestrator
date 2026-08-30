# Quick guide: yano-suggester

Il suggester raccoglie suggerimenti senza toccare il progetto. Il planner
riceve una proposta solo dopo l'approvazione del superadmin.

Il worker usa il workspace globale `yano-suggester` e la tab
`suggester-<project-name>`.

```bash
cd /path/progetto
yano suggester init --project-root . --notify auto
yano suggester start --project-root .
yano suggester start --project-root . --once --dry-run
yano suggester submit --project-root . \
  --title "Filtro per cliente" \
  --description "Vorrei filtrare la lista per cliente" \
  --source user --priority medium
yano suggester status --project-root . --json
yano suggester reports --project-root .
```

Per mettere in coda senza avviare Herdr aggiungere `--queue-only`; per
fermare senza cancellare stato usare `pause` o `stop`, poi `resume`.

Quando il report è `awaiting_approval`, il superadmin decide:

```bash
yano suggester approve --suggestion-id SUG-... --actor superadmin --yes
# oppure
yano suggester reject --suggestion-id SUG-... --actor superadmin \
  --reason "Non coerente con il prodotto" --yes
```

## API REST (per chi non usa la shell)

`yano suggester` è un'unica istanza che gestisce molti progetti registrati
(esattamente come in CLI: ogni progetto ha un `project_key` deterministico).
Per inviare/consultare suggerimenti senza CLI, avvia l'API REST locale:

```bash
yano suggester serve --port 4179
```

Endpoint principali:

```text
GET  /projects                          elenca i progetti registrati con il loro id
POST /projects                          registra un progetto — { project_root, notify? }
GET  /projects/:id/suggestions          elenca i suggerimenti del progetto
POST /projects/:id/suggestions          invia un suggerimento — { title, description, ... }
POST /suggestions/:suggestionId/approve approva — { actor, yes: true }
POST /suggestions/:suggestionId/reject  rifiuta — { actor, reason, yes: true }
```

`yes: true` è obbligatorio in `approve`/`reject`, esattamente come `--yes` da
shell: senza, la richiesta viene rifiutata con `400`.

Per i limiti, i percorsi globali, i dettagli dell'API REST e il futuro
HTTP/FAB vedere [`docs/yano-suggester.md`](../yano-suggester.md) e la
[roadmap degli agenti esterni](../agents/external-agents-roadmap.md).
