---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: e9d39f59d2247b132d8d49de3c3682f33eeff3b77d569313a3827ae6fe45c661
detected_at: 2026-09-03T12:57:51.021Z
last_seen_at: 2026-09-03T14:42:46.370Z
source_project: newmiodoc
source_project_root: /Users/alessiobacin/Development/Code/newMioDOC
source_project_key: workspace-57a4005feedc
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
Fingerprint: e9d39f59d2247b132d8d49de3c3682f33eeff3b77d569313a3827ae6fe45c661

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Il finding viene inoltrato al planner di Yano per la manutenzione.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `newmiodoc` (/Users/alessiobacin/Development/Code/newMioDOC)
- Timestamp del record: `2026-09-03T12:56:56.162Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-03T12:56:56.162Z",
  "seq": 270,
  "instance": "planner-01",
  "role": "planner",
  "project": "newmiodoc",
  "project_key": "workspace-57a4005feedc",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_01a06757fa0570d0b10066c9",
  "tool": "ticket_complete",
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
