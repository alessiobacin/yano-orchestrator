# AGENTS.md

Pi carica questo file automaticamente all'avvio di ogni istanza (planner,
coder, reviewer, specialisti) in questo repo — vedi `README.md` per il funzionamento
generale.

## Agent skills

Scritto da `/skill:setup-matt-pocock-skills` eseguita in una sessione planner per configurare le
skill vendorizzate `wayfinder`/`to-spec`/`to-ticket` (vedi `skills-vendor/mattpocock/`).

### Issue tracker

Local markdown files under `.scratch/<feature-slug>/` — nessuna dipendenza
da GitHub/GitLab Issues. See `docs/notes/agents/issue-tracker.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` alla radice del repo, creati
lazily quando servono davvero (nessuno dei due esiste ancora oggi). See
`docs/notes/agents/domain.md`.

### Documentation synchronization

Ogni modifica a CLI, codice, agenti, playbook, capability, persistenza o flussi
deve aggiornare le superfici documentali applicabili: README, quick start,
quick guide, cheat-sheet, reference/skill `yano-cli` e diagrammi. La matrice e
la procedura sono in [`docs/guides/documentation-sync.md`](docs/guides/documentation-sync.md).
Prima del commit eseguire `npm run check:docs` e `npm test`; per imporre anche
un diff documentale insieme alle modifiche locali al codice usare
`YANO_DOCS_ENFORCE_DIFF=1 npm run check:docs`.
