---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: c17ab0a40870c5d0adec9d4502c36e6fef56c85b5f10bcd7037a8332a636d0de
detected_at: 2026-08-27T07:10:44.524Z
source_project: sales-companion
source_project_root: /Users/alessiobacin/Development/testCode/sales-companion
source_project_key: workspace-11e5a75d06e3
run_id: unknown
round: unknown
task: unknown
instance: watcher-sales-companion
evidence_record_id: unknown
---

# Un tool interno di Yano è terminato con errore.

Type: human
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: c17ab0a40870c5d0adec9d4502c36e6fef56c85b5f10bcd7037a8332a636d0de

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `sales-companion` (/Users/alessiobacin/Development/testCode/sales-companion)
- Timestamp del record: `2026-08-27T07:10:32.721Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-08-27T07:10:32.721Z",
  "seq": 30,
  "instance": "watcher-sales-companion",
  "role": "watcher",
  "project": "sales-companion",
  "project_key": "workspace-11e5a75d06e3",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_fcce8e59246c453c990cc4bd",
  "tool": "run_status",
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
