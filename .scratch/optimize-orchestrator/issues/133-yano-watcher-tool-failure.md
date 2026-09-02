---
type: debugger
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: c15576e5d489ae34988a5a90d04b35d93426a75db4ffb6179cda38e79bff4ae2
detected_at: 2026-09-02T19:51:09.418Z
source_project: yano-orchestrator
source_project_root: /Users/alessiobacin/Development/testCode/yano-orchestrator
source_project_key: workspace-d3dda6a0cb4d
run_id: unknown
round: unknown
task: unknown
instance: coder-01
evidence_record_id: unknown
---

# Un tool interno di Yano è terminato con errore.

Type: debugger
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: c15576e5d489ae34988a5a90d04b35d93426a75db4ffb6179cda38e79bff4ae2

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `yano-orchestrator` (/Users/alessiobacin/Development/testCode/yano-orchestrator)
- Timestamp del record: `2026-09-02T19:48:50.782Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-02T19:48:50.782Z",
  "seq": 108,
  "instance": "coder-01",
  "role": "coder",
  "project": "yano-orchestrator",
  "project_key": "workspace-d3dda6a0cb4d",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_3495f5f2585b4ef794f130af",
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
