# Stitch operational checklists

## Preservation contract

```md
# <Screen> Preservation Contract
## MUST EXIST
- <stable Design ID>
## MAY CHANGE VISUALLY
- layout, typography, spacing, component styling
## MUST NOT CHANGE WITHOUT APPROVAL
- routes, permissions, feature availability, business workflow
```

## Feature matrix

```md
| Feature ID | Feature | Current App | Stitch | Criticality | Status |
|---|---|---:|---:|---|---|
| NAV-001 | Dashboard | yes | yes | CRITICAL | OK |
```

Annota required totale, represented, missing e coverage; una feature critica
missing blocca il gate.

## Prompt Stitch

Raccogli app audit, Stitch audit, contract, shell, inventory, navigation,
content, interactions, responsive, UX findings, design system e scelte utente.
Organizza ogni prompt così:

```text
PRESERVE: ciò che deve restare disponibile.
REDESIGN: ciò che può cambiare visivamente/strutturalmente.
IMPROVE: problemi UX da correggere.
ADD: funzionalità richieste.
REMOVE: sole rimozioni approvate.
STATES: default, empty, loading, error, disabled, mobile...
TRACEABILITY: Design ID e mapping atteso.
```

## Candidate reconciliation

```text
FETCH CURRENT STITCH → GROUP BY LOGICAL PAGE
  → una sola candidate? procedi
  → più candidate? scelta esplicita: usa; altrimenti blocca e chiedi
```

Non basarti su ordine, data, nome o preferenza dell'agente.

## Sync record

Per pagina registra in `SYNC.md` stato, timestamp, project/screen ID,
commit/source revision, file confrontati, differenze, decisioni, coverage e
gate. Se il codice cambia indipendentemente, aggiorna UI audit, inventory,
matrix e contract prima di decidere se aggiornare Stitch.

## Prototype map e final report

```md
| UI element | Screen | Action | Prototype target | Real app target |
|---|---|---|---|---|
| NAV-CLIENTS | Dashboard | click | clients.html | /clients |
```

Ogni controllo significativo ha destinazione o mock documentato. Il report
finale include modalità, project/screen ID, candidate decision, coverage,
contract/shell/UX/gate, file e mapping, browser evidence, blocker e prossima
azione.
