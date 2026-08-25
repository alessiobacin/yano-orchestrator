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

Per i limiti, i percorsi globali e il futuro HTTP/FAB vedere
[`docs/yano-suggester.md`](../yano-suggester.md) e la
[roadmap degli agenti esterni](../agents/external-agents-roadmap.md).
