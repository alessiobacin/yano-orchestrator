# Architettura Yano

Documenti di architettura del pacchetto `yano-orchestrator`. La coppia
`architecture.md` + `architecture.mmd` descrive lo stato corrente del sistema
(estensione, CLI `yano`, agenti e playbook): il `.md` è la vista leggibile,
il `.mmd` è la sorgente Mermaid del flusso interno dell'estensione.

## Indice

- [`architecture.md`](./architecture.md) — documento architetturale
  human-readable: runtime boundaries, layer, flussi e sectioni per area
  (es. "Runtime boundaries", "Project repair and reconciliation"). Companion
  di `architecture.mmd`; le decisioni puntuali sono registrate in
  [`docs/adr/`](../adr/README.md).
- [`architecture.mmd`](./architecture.mmd) — sorgente Mermaid del diagramma
  complessivo dell'estensione (contesti, container e flusso logico interno),
  distinto dalle viste operative in [`docs/diagram/`](../diagram/README.md),
  che restano il riferimento per i singoli flussi di diagnosi.

## Convenzione

Ogni modifica a stato, routing, persistenza o data-root del sistema aggiorna
`architecture.md` e `architecture.mmd` (vedi la matrice in
[`docs/guides/documentation-sync.md`](../guides/documentation-sync.md)).