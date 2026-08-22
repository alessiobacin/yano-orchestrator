Type: grilling
Status: resolved

## Question

Quali failure semantics e quale recovery bounded deve applicare il runtime per ticket fallito, agente offline, agente connesso ma non responsivo, timeout, crash e reviewer rejection? Definire retry policy, sostituzione dell'istanza, replanning, escalation umana, limiti per failure class e condizioni terminali che impediscono run attivi senza percorso di uscita.

## Answer

Il runtime distingue queste classi:

- errore transitorio: retry dello stesso worker;
- crash o offline confermato: scadenza del lease e sostituzione del worker;
- agente connesso ma non responsivo: terminazione dell'istanza, poi sostituzione;
- errore di dominio o ticket non eseguibile: replanning sul ticket esistente;
- budget esaurito: escalation e run persistito in `blocked`.

I budget massimi di retry sono configurabili per classe di failure nel Playbook. Dopo crash/offline il runtime tenta prima di riprendere lo stesso ticket con un nuovo worker, senza richiedere immediatamente una modifica del piano.

Un errore di dominio può riaprire o modificare il ticket esistente. La storia dei tentativi e delle failure resta comunque persistita negli eventi/report, così la riapertura non cancella l'evidenza del fallimento precedente.

Quando il budget è esaurito, il run entra in `blocked`, l'utente viene notificato e non vengono effettuati nuovi dispatch automatici finché non interviene una decisione esplicita di replanning o recovery.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
