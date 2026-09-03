---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: delegation
signal: no_live_target
fingerprint: 6f6f495e332cb4969713ead9847aa6abcded113bc6c776eb762c67cf8989e3ac
detected_at: 2026-09-01T11:45:05.262Z
source_project: code-mem
source_project_root: /Users/alessiobacin/Desktop/code-mem
source_project_key: workspace-3958f627eeac
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
Fingerprint: 6f6f495e332cb4969713ead9847aa6abcded113bc6c776eb762c67cf8989e3ac

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `no_live_target`
- Categoria: `delegation`
- Progetto osservato: `code-mem` (/Users/alessiobacin/Desktop/code-mem)
- Timestamp del record: `2026-09-01T11:44:50.485Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-01T11:44:50.485Z",
  "seq": 322,
  "instance": "planner-01",
  "role": "planner",
  "project": "code-mem",
  "project_key": "workspace-3958f627eeac",
  "trace_mode": "full",
  "type": "agent_send_no_live_target",
  "target": "coder-01"
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
