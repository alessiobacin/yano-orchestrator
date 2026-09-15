# API feedback per le applicazioni

Le precedenti GUI bug/suggestions sono state rimosse. `yano feedback-api start`
(alias `yano dash start`) avvia il servizio API locale, senza aprire browser.
Database, allegati, CRUD e SSE esistenti sono preservati. Le applicazioni
implementano la propria interfaccia e inviano bug/suggestions a Yano.

Vedi [contratto API, annotazioni e migrazione](yano-essential.md#feedback-api-interfaccia-nelle-applicazioni)
e la [collection Postman](../postman/yano-feedback.postman_collection.json).

Le API feedback accettano bug senza credenziali E2E; le credenziali, se
fornite, devono essere complete. La raccolta non equivale a verifica
autenticata. Gli URL di progetto isolano anche modifica e cancellazione.
