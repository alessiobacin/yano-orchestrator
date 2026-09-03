# Note tecniche e di lavoro

Note di lavoro, storia ingegneristica e documentazione di processo del
repository `yano-orchestrator`.

## Indice

- [`development-notes.md`](./development-notes.md) — storia ingegneristica
  completa per revisione: decisioni, incidenti reali (Revisione 24, 26, 29,
  40, 42…) e la logica di design dietro ogni parte del sistema. È la fonte
  citata da script, prompt e tool per il razionale delle scelte.
- [`agent-capabilities-research.md`](./agent-capabilities-research.md) —
  ricerca sulle capability degli agenti e decisione sul roster attivo
  (undici ruoli core, aggiornata all'audit del repository).
- [`agents/`](./agents/) — documentazione di dominio e processo per gli
  agenti di engineering:
  - [`agents/domain.md`](./agents/domain.md) — modello di dominio
    single-context e convenzioni di lettura (`CONTEXT.md`, `docs/adr/`);
  - [`agents/issue-tracker.md`](./agents/issue-tracker.md) — come si
    tracciano issue e spec in questo repo (`.scratch/<feature-slug>/`,
    nessuna dipendenza da GitHub/GitLab Issues);
  - [`agents/external-agents-roadmap.md`](./agents/external-agents-roadmap.md)
    — versione corrente e roadmap degli agenti esterni (watcher, feedback,
    auto-improver, feedback, architect).