# Yano essenziale

## Stato e decisioni del watcher

```bash
yano status --explain
yano status --all --explain --json
```

Lettura di Herdr, ticket, assignment e heartbeat: nessun riavvio o cleanup.
Il JSON espone build fingerprint, stato osservato, decisione `keep`/`close`,
motivo, eventuale tolleranza e ultimi eventi watcher. `missing` segnala le
istanze assegnate assenti da recuperare tramite planner; non le avvia.
Se Herdr è irraggiungibile il dato è sconosciuto, non una flotta vuota.
La decisione worker è la stessa funzione usata dal cleanup. Planner e human
restano protetti; una sessione non idle, con ticket attivo o assignment senza
risposta resta aperta. Un errore di lettura del processo non autorizza chiusure.
Dopo 30 minuti dalla conclusione del ticket può essere chiusa una sessione
idle non riutilizzata; dopo un’ora una sessione idle senza lavoro assegnato.
Le copie della stessa sessione sono riconciliate separatamente dal watcher.

## Gantt

```bash
yano gantt --persistent --open
yano gantt --link
yano gantt --links --json
```

Porte per progetto `10000-19999`, registro `<YANO_DATA_DIR>/gantt/instances.json`.
La sequenza prevista deriva dalle fasi `plan_set` e dalle dipendenze ticket;
il medesimo livello indica lavoro potenzialmente parallelo, non una durata.
Il piano può dichiarare `phases[].models` con ruolo, istanza facoltativa,
modello e provider. Questi sono PREVISTI, non prove del modello usato.

I round osservati corrispondono agli assignment: invio, ricezione e risposta
conclusiva. Il solo `agent_end` non completa un assignment perché un guard può
risvegliare il modello. Le barre aperte indicano risposta mancante: non provano
attività continua. Si possono filtrare round senza esito/completati. Gli snapshot sono condivisi
per cinque secondi fra le finestre e il browser evita richieste sovrapposte.
Il modello osservato riporta la fonte: metadata del messaggio o header
riportato dal provider; assenza di evidenza = non osservato, mai modello
configurato spacciato per effettivo. La finestra include gli ultimi 10.000 eventi
pertinenti: la storia precedente può essere incompleta.

## Feedback: API, interfaccia nelle applicazioni

```bash
yano feedback-api start --no-open
# alias compatibile: yano dash start --no-open
```

Il servizio locale mantiene porta predefinita 11000 (fallback 11000-11999),
database, allegati, CRUD e SSE. Non serve più una Kanban né apre il browser.
La root `/` restituisce il contratto JSON; `/api/projects` elenca i progetti;
`/{project_id}/bugs` e `/{project_id}/suggestions` restano gli endpoint delle
app. `/api/stream` notifica modifiche. Non eseguire questo server senza
controlli aggiuntivi su una rete pubblica: il binding resta loopback.

Una app invia JSON con `message`, `resolution`, `title` e contesto facoltativo:

```json
{"message":"Il salvataggio non termina","resolution":"user_confirmation","title":"Salvataggio","browser_context":{"route":"/settings"}}
```

Le credenziali E2E sono facoltative alla raccolta: se fornite devono essere
complete e vengono cifrate. La verifica autenticata resta bloccata finché
non sono disponibili credenziali valide. GET, modifica e cancellazione con
URL di progetto rispettano lo stesso isolamento fra progetti.

Le app mantengono presentazione e raccolta; Yano mantiene persistenza,
instradamento e audit. La rimozione della GUI non cancella feedback esistenti.

## Review frontend indipendente dal framework

```bash
yano frontend-review browser --url http://localhost:8501 --project-root /path/app
```

Restituisce un bookmarklet per caricare `/review.js` dal servizio API.
Salvalo nei preferiti e attivalo sulla pagina dell’app: selezione elemento,
commento, selettore DOM, stile, viewport e screenshot facoltativo (massimo 5 MB).
L’invio usa `/api/annotations/{project_id}`; l’endpoint Agentation rimane
compatibile. Non installa React né modifica il frontend.
CSP, HTTPS verso loopback e autorizzazioni del browser possono impedire
l’iniezione: in quei casi l’app deve includere lo script in development o
inviare direttamente il medesimo JSON. iframe cross-origin e contenuti canvas
richiedono screenshot: non si promette introspezione dei componenti universale.
I comandi Agentation `setup`/`start` restano adapter opzionali di compatibilità.

## Supervisione e schedule

