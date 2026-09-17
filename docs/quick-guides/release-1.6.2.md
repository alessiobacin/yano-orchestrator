# Yano 1.6.2

La pagina Gantt rende leggibile il lavoro: progetto e percorso in testata,
progetto e descrizione per riga, filtro assignment/lavoro, periodo, stato e ricerca.
Gli identificatori tecnici restano nei dettagli.

- **Ora** mostra solo attività confermata da eventi e heartbeat, con animazione.
- La timeline conserva il passato e l'ultima evidenza dei lavori senza risposta.
- **Prossimi passi** mostra l'ordine delle dipendenze dei ticket e le fasi pianificate,
  senza inventare durate o date future.
- Modello e provider provengono dai metadati delle risposte o dall'header llmProxy;
  il routing configurato resta separato. Lo storico viene recuperato dove disponibile.
- I nuovi turni registrano una descrizione breve e l'osservazione del modello.
  Per lo storico senza prompt, una sintesi della risposta è indicata come tale.
- I turni diretti servono alla vista e non cambiano le decisioni di scheduler/watcher.

Verifiche: regressioni su identità di progetto, assegnazioni, riavvio sessione,
heartbeat, modelli, turni diretti e redazione delle credenziali; smoke HTTP reale.
Browser reale a 1440 e 500 pixel: filtro sull'UUID segnalato, ricerca, assenza di
scroll orizzontale; animazione verificata con dati simulati e ripristino dei dati reali.

Il lavoro storico `a97cace2-40eb-4221-955e-3b0b90f557d4` è un messaggio di
recupero del coordinatore inviato da yano-debugger-cli. Non esiste nel trace
osservato un modello/provider associato: rimane esplicitamente non registrato.

Suite completa prima del bump: **156 controlli passati**, incluso E2E con
**51 asserzioni in 6 scenari** sul codice reale dell'estensione.
La rilevazione capability è stata eseguita; il server CLI personalizzato resta
non confermato dal detector generico, senza assegnargli manualmente uno stato runtime.
