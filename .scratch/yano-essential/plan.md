# Yano essenziale — perimetro confermato 2026-09-15

Metodo: ponytail full, sorgente dietrichgebert/ponytail, skills/ponytail/SKILL.md.
Non modificare i ticket watcher già sporchi nel checkout. Nessun dato runtime da cancellare.

## Operazioni e verifica

1. KEEP API feedback/storage; DELETE scripts/dash-ui e serving/browser automatico della Kanban. Conservare `dash` come alias compatibile del servizio API. Verifica HTTP CRUD, SSE, allegati e isolamento progetto.
2. KEEP Gantt/registro porte; estendere snapshot con dipendenze, piani, round e modello/provider osservati. Mostrare previsioni come ordine, senza inventare tempi. Verifica snapshot e browser.
3. MERGE decisioni cleanup in funzione comune leggibile da `status --explain --json`; includere assignment senza ticket. KEEP planner/human; non chiudere worker attivi per sola anzianità. Verifica regressioni lifecycle.
4. MERGE supervisione: watcher/scheduler deterministici, sessioni LLM su richiesta; memoria persistente per servizi LLM. Verifica bootstrap senza chat non richieste.
5. Correggere ambiente e risultati scheduler; esporre build fingerprint e guard di avanzamento/scoping. Verificare errori reali con test isolati.
6. Feedback frontend indipendente dal framework con contratto API comune; mantenere compatibilità Agentation finché gli adapter non sono sostituiti.
7. Aggiornare README, quick start, guide, cheat-sheet, reference/skill CLI e diagrammi; eseguire check:docs, npm test e capabilities detect --write.

Rischi: migrazioni identità, specialisti senza ticket, semantica accepted/completed, dati storici senza modello effettivo. Nessuna pubblicazione/installazione globale finché il risultato non è verificato.

8. Richiesta aggiuntiva confermata: Ponytail full predefinito per tutti i ruoli e progetti, con opt-out persistente globale/progetto e iniezione anche nei prompt custom.

## Esito

Codice e installazione locale completati; verifiche in `verification.md`.
Resta bloccata dal comando OS la rimozione della voce cron legacy scheduler.
