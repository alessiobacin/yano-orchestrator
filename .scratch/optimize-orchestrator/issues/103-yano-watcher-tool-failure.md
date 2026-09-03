---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: 42465616d8f72c9d18f52c1d26493c4625637012f778c1b12093ed5159e432e6
detected_at: 2026-09-01T17:04:27.230Z
source_project: code-mem
source_project_root: /Users/alessiobacin/Desktop/code-mem
source_project_key: workspace-3958f627eeac
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
Fingerprint: 42465616d8f72c9d18f52c1d26493c4625637012f778c1b12093ed5159e432e6

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `code-mem` (/Users/alessiobacin/Desktop/code-mem)
- Timestamp del record: `2026-09-01T17:04:20.944Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-01T17:04:20.944Z",
  "seq": 1203,
  "instance": "planner-01",
  "role": "planner",
  "project": "code-mem",
  "project_key": "workspace-3958f627eeac",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_3238e12bc58242b0b99ff9d1",
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
