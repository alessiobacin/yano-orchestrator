---
type: debugger
kind: task
created_by: yano-watcher
status: open
severity: critical
category: isolation
signal: workspace_scope_mismatch
fingerprint: ef1cadbe5809dc6c641186be7a4e2e30e14d4b878e2752ba2f7a7768a2cd581a
detected_at: 2026-09-02T21:42:50.224Z
source_project: yano-orchestrator
source_project_root: /Users/alessiobacin/Development/testCode/yano-orchestrator
source_project_key: workspace-d3dda6a0cb4d
run_id: unknown
round: unknown
task: unknown
instance: scheduler-service
evidence_record_id: unknown
---

# Yano ha osservato una discordanza tra progetto, workspace o presenza degli agenti.

Type: debugger
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: ef1cadbe5809dc6c641186be7a4e2e30e14d4b878e2752ba2f7a7768a2cd581a

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `workspace_scope_mismatch`
- Categoria: `isolation`
- Progetto osservato: `yano-orchestrator` (/Users/alessiobacin/Development/testCode/yano-orchestrator)
- Timestamp del record: `2026-09-02T21:40:23.693Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-02T21:40:23.693Z",
  "seq": 4,
  "instance": "scheduler-service",
  "role": "scheduler",
  "project": "yano-scheduler",
  "project_key": "workspace-d3dda6a0cb4d",
  "trace_mode": "full",
  "type": "presence_ignored_scope_mismatch",
  "topic": "pi/workspace-d3dda6a0cb4d/agents/scheduler-service/status",
  "card_instance": "scheduler-service",
  "card_project": "yano-orchestrator",
  "card_project_key": "workspace-d3dda6a0cb4d",
  "expected_project": "yano-scheduler"
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
