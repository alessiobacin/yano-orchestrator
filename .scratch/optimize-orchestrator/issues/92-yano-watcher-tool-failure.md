---
type: human
kind: task
created_by: yano-watcher
status: resolved
severity: high
category: internal_tool
signal: tool_failure
fingerprint: c626bbc7a965607b70069be7aa7379c8d380bdcb3ee0667d4a53c7ff5636a04a
detected_at: 2026-08-31T22:39:42.440Z
source_project: manual-e2e-11-refactor-live
source_project_root: /Users/alessiobacin/Development/testCode/yano-orchestrator/temp/manual-e2e-11-refactor-live
source_project_key: workspace-d66b39674455
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
Fingerprint: c626bbc7a965607b70069be7aa7379c8d380bdcb3ee0667d4a53c7ff5636a04a

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `manual-e2e-11-refactor-live` (/Users/alessiobacin/Development/testCode/yano-orchestrator/temp/manual-e2e-11-refactor-live)
- Timestamp del record: `2026-08-31T22:39:41.200Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-08-31T22:39:41.200Z",
  "seq": 59,
  "instance": "planner-01",
  "role": "planner",
  "project": "manual-e2e-11-refactor-live",
  "project_key": "workspace-d66b39674455",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_295a5127918a4d7c92dce1a7",
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

## Risoluzione — Yano planner/recovery (2026-09-01)

La chiamata fallita era una chiusura prematura: dopo il repair il planner ha
invocato `ticket_complete` sul ticket reviewer ancora `pending`, prima del
nuovo `ticket_claim` del reviewer rilanciato. Il runtime ha correttamente
rifiutato l'operazione (`only a running ticket can be completed`); il planner
ha poi rilanciato il reviewer, ottenuto il claim e completato correttamente la
run.

Correzioni applicate nel repository Yano:

- `prompts/planner.md`: il planner deve verificare `running` e
  `assigned_instance` prima di ogni `ticket_complete`; non può chiudere ticket
  pending/ready/failed o non reclamati e deve rilanciare il worker offline.
- `scripts/smoke-test-ticket-engine.mjs`: regressione sul tentativo di chiudere
  un ticket pending.

Verifica: run `manual-e2e-11-refactor-live` completata con 3/3 ticket done,
worktree finalizzata, test finale 10/10. La scansione watcher con lookback
recente è `healthy`, con 0 finding e 0 stall.
