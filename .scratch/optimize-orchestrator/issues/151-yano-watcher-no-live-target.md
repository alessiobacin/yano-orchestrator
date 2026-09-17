---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: delegation
signal: no_live_target
fingerprint: 51db2361b32059dd055c0fca3f3aa88f54f094725406d6f8e73bd860953c9d5c
family_fingerprint: d34abf04d23702f556995a04ba16caa1d1ef42db123580acb2020ab66f95231b
detected_at: 2026-09-11T06:43:43.036Z
last_seen_at: 2026-09-11T07:41:49.435Z
source_project: membox
source_project_root: /Users/alessiobacin/Development/testCode/membox
source_project_key: workspace-db285e1f0e73
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
Fingerprint: 51db2361b32059dd055c0fca3f3aa88f54f094725406d6f8e73bd860953c9d5c

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Il finding viene inoltrato al planner di Yano per la manutenzione.

## Evidenza osservabile

- Segnale: `no_live_target`
- Categoria: `delegation`
- Progetto osservato: `membox` (/Users/alessiobacin/Development/testCode/membox)
- Timestamp del record: `2026-09-11T06:42:45.862Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-11T06:42:45.862Z",
  "seq": 473,
  "instance": "planner-01",
  "role": "planner",
  "project": "membox",
  "project_key": "workspace-db285e1f0e73",
  "trace_mode": "full",
  "type": "agent_send_no_live_target",
  "target": "coder-01",
  "route": "watcher",
  "fallback_target": null,
  "watcher_bootstrap": {
    "attempted": true,
    "ok": true,
    "detail": "{\n  \"project\": \"membox\",\n  \"worker_status\": \"running\",\n  \"already_running\": true,\n  \"workspace_id\": \"w1X\",\n  \"tab_id\": \"w1X:tK6\",\n  \"instance\": \"watcher-membox\"\n}"
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

## Comments
