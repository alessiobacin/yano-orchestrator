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

Esempio di bug:

```json
{"project_id":"workspace-example","message":"Il pulsante non risponde","resolution":"automatic"}
```

Una suggestion non viene mai applicata automaticamente: usa sempre la
risoluzione `user_confirmation` e resta nel database fino a `processed` o alla
cancellazione.

```bash
yano feedback serve
yano bug create --project-id workspace-example --message "..." --resolution user_confirmation
yano suggestion create --project-id workspace-example --message "..."
yano bug list --type bug
yano suggestion list --type suggestion
yano feedback update --type suggestion --id SUG-... --status processed
yano feedback delete --type bug --id BUG-...
```
