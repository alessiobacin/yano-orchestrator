# Yano: guide di sviluppo

Questa cartella raccoglie guide operative per chi sviluppa Yano stesso
(estensione, CLI `yano`, agenti e playbook), ricavate dall'implementazione
reale del repository. Per le procedure d'uso di Yano da parte dell'utente
vedi invece [`docs/quick_guides/`](../quick_guides/README.md); per riferimenti
rapidi ai comandi vedi [`docs/cheat-sheet/`](../cheat-sheet/README.md).

## Indice

- [01 — Sviluppare un nuovo comando Yano end-to-end](./01-sviluppare-un-comando-yano-end-to-end.md)
  Flusso completo: dispatching in `bin/yano.mjs`, delegazione a `scripts/`,
  matrice documentale obbligatoria, smoke test e checklist di chiusura.

Le decisioni architetturali di Yano sono registrate in
[`docs/adr/`](../adr/README.md); la storia ingegneristica dettagliata per
revisione sta in [`docs/development-notes.md`](../development-notes.md).