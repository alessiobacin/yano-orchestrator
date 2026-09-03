---
type: human
kind: task
created_by: yano-watcher
status: open
severity: critical
category: isolation
signal: workspace_scope_mismatch
fingerprint: aeac42f9f9771b4f75ec73aa1a3e0d9ac9a4955f325f20c4789c3f287e9926ba
detected_at: 2026-09-02T09:04:02.668Z
source_project: watch-smoke
source_project_root: /var/folders/n1/86crx3px60355s2z86fvvxtm0000gn/T/yano-watch-stalls-iMNKa8
source_project_key: workspace-c0c407f3d55d
run_id: unknown
round: unknown
task: unknown
instance: planner-01
evidence_record_id: unknown
---

# Yano ha osservato una discordanza tra progetto, workspace o presenza degli agenti.

Type: human
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: aeac42f9f9771b4f75ec73aa1a3e0d9ac9a4955f325f20c4789c3f287e9926ba

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `workspace_scope_mismatch`
- Categoria: `isolation`
- Progetto osservato: `watch-smoke` (/var/folders/n1/86crx3px60355s2z86fvvxtm0000gn/T/yano-watch-stalls-iMNKa8)
- Timestamp del record: `2026-09-02T09:03:52.614Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-02T09:03:52.614Z",
  "seq": 4,
  "instance": "planner-01",
  "role": "planner",
  "project": "watch-smoke",
  "project_key": "workspace-c0c407f3d55d",
  "trace_mode": "events",
  "type": "presence_ignored_scope_mismatch",
  "topic": "pi/watch-smoke/agents/planner-01/status",
  "card_instance": "planner-01",
  "card_project": "watch-smoke",
  "card_project_key": "workspace-c17f1b669556",
  "expected_project": "watch-smoke"
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
