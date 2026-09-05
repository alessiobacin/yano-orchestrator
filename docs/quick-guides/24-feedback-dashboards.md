# Dashboard bug e suggestions

Yano non usa più agenti LLM `debugger` o `suggester`: il registro feedback è gestito da endpoint REST e dashboard deterministiche.

```bash
yano bug-dash start
yano suggest-dash start
yano bug-dash stop
yano suggest-dash stop
```

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

La card mostra soltanto titolo, utente, data/ora locale italiana e route; il
messaggio completo resta nella modal. La data usa `Europe/Rome` e formato
`GG/MM/AAAA HH:MM`. La modal consente di creare/modificare card, mantiene
sempre visibili i pulsanti `Salva` e `Annulla`, evidenzia in rosso i campi
obbligatori, mostra l'anteprima degli screenshot e accetta file multipli anche
con drag-and-drop. Gli screenshot remoti si inseriscono come URL separati e
non come JSON.

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

Stati disponibili: `received`, `pending_planner`, `queued`, `processing`,
`awaiting_user_confirmation`, `paused`, `retry`, `resolved`, `processed`,
`failed`, `cancelled`.
