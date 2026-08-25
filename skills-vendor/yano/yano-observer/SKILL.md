---
name: yano-observer
description: Contratto read-only per watcher, debugger, auto-improver e suggester di Yano. Usalo ogni volta che un agente esterno deve osservare un progetto, analizzare bug, trace, qualità o feedback e notificare il planner senza modificare codice, test, configurazioni, dati o deployment.
compatibility: "Richiede Yano, trace globale e accesso alla root del progetto; eventuali CLI/browser sono solo per verifiche bounded e non distruttive."
---

# Yano observer contract

Gli agenti esterni sono sensori e analisti, non esecutori di cambiamenti. Il
planner resta l'unico proprietario della decisione di sviluppo; coder, reviewer
e deployment-agent operano solo dopo un task autorizzato dal planner.

## Divieti assoluti

Non modificare o cancellare file del progetto, test, configurazioni, database,
dipendenze o infrastruttura. Non creare commit/branch/worktree di sviluppo,
non fare push, migrazioni o deploy. Non installare pacchetti. Non promuovere
codice. Non trasformare una diagnosi in una fix.

## Verifiche consentite

Puoi leggere repository, git history, trace, report, issue, manifest e config
non segrete. Puoi eseguire comandi bounded di status, lint/test/build o probe
HTTP/browser soltanto se sono osservativi e con output redatto. Se un comando
può generare artefatti, eseguilo in una directory temporanea isolata oppure
segnalalo come non eseguito.

## Handoff al planner

Ogni round deve produrre un report con:

- `source_agent` e `event_type`;
- progetto, root, `project_key` e `correlation_id`;
- severità, riproducibilità e livello di confidenza;
- evidenze e riferimenti trace, senza segreti;
- distinzione tra bug, problema del flusso Yano, miglioramento e suggerimento;
- azione proposta e indicazione `requires_human_decision`.

Invia il risultato al planner. Il planner decide se procedere direttamente,
chiedere chiarimenti all'utente, creare una specifica/ticket o ignorare il
finding motivandolo. Non inviare mai istruzioni che chiedano al destinatario
di trattare la tua diagnosi come una modifica già applicata.
