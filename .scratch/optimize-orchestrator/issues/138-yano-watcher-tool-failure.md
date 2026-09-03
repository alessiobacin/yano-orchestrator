---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: 5c85abdce0cd4b65e1ca05bd5baf336e0680bf5b01aa01bf3b6e00eafc832caf
detected_at: 2026-09-03T12:57:51.485Z
last_seen_at: 2026-09-03T14:42:46.376Z
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
Fingerprint: 5c85abdce0cd4b65e1ca05bd5baf336e0680bf5b01aa01bf3b6e00eafc832caf

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Il finding viene inoltrato al planner di Yano per la manutenzione.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `newmiodoc` (/Users/alessiobacin/Development/Code/newMioDOC)
- Timestamp del record: `2026-09-03T12:57:19.258Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-03T12:57:19.258Z",
  "seq": 293,
  "instance": "planner-01",
  "role": "planner",
  "project": "newmiodoc",
  "project_key": "workspace-57a4005feedc",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_01a0675829f572409fba9af1",
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
