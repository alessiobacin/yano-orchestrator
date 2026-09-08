# Dashboard bug e suggestions

Yano non usa più agenti LLM `debugger` o `suggester`: il registro feedback è
gestito da endpoint REST e da un'unica dashboard deterministica, sempre
attiva non appena Yano è installato globalmente.

```bash
yano dash start   # normalmente non serve: parte da sola
yano dash stop
```

`yano dash` è un servizio builtin supervisionato da `yano watcher supervise`
(lo stesso cron a un minuto già installato da `npm install -g`, che oggi
tiene in vita anche llmproxy/mqtt): se il processo muore o il computer si
riavvia, riparte da solo entro circa un minuto, senza bisogno di eseguire
alcun comando. `yano dash stop` lo ferma comunque su richiesta, ma stampa un
avviso sul riavvio automatico imminente. Per disattivare l'avvio automatico
si può impostare `YANO_DASH_AUTOSTART=0` (solo per la dashboard) oppure
`YANO_DISABLE_BUILTIN_DEPENDENCY_SUPERVISION=1` (disattiva tutta la
supervisione builtin, non solo la dashboard).

La dashboard usa la porta preferita 11000, con fallback 11000-11999. Se la
11000 è occupata, Yano invia un messaggio sul canale di notifica globale
configurato (`yano config set ...`) indicando la porta effettivamente scelta
— la stessa infrastruttura già usata dal digest schedulato
(`scripts/yano-notify.mjs`).

Un'unica board mostra bug e suggestions con tab **Bug 🪲 / Suggestion 💡 /
Tutti**; in "Tutti" le colonne di stato sono condivise e ogni card mostra
un'iconcina per il tipo. Gli endpoint CRUD restano `/<project-id>/bugs` e
`/<project-id>/suggestions`, con `GET`, `POST`, `PUT`, `PATCH` e `DELETE`.
Retry e cambi stato sono auditati; ogni modifica manuale richiede una nota,
visibile poi nella cronologia del pannello di dettaglio della card.

La dashboard costruisce l'elenco progetti dal catalogo globale Yano e dal
registro watcher, deduplicando per root reale e scartando root temporanee di
test o non più esistenti. Durante la lettura elimina anche dal registro watcher
le registrazioni con root scomparse; trace e feedback storici restano intatti.
Perciò il selettore non usa i soli `project_id`
presenti nei bug e non mostra progetti storici orfani.

La card mostra, quando presente, il primo screenshot in alto, poi titolo,
severità (colore del bordo e chip: grigio `low`, teal `medium`, arancio
`high`, rosso `critical`), utente, data/ora locale italiana e route; il
messaggio completo, la galleria screenshot e la cronologia degli audit restano
nel pannello di dettaglio laterale. La data
usa `Europe/Rome` e formato `GG/MM/AAAA HH:MM`. Ogni colonna mostra il
numero di elementi e uno stato vuoto esplicito quando non ne contiene. Un
campo di ricerca filtra le card per titolo, messaggio o route senza
ricaricare la board; un indicatore in header mostra l'orario dell'ultimo
aggiornamento. Gli aggiornamenti sono quasi istantanei via Server-Sent
Events. Trascinare una card in un'altra colonna apre il pannello di
dettaglio con lo stato di destinazione già selezionato, cosicché la nota
d'audit obbligatoria resta sempre scritta dall'operatore.

Per un frontend con backend separato resta disponibile, invariato,
`yano frontend-dash` (un concetto distinto: reverse proxy di sviluppo +
Agentation, non la dashboard bug/suggestions):

```bash
yano frontend-dash start --project-path /percorso/app --project-id demo \
  --command "npm run dev" --backend-command "npm run api" --backend-port 3000
```

La dashboard non raccoglie password e non rende obbligatorio l'utente
quando la card viene creata dalla GUI. Le API REST possono comunque
richiedere credenziali E2E quando il bug arriva da un client esterno via
`yano feedback serve` (porta 20002, headless) — per i test del progetto, il
coder deve predisporre account development/test per ogni ruolo applicativo
e registrarne le credenziali nel meccanismo sicuro di Yano; mai usare o
creare account in production.

Stati comuni: `received`, `pending_planner`, `queued`, `processing`,
`awaiting_user_confirmation`, `paused`, `retry`, `cancelled`. `queued` e
`pending_planner` sono stati legacy e vengono visualizzati nella colonna
`received`, quindi non sono colonne operative della dashboard. Lo stato
terminale differisce per tipo — non sono intercambiabili, ognuno dei due tab
espone solo la propria colonna:

| Tipo | Stato terminale | Colonna esposta da |
|------|------------------|---------------------|
| bug (`BUG-...`) | `resolved` | tab "Bug" (non ha colonna `processed`) |
| suggestion (`SUG-...`) | `processed` | tab "Suggestion" (non ha colonna `resolved`) |

`failed` esiste solo per i bug. Il planner non deve mai scegliere lo stato
sbagliato per il tipo: un record chiuso con lo stato dell'altro tipo sparisce
dalla propria board (nessuna colonna corrisponde nei tab "Bug"/"Suggestion";
nel tab "Tutti" resterebbe comunque visibile ma nella colonna sbagliata). Se
il planner chiama `worktree_finalize` passando `feedback_id` (con
`user_confirmed: true`, oppure `automatic_backend: true` per un bug puro
backend), lo stato terminale corretto viene scelto e scritto automaticamente
in base al prefisso dell'id — non serve un aggiornamento manuale separato in
quel caso.

Sia i bug sia le suggestion sono una coda per progetto: quando il planner del
progetto diventa inattivo, o riceve la notifica MQTT `feedback_received`, il
codice orchestratore preleva e assegna il record persistito più prioritario:
`critical`, `high`, `medium`, `low`, poi data di creazione. I bug hanno
priorità sulle suggestion a parità di livello quando non è arrivata una
notifica specifica per l'altro tipo.

Il mount dev di Agentation usa l'endpoint deterministico
`POST /api/agentation/<project-id>` della dashboard. Ogni nuova annotation
grafica viene registrata come bug separato in `received`, con commento, pagina,
elemento e selettore; l'ID Agentation impedisce duplicati. La ricezione non
avvia direttamente il planner: resta soggetta al normale ordine di priorità e
alla supervisione del progetto.

Gli screenshot remoti vengono verificati e scaricati nella cache privata di
Yano prima della notifica al planner, quando l'URL pubblico restituisce
un'immagine valida. Il wake-up del planner trasporta quindi anche blocchi
multimodali `image`, oltre al riepilogo testuale e ai riferimenti dell'allegato.
Nel dettaglio si possono aggiungere immagini con selezione o drag-and-drop,
aprire ogni anteprima e rimuoverla singolarmente con `×`; gli stessi file si
possono trascinare direttamente su una card. URL temporaneamente
irraggiungibili vengono conservati per un nuovo tentativo; risposte
definitivamente non valide non vengono mostrate come immagini broken.
