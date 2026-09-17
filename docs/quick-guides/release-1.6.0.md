# Yano 1.6.0

## Modifiche

- Ponytail `full` predefinito per tutti i ruoli e progetti, con opt-out persistente.
- Gantt con fasi previste, dipendenze, round osservati e provenienza modello/provider.
- Rimossa la GUI feedback; API, dati, allegati e audit conservati. Annotazione DOM senza React; adapter Agentation opzionali compatibili.
- Decisioni lifecycle condivise fra watcher e `status --explain`, con protezione degli assignment ancora aperti e isolamento delle sessioni.
- Un solo cron deterministico per watcher e scheduler; PATH Node e tracciamento delle ricevute asincrone corretti.
- Gate di scoping per i nuovi piani e guard contro annunci di delega senza azione.
- Bug importabili senza credenziali E2E; credenziali parziali rifiutate. Mutazioni API isolate per progetto e tipo.
- Retention rinviata senza cancellare dati quando il backup configurato non è disponibile.
- Installazione aggiornamenti senza richiamare due volte il supervisore cron.

## Verifica prima del bump

`npm test`: 153 controlli superati, inclusi 84 file / 1.095 test unitari e
51 asserzioni E2E in 6 scenari con estensione, broker MQTT e worktree reali.
Controlli aggiuntivi: indisponibilità/ripristino backup, CLI import, isolamento
API, flusso feedback HTTP (8 verifiche). Import newMioDOC reale provato in
archivio temporaneo: 60 creati, zero errori, notifiche disabilitate.
Documentazione e capability detection eseguite; il detector non conferma
automaticamente i servizi custom del repository.

I test E2E verificano il comportamento deterministico: non certificano la
qualità di ogni risposta LLM né il completamento di tutti i job downstream.
Un volume di backup non montato resta indisponibile; i dati locali vengono
conservati fino al ripristino della destinazione configurata.
