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

La modal consente di creare/modificare card, spostarle tra le colonne e
allegare screenshot. Per un frontend con backend separato:

```bash
yano frontend-dash start --project-path /percorso/app --project-id demo \
  --command "npm run dev" --backend-command "npm run api" --backend-port 3000
```

La creazione di un bug richiede username e password E2E. Yano li cifra con
AES-256-GCM, non li restituisce nelle API e non li scrive nei trace.

Stati disponibili: `received`, `pending_planner`, `queued`, `processing`,
`awaiting_user_confirmation`, `paused`, `retry`, `resolved`, `processed`,
`failed`, `cancelled`.
