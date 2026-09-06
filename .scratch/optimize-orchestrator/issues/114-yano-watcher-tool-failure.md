---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: abe887b76450cfef45be3eb675c3bce42ff6ea9ff5d29a77fc4419c4445a2133
detected_at: 2026-09-02T12:08:30.710Z
last_seen_at: 2026-09-03T22:15:17.859Z
source_project: yano-orchestrator
source_project_root: /Users/alessiobacin/Development/testCode/yano-orchestrator
source_project_key: workspace-d3dda6a0cb4d
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
Fingerprint: abe887b76450cfef45be3eb675c3bce42ff6ea9ff5d29a77fc4419c4445a2133

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `yano-orchestrator` (/Users/alessiobacin/Development/testCode/yano-orchestrator)
- Timestamp del record: `2026-09-02T12:05:24.781Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-02T12:05:24.781Z",
  "seq": 63,
  "instance": "planner-01",
  "role": "planner",
  "project": "yano-orchestrator",
  "project_key": "workspace-d3dda6a0cb4d",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_01a06202687f7b91be75fa08",
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
