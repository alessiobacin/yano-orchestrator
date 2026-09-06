# Bugs e suggerimenti via planner

Yano espone un unico servizio HTTP loopback sulla porta `20002`. I record sono
persistiti in SQLite e inoltrati al planner del progetto indicato da
`project_id`; il planner decide se delegare a coder, frontend developer,
reviewer o ad altri agenti.

## API

```text
GET    /bugs              POST   /bugs
GET    /bugs/:id          PUT/PATCH /bugs/:id       DELETE /bugs/:id
GET    /suggestions       POST   /suggestions
GET    /suggestions/:id   PUT/PATCH /suggestions/:id DELETE /suggestions/:id
```

Esempio di bug senza allegati:

```json
{"project_id":"workspace-example","message":"Il pulsante non risponde","resolution":"automatic"}
```

Gli screenshot sono opzionali. In JSON si possono inviare come file locali,
URL HTTPS o dati immagine base64:

```json
{
  "project_id":"workspace-example",
  "message":"Il pulsante non risponde",
  "resolution":"user_confirmation",
  "screenshots":[
    {"path":"/tmp/bug-settings.png"},
    {"url":"https://example.test/evidence/bug.png"}
  ]
}
```

Per un upload reale usare `multipart/form-data`, con i campi
`project_id`, `message`, `resolution` e uno o più campi file chiamati
`screenshot`/`screenshots`. I file locali vengono copiati nel registro globale
degli allegati di Yano e il record conserva i riferimenti; gli URL remoti HTTPS
vengono conservati senza essere scaricati automaticamente.

Una suggestion non viene mai applicata automaticamente: usa sempre la
risoluzione `user_confirmation` e resta nel database fino a `processed` o alla
cancellazione.

I bug vengono processati dal planner in ordine FIFO per progetto. Un planner
inattivo viene risvegliato subito; un planner occupato li prende al termine del
run corrente. Il planner può avviare coder aggiuntivi quando serve. Ogni bug
usa un worktree, report e commit separati. Un backend puro e deterministico può
essere finalizzato automaticamente dopo test e review verdi; un bug frontend o
misto richiede sempre conferma dell'utente. In quel caso il commit resta nel
worktree e non viene fatto merge/push prima della verifica, eventualmente con
Agentation.

Per un bug backend puro e deterministico, dopo test, regressioni e review verdi,
il planner può finalizzare senza conferma usando `automatic_backend: true` e
il relativo `feedback_id` su `worktree_finalize`. Questa eccezione non vale per
frontend, task misti, deploy rischiosi o modifiche distruttive.

```bash
yano feedback serve
yano bug create --project-id workspace-example --message "..." --resolution user_confirmation
yano suggestion create --project-id workspace-example --message "..."
yano bug list --type bug
yano suggestion list --type suggestion
yano feedback update --type suggestion --id SUG-... --status processed
yano feedback delete --type bug --id BUG-...
yano bug create --project-id workspace-example --message "Toast rosso" --screenshot /tmp/bug-settings.png
yano bug create --project-id workspace-example --message "Errore remoto" --screenshot https://example.test/bug.png
```

## Bug segnalato nella chat del planner

Quando il bug viene scritto direttamente nella chat, il planner deve chiamare
prima `feedback_create`. Il tool salva il bug nel database globale, conserva gli
eventuali screenshot allegati e solo dopo consente il normale triage/delega.
Il flusso chat e il flusso REST condividono quindi lo stesso ciclo di vita e
gli stessi record CRUD.
