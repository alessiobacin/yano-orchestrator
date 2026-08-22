# AGENTS.md

Pi carica questo file automaticamente all'avvio di ogni istanza (planner,
coder, reviewer, specialisti) in questo repo — vedi `README.md` per il funzionamento
generale.

## Agent skills

Scritto da `/skill:setup-matt-pocock-skills` eseguita in una sessione planner per configurare le
skill vendorizzate `wayfinder`/`to-spec`/`to-ticket` (vedi `skills-vendor/mattpocock/`).

### Issue tracker

Local markdown files under `.scratch/<feature-slug>/` — nessuna dipendenza
da GitHub/GitLab Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` alla radice del repo, creati
lazily quando servono davvero (nessuno dei due esiste ancora oggi). See
`docs/agents/domain.md`.
