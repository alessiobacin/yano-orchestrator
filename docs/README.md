# Documentazione Yano

Indice di navigazione delle otto categorie documentali canoniche sotto
`docs/`. Per il funzionamento generale del pacchetto — installazione,
quickstart, comandi CLI, configurazione — parti dal
[README di root](../README.md). La policy che rende queste categorie
obbligatorie e la matrice delle superfici da aggiornare a ogni modifica al
codice stanno in [`docs/guides/documentation-sync.md`](guides/documentation-sync.md).

Questo file è l'**unico** documento ammesso direttamente sotto `docs/`:
ogni altro file appartiene a una categoria canonica (regola del playbook
`clean-repo`).

## Categorie

### [architecture/](architecture/README.md)
Vista architetturale del pacchetto: `architecture.md` (runtime boundaries,
layer e flussi interni dell'estensione) con il compagno `architecture.mmd`,
sorgente Mermaid del diagramma complessivo. È il primo documento che ogni
agente legge per capire il sistema prima di esplorare il codice; le decisioni
puntuali stanno negli ADR.

### [guides/](guides/README.md)
Guide operative per chi sviluppa Yano stesso: come sviluppare un comando
end-to-end, il catalogo playbook e la policy di sincronizzazione documentale
(`documentation-sync.md`, la matrice che `docs-sync` applica a ogni
invocazione). Usate da coder, reviewer, specialisti e docs-sync.

### [quick-guides/](quick-guides/README.md)
Procedure brevi per chi usa Yano dalla root del progetto: installazione,
init (manuale o Herdr), trace, troubleshooting, watcher, debugger,
auto-improve, suggester, architect, job ricorrenti. Include i riferimenti
completi dei comandi (`yano-trace`, `yano-debugger`, `yano-recovery`, …) e la
quick start. È il percorso consigliato per i nuovi utenti.

### [adr/](adr/README.md)
Architecture Decision Records: decisioni architetturali con stato, contesto
supportato da evidenze dal repository e conseguenze (worktree isolation,
namespace MQTT project-scoped, prompt letti dall'installazione globale).
Usati da planner e sviluppatori per non riaprire discussioni già chiuse.

### [notes/](notes/README.md)
Note tecniche e di lavoro: `development-notes.md` (storia ingegneristica per
revisione, citata da script, prompt e tool), ricerca sulle capability degli
agenti e `agents/` (modello di dominio, issue tracker, roadmap degli agenti
esterni).

### [postman/](postman/)
Collection Postman JSON importabile
(`yano-debugger.postman_collection.json`) ed environment
(`yano-debugger.postman_environment.json`) dell'API REST del debugger
(`yano debugger serve --port 4177`). Categoria obbligatoria quando il
progetto espone un backend/API.

### [cheat-sheet/](cheat-sheet/README.md)
Riferimenti rapidi per i comandi più usati di Yano, da `00-generale` a
`31-scheduler`: per trovare il comando minimo di ogni operazione senza
rileggere le guide complete. Usata da utenti e agenti durante le verifiche.

### [diagram/](diagram/README.md)
Diagrammi Mermaid operativi dei flussi di diagnosi e onboarding (inventario
agenti, repair, architect playbook, watcher routing, trace-db-gantt, agenti
esterni, update): viste piccole complementari al diagramma complessivo in
`docs/architecture/architecture.mmd`.

## Convenzione

`docs/README.md` è l'unico file in root `docs/`. Se un documento non trova
una categoria canonica, va collocato in un nuovo folder con nome pertinente
deciso dal curator/docs-sync — mai lasciato in root. Verifica di coerenza:
`npm run check:docs` + `npm test` (vedi `docs/guides/documentation-sync.md`).