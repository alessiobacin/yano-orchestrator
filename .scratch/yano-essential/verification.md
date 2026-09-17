# Verifica e installazione — Yano essenziale

## Risultato

Codice aggiornato e installato nella copia globale locale. Versione di base:
`1.5.73` (build locale, nessuna release pubblicata).
Fingerprint sorgente/installazione identico:
`819fab3c6aff88a9803c74c8291b3cf0671081f443920b037360e7926d0ef6d2`.

Ponytail: default `full`, tutti i ruoli, prompt custom inclusi; opt-out
persistente globale/progetto. I processi che hanno già caricato la vecchia
estensione richiedono reload o riavvio per adottare la nuova policy.
Il servizio feedback attivo sulla porta 11000 restituisce JSON, non la GUI.

## Verifiche

- 84 file di test unitari: 1.095 test passati.
- Tutti i 145 smoke test eseguiti. `npm test` si è inizialmente fermato sul
  controllo di uscita del processo API: un processo terminato per segnale ha
  `signalCode` valorizzato e `exitCode=null`. Corretto il test e registrati i
  signal handler prima della notifica asincrona; ripetizione passata.
  La suite è stata ripresa dal punto d’arresto: 41 controlli restanti passati,
  incluso E2E. Non si dichiara una singola esecuzione npm test tutta verde.
- E2E reale dell’estensione: 51 asserzioni su 6 scenari passate.
- Ripetuti dopo gli ultimi cambi: frontend review, cron watcher, scheduler,
  notifiche/digest, API HTTP e shutdown SSE.
- `check:docs` con enforcement diff, sintassi estensione e `git diff --check` passati.
- Package verificato: skill Ponytail e licenza incluse; vecchia GUI esclusa.
- Browser: Gantt desktop e finestra stretta senza overflow; filtro completati
  e dettagli preservati al refresh. Annotatore DOM provato con invio intercettato;
  il contratto HTTP con contesto, screenshot e deduplicazione è testato separatamente.
- Snapshot Gantt condiviso per cinque secondi: richiesta servita dalla cache
  misurata a circa 1 ms; lettura completa dei trace circa 3 s su questo archivio.
  Nessuna promessa di miglioramento generale delle prestazioni LLM.
- Capability detection eseguita: frontend/backend non confermati dal detector.
  Nessuno stato runtime scritto manualmente.

## Blocco operativo rimasto

Su questo Mac `crontab -l` funziona, mentre le scritture restano bloccate
(sia stdin sia file breve, anche con terminale). Interrotti soltanto i
processi creati da questa installazione. Il cron watcher esistente è sano,
ma resta anche la voce legacy scheduler: la migrazione a una sola voce non
è stata applicata. Non è stata identificata la causa OS del blocco.
Le nuove scritture cron hanno timeout di 10 secondi per evitare futuri
installer sospesi indefinitamente. Comando di migrazione, dopo aver risolto
il blocco del sistema: `yano watcher cron install`.

## Ripristino

Archivio della precedente installazione:
`/Users/alessiobacin/Library/Application Support/yano/data/releases/20260915-183748-essential/previous/yano-orchestrator-1.5.73.tgz`.
Nella stessa directory è conservato `crontab-before.txt` con permessi privati.
La build finale è in `/Users/alessiobacin/Library/Application Support/yano/data/releases/20260915-183748-essential/candidate/yano-orchestrator-1.5.73.tgz`.

Nessun commit/push eseguito. I ticket watcher e i file utente già modificati
prima dell’intervento sono stati conservati.

## Chiusura release 1.6.0 — 2026-09-15

La successiva esecuzione `npm test` è terminata interamente con 153 controlli
passati, inclusi unitari ed E2E. Aggiunti controlli API/CLI e backup; import
reale isolato: 60 bug, zero errori. Migrazione crontab riuscita: un watcher,
zero scheduler legacy. Il precedente blocco crontab non è più presente.
Volume backup configurato non montato: retention rinviata senza perdita dati.
Dettagli pubblicabili in `docs/quick-guides/release-1.6.0.md`.