Un cron globale chiama `yano watcher supervise`, che include lo scheduler.
Le installazioni cron rimuovono il vecchio marker scheduler su sistemi crontab;
`yano schedule cron` resta compatibile con il supervisore comune. Le scritture
crontab hanno un timeout di dieci secondi: un blocco del sistema operativo
non deve trattenere indefinitamente l’installazione npm.
Watcher e scheduler non richiedono sessioni Pi permanenti: non vengono più
ricreate chat senza lavoro. Le sessioni già aperte non vengono uccise dall’update.
Il planner Local PC resta persistente, con archivio CodeMem dedicato.

Gli script ricevono ambiente del job, timeout e PATH con la directory del
Node corrente: anche un processo figlio `node` funziona nel cron.
`schedule list` espone `execution_status` e `last_run_at`; il vecchio
`last_status` nel registro resta compatibile. `completed` di un job self
significa script terminato con exit 0, non risultato downstream verificato.
Un task asincrono resta accettato finché il trace `assignment_completed`
correlato al `request_id` della ricevuta non conferma la risposta.
L’assenza di tracing non viene interpretata come successo.

## Scoping e avanzamento

Un nuovo `plan_set` richiede `scoping: {status, rationale}`:
`completed` dopo wayfinder/grilling, oppure `not_needed` con motivazione
esplicita. I piani persistiti precedentemente sono leggibili e aggiornabili.
Questo registra una dichiarazione verificabile, non prova semanticamente che
le risposte raccolte siano sufficienti.
Il guard planner intercetta anche una coda `tickets_ready` senza delega
successiva, con richiamo limitato; attese esplicite dell’utente restano escluse.

## Installazione e verifica

`status --json` espone il fingerprint del codice eseguito. Confrontarlo fra
checkout e installazione permette di rilevare build diverse con stessa versione.
Le modifiche nel checkout non aggiornano automaticamente la copia globale.
Prima della distribuzione: `npm run check:docs`, `npm test` e
`yano capabilities detect --write` se cambia l’avvio di frontend/backend.

## Ponytail attivo per impostazione predefinita

Ogni ruolo Yano riceve la skill Ponytail completa a ogni turno, in modalità
`full`, anche con prompt personalizzati e nei progetti esistenti. La skill è
vendorizzata con licenza e commit fissato: non richiede download al lancio.
Le richieste esplicite dell’utente, sicurezza, accessibilità e verifiche
obbligatorie prevalgono sempre sulle scorciatoie.

```bash
yano ponytail status             # modalità effettiva e origine
yano ponytail off                # disattiva nel progetto corrente
yano ponytail on                 # riattiva full nel progetto corrente
yano ponytail lite               # alternativa: full oppure ultra
yano ponytail reset              # torna a ereditare il default globale
yano ponytail off --global       # disattiva il default globale
yano ponytail on --global        # default globale full
```

`--project-root DIR` seleziona un altro progetto. Gli override di progetto
prevalgono sul default globale; `reset --global` ripristina il default integrato
`full`. Le preferenze sono persistite atomicamente in `<YANO_DATA_DIR>/ponytail/`,
separate dal checkout; il riavvio del PC non le perde. Le impostazioni si
rileggono a ogni turno e `status --explain --json` espone la modalità per progetto.
Una richiesta in chat di fermare Ponytail va rispettata subito; il prompt
istruisce l’agente a salvare l’opt-out salvo richiesta limitata alla sessione.
L’agente resta responsabile di eseguire tale comando: non si interpretano
automaticamente frasi ambigue come modifiche globali.

La nuova policy richiede l’estensione aggiornata: i processi Pi che hanno già
caricato una versione precedente devono ricaricare l’estensione o essere
riavviati. Non viene cambiato automaticamente un processo in corso durante
la modifica del codice nel checkout.

In `YANO_TEST_MODE=1` anche le notifiche globali sono soppresse; i test dei
provider possono usare un `fetch` iniettato senza chiamare la rete reale.

## Backup temporaneamente non disponibile

Se la destinazione configurata non è scrivibile o il volume macOS non è
montato, la retention restituisce `deferred: true`, `backup_unavailable` e
conserva gli originali. Non registra un completamento giornaliero: ritenta
al passaggio successivo. Non sostituisce il backup remoto con una cancellazione.

`yano update --reload --yes` include la motivazione della ripresa e ignora
le presenze MQTT `offline` nel controllo degli agenti già avviati. Un lancio
fallito conserva il checkpoint e impedisce di dichiarare la ripresa completata.
