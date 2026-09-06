# Feedback control plane

Bug e suggestions condividono un registro globale, ma hanno dashboard separate.
Il progetto è sempre nel path (`/<project-id>/`), così più applicazioni possono
essere gestite senza assegnare una porta diversa a ciascuna.

`yano frontend-dash start --project-path <path> --project-id <id> --command
"npm run dev"` usa la porta preferita 10000, con fallback 10000-10999. Se il
progetto richiede due processi si può aggiungere `--backend-command "npm run
api" --backend-port 3000`; entrambi vengono terminati e registrati insieme. Il
proxy mantiene il prefisso del progetto e avvia il processo in development;
Agentation viene installato e montato quando l'entrypoint React è riconoscibile.

La modal della dashboard permette anche di selezionare lo stato, allegare un
file immagine e modificare i dati. Ogni operazione richiede una motivazione;
le modifiche al contenuto riportano automaticamente la card in `queued`.

Ogni creazione, modifica, retry, spostamento Kanban e cancellazione contiene
attore, timestamp, motivo e stato precedente/successivo. Il planner rimane
responsabile della classificazione e della risoluzione; la dashboard non è un
agente LLM.

La retention viene applicata una volta al giorno dal watcher. Le soglie e il
backup opzionale sono configurati globalmente con `yano config`; il dettaglio
del piano è consultabile con `yano data retain --dry-run`.
