# Architecture Decision Records — Yano

Registro delle decisioni architetturali di Yano, in convenzione
`0001-<slug>.md` (vedi `docs/notes/agents/domain.md`). Ogni ADR riporta stato,
contesto con evidenze dal repository, decisione e conseguenze.

## Indice

- [0001 — Worktree Git isolato per task](./0001-worktree-isolation-per-task.md)
- [0002 — Namespace MQTT project-scoped con presence per ruolo/istanza](./0002-mqtt-role-presence.md)
- [0003 — Prompt dei ruoli letti sempre dall'installazione globale](./0003-prompts-dal-pacchetto-globale.md)

Se un nuovo documento contraddice un ADR esistente, il conflitto va
segnalato esplicitamente (`docs/notes/agents/domain.md`): "Contraddice ADR-000X —
ma vale la pena riaprirla perché…".