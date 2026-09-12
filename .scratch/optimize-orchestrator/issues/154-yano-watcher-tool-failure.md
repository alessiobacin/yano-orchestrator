---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: 1c9c2475913b12292edd1448b65827cc698811a7f5ebdb9c19958c8655e5c029
family_fingerprint: c69b313cb42d3073632a8071d2726a9742a03de3f3026c4f9358212252fecdc6
detected_at: 2026-09-11T15:03:33.104Z
last_seen_at: 2026-09-11T22:10:11.829Z
source_project: sql-explorer
source_project_root: /Users/alessiobacin/Development/testCode/sql-explorer
source_project_key: workspace-8dd88dda9f0d
run_id: unknown
round: unknown
task: unknown
instance: planner-01
evidence_record_id: unknown
---

# Un tool interno di Yano è terminato con errore.

Type: human
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: 1c9c2475913b12292edd1448b65827cc698811a7f5ebdb9c19958c8655e5c029

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Il finding viene inoltrato al planner di Yano per la manutenzione.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `sql-explorer` (/Users/alessiobacin/Development/testCode/sql-explorer)
- Timestamp del record: `2026-09-11T15:02:04.453Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-11T15:02:04.453Z",
  "seq": 607,
  "instance": "planner-01",
  "role": "planner",
  "project": "sql-explorer",
  "project_key": "workspace-8dd88dda9f0d",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_00_J7k9Ygvp1kqh3W7VfsPA7938",
  "tool": "agent_send",
  "ok": false
}
```

## Impatto

Verificare se il problema ha lasciato il planner senza destinatario, ha perso l’isolamento del progetto, ha lasciato agenti/workspace in uno stato incoerente o ha impedito la prosecuzione del round.

## Cosa deve verificare l’LLM

1. Ricostruire il round usando il trace del progetto e gli eventi di Yano.
2. Individuare il punto del lifecycle in cui l’aspettativa e lo stato reale divergono.
3. Riprodurre il caso con un test deterministico senza inviare messaggi reali.
4. Correggere il codice e aggiungere una regressione che dimostri il fix.

## Criteri di chiusura

- La causa è identificata e documentata.
- Esiste un test di regressione.
- Il caso non produce più il segnale errato in un nuovo round.
- La notifica e la deduplicazione del watcher restano funzionanti.

## Occorrenze
- 2026-09-11T22:00:05.210Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:57:23.202Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:55:21.329Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:54:42.194Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:51:55.368Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:49:10.640Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:46:43.645Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:44:18.370Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:41:34.839Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:38:47.010Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:36:13.816Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:33:36.191Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:31:00.866Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:28:22.256Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:25:52.263Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:24:14.901Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:23:30.340Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:21:08.414Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:18:46.521Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:15:56.245Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:13:42.122Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:13:05.199Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:10:26.484Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:08:04.184Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:05:46.971Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:03:35.177Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:02:47.225Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T21:00:31.531Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:58:23.838Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:57:29.686Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:55:32.849Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:53:10.389Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:50:51.315Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:48:35.220Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:46:03.660Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:43:46.381Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:33:57.889Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:33:04.273Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:30:23.368Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:29:32.983Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:26:47.047Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:24:28.415Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:22:04.935Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:20:07.316Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:19:10.321Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:16:56.802Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:14:17.711Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:11:59.497Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:09:37.664Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:07:01.084Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:04:27.611Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:02:57.764Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T20:02:22.179Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:59:58.413Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:57:41.788Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:57:41.760Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:55:27.647Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:55:27.440Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:54:12.373Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:54:12.318Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:53:00.602Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:53:00.570Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:51:18.663Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:51:18.635Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:50:39.488Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:50:39.452Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:48:09.377Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:48:09.231Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:45:41.750Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:45:41.720Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:43:25.675Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:43:25.664Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:41:10.690Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:41:10.655Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:39:54.104Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:39:54.080Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:39:19.227Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:39:19.207Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:38:56.243Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:38:56.201Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:36:55.385Z — fingerprint `8e40676ee5d3f99abc41c3b1dc5f89eec9be746ec3fdcdda8c518c30aab4e845` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T19:36:55.364Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:34:50.402Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:32:41.769Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:30:11.719Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:27:58.566Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:26:34.266Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:25:59.933Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:24:04.031Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:23:34.623Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:21:40.412Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:19:25.904Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:17:17.513Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:15:04.258Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:13:18.646Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:12:51.737Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:11:47.850Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:11:18.379Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:10:38.594Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:08:21.006Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:06:08.923Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:04:19.206Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:03:48.898Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T19:01:41.929Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown

Altri finding correlati (stessa famiglia — stesso project/categoria/segnale, fingerprint esatto diverso) osservati su questo ticket invece di aprirne uno nuovo:

- 2026-09-11T18:59:20.627Z — fingerprint `dbc3a00c5b6a73703e2d6b10a9f53d051c82c0e845779572402359f0396a7af2` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown


## Comments
