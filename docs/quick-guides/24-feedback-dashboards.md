# Dashboard bug e suggestions

Yano non usa più agenti LLM `debugger` o `suggester`: il registro feedback è gestito da endpoint REST e dashboard deterministiche.

```bash
yano bug-dash start
yano suggest-dash start
yano bug-dash stop
yano suggest-dash stop
```

L'avvio è idempotente: se la dashboard dello stesso tipo è già attiva, Yano
riutilizza l'istanza esistente. Se il comando viene eseguito da una
sottocartella del progetto (per esempio `newMioDOC/webapp`), Yano risale alla
root del progetto e stampa il relativo URL, senza creare una seconda dashboard
su una porta diversa.

Eseguiti dalla cartella di un progetto, entrambi i comandi ricavano
automaticamente il suo `project-id`, stampano l'URL completo e aprono il
browser. Per non aprire il browser si può usare `--no-open`; per un progetto
diverso si può usare `--project-id <id>`.

La dashboard bug usa la porta preferita 11000 e fallback 11000-11999; quella
delle suggestions usa 12000 e fallback 12000-12999. Gli URL sono sempre
`/<project-id>/`, quindi il progetto non viene identificato dalla porta.

Gli endpoint CRUD principali sono `/<project-id>/bugs` e
`/<project-id>/suggestions`, con `GET`, `POST`, `PUT`, `PATCH` e `DELETE`.
Retry e cambi stato sono auditati. Ogni modifica manuale richiede una nota.

La card mostra titolo, severità (colore del bordo e chip: grigio `low`, teal
`medium`, arancio `high`, rosso `critical`), utente, data/ora locale italiana
e route; il messaggio completo resta nella modal. La data usa `Europe/Rome` e
formato `GG/MM/AAAA HH:MM`. Ogni colonna mostra il numero di elementi e uno
stato vuoto esplicito quando non ne contiene. Un campo di ricerca filtra le
card per titolo, messaggio o route senza ricaricare la board; un indicatore
in header mostra l'orario dell'ultimo aggiornamento (poll ogni 5s). Trascinare
una card in un'altra colonna cambia lo stato via drag-and-drop (registra in
automatico una nota d'audit "Spostato in ... via drag & drop"); cliccarla
apre comunque la modal completa per una modifica più dettagliata. La modal
consente di creare/modificare card, mantiene sempre visibili i pulsanti
`Salva` e `Annulla`, evidenzia in rosso i campi obbligatori, mostra
l'anteprima degli screenshot e accetta file multipli anche con
drag-and-drop. Gli screenshot remoti si inseriscono come URL separati e non
come JSON.

Per un frontend con backend separato:

```bash
yano frontend-dash start --project-path /percorso/app --project-id demo \
  --command "npm run dev" --backend-command "npm run api" --backend-port 3000
```

La dashboard non raccoglie password e non rende obbligatorio l'utente. Le API
REST possono comunque richiedere credenziali E2E quando il bug arriva da un
client esterno. Per i test del progetto, il coder deve predisporre account
development/test per ogni ruolo applicativo e registrarne le credenziali nel
meccanismo sicuro di Yano; mai usare o creare account in production.

Stati comuni: `received`, `pending_planner`, `queued`, `processing`,
`awaiting_user_confirmation`, `paused`, `retry`, `cancelled`. Lo stato
terminale differisce per tipo — non sono intercambiabili, ognuna delle due
dashboard espone solo la propria colonna:

| Tipo | Stato terminale | Colonna esposta da |
|------|------------------|---------------------|
| bug (`BUG-...`) | `resolved` | `bug-dash` (non ha colonna `processed`) |
| suggestion (`SUG-...`) | `processed` | `suggest-dash` (non ha colonna `resolved`) |

`failed` esiste solo per i bug. Il planner non deve mai scegliere lo stato
sbagliato per il tipo: un record chiuso con lo stato dell'altro tipo sparisce
dalla propria board (nessuna colonna corrisponde). Se il planner chiama
`worktree_finalize` passando `feedback_id` (con `user_confirmed: true`,
oppure `automatic_backend: true` per un bug puro backend), lo stato
terminale corretto viene scelto e scritto automaticamente in base al
prefisso dell'id — non serve un aggiornamento manuale separato in quel caso.

Sia i bug sia le suggestion sono ciascuno una coda FIFO per progetto: quando
il planner del progetto diventa inattivo, o riceve la notifica MQTT
`feedback_received`, il codice orchestratore preleva e assegna
automaticamente il record persistito più vecchio (i bug hanno priorità sulle
suggestion quando entrambe le code hanno qualcosa in attesa e non è arrivata
una notifica specifica per l'altro tipo).

Gli screenshot remoti vengono verificati e scaricati nella cache privata di
Yano prima della notifica al planner, quando l'URL pubblico restituisce
un'immagine valida. Il wake-up del planner trasporta quindi anche blocchi
multimodali `image`, oltre al riepilogo testuale e ai riferimenti dell'allegato;
il modello vision può analizzare direttamente lo screenshot senza doverlo
ricostruire dal testo. URL temporaneamente irraggiungibili vengono conservati
per un nuovo tentativo; risposte definitivamente non valide non vengono
mostrate come immagini broken nella dashboard.
