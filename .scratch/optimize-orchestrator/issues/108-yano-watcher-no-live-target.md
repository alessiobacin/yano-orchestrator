---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: delegation
signal: no_live_target
fingerprint: 40ace8864846a038f488c75027def63965a2fcb7fb2088b9cf712c521d1250e1
detected_at: 2026-09-02T07:44:13.017Z
source_project: yano-orchestrator
source_project_root: /Users/alessiobacin/Development/testCode/yano-orchestrator
source_project_key: workspace-d3dda6a0cb4d
run_id: unknown
round: unknown
task: unknown
instance: planner-01
evidence_record_id: unknown
---

# Yano ha tentato di inviare un lavoro ma non ha trovato un destinatario vivo.

Type: human
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: 40ace8864846a038f488c75027def63965a2fcb7fb2088b9cf712c521d1250e1

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `no_live_target`
- Categoria: `delegation`
- Progetto osservato: `yano-orchestrator` (/Users/alessiobacin/Development/testCode/yano-orchestrator)
- Timestamp del record: `2026-09-02T07:44:05.261Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-02T07:44:05.261Z",
  "seq": 340,
  "instance": "planner-01",
  "role": "planner",
  "project": "yano-orchestrator",
  "project_key": "workspace-d3dda6a0cb4d",
  "trace_mode": "full",
  "type": "agent_send_no_live_target",
  "target": "role:debugger",
  "route": "watcher",
  "fallback_target": null,
  "watcher_bootstrap": {
    "attempted": true,
    "ok": true,
    "detail": "{\n  \"project\": \"yano-orchestrator\",\n  \"worker_status\": \"running\",\n  \"workspace_id\": \"w1E\",\n  \"tab_id\": \"w1E:tC\",\n  \"pane_id\": \"w1E:pC\",\n  \"instance\": \"watcher-yano-orchestrator\",\n  \"command\": \"yano watch --project-root '/Users/alessiobacin/Development/testCode/yano-orchestrator' --interval-ms 300000 --lookback-ms 3600000 --away\",\n  \"dry_run\": false\n}"
  }
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
