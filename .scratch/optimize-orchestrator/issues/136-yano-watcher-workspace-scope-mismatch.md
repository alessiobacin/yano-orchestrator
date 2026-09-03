---
type: human
kind: task
created_by: yano-watcher
status: open
severity: critical
category: isolation
signal: workspace_scope_mismatch
fingerprint: cd6379882bbba96548d7f428ab74050d04ddc5365b7069683fa71a9713311709
detected_at: 2026-09-03T11:51:39.704Z
last_seen_at: 2026-09-03T14:32:15.799Z
source_project: newmiodoc
source_project_root: /Users/alessiobacin/Development/Code/newMioDOC
source_project_key: workspace-57a4005feedc
run_id: unknown
round: unknown
task: unknown
instance: planner-vision-e2e-01
evidence_record_id: unknown
---

# Yano ha osservato una discordanza tra progetto, workspace o presenza degli agenti.

Type: human
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: cd6379882bbba96548d7f428ab74050d04ddc5365b7069683fa71a9713311709

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Il finding viene inoltrato al planner di Yano per la manutenzione.

## Evidenza osservabile

- Segnale: `workspace_scope_mismatch`
- Categoria: `isolation`
- Progetto osservato: `newmiodoc` (/Users/alessiobacin/Development/Code/newMioDOC)
- Timestamp del record: `2026-09-03T11:50:00.957Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-03T11:50:00.957Z",
  "seq": 10,
  "instance": "planner-vision-e2e-01",
  "role": "planner",
  "project": "newMioDOC-vision-e2e",
  "project_key": "workspace-57a4005feedc",
  "trace_mode": "full",
  "type": "presence_ignored_scope_mismatch",
  "topic": "pi/workspace-57a4005feedc/agents/planner-01/status",
  "card_instance": "planner-01",
  "card_project": "newmiodoc",
  "card_project_key": "workspace-57a4005feedc",
  "expected_project": "newMioDOC-vision-e2e"
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
