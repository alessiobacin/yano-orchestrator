---
type: human
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: affd283816685ab3aab10503d7a15f68e63c955cd292ab2f1304482409ed4231
family_fingerprint: 9f88963b154e80a5ce31061d57807f63b1195c71f0563f5a46b676bfac233da9
detected_at: 2026-09-11T06:19:13.346Z
last_seen_at: 2026-09-12T01:16:36.765Z
source_project: membox
source_project_root: /Users/alessiobacin/Development/testCode/membox
source_project_key: workspace-db285e1f0e73
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
Fingerprint: affd283816685ab3aab10503d7a15f68e63c955cd292ab2f1304482409ed4231

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Il finding viene inoltrato al planner di Yano per la manutenzione.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `membox` (/Users/alessiobacin/Development/testCode/membox)
- Timestamp del record: `2026-09-11T06:19:04.825Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-11T06:19:04.825Z",
  "seq": 214,
  "instance": "planner-01",
  "role": "planner",
  "project": "membox",
  "project_key": "workspace-db285e1f0e73",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_4c2da56730a445499dfc76d8",
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

## Occorrenze
- 2026-09-12T01:16:36.765Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:16:04.238Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:13:34.791Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:10:58.837Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:08:26.412Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:05:52.706Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:03:27.842Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T01:01:06.856Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:58:35.991Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:56:23.010Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:53:43.396Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:51:49.540Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:51:18.711Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:48:47.591Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:46:04.984Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:44:19.192Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:43:27.683Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:40:53.387Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:38:30.975Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:36:06.893Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:33:45.237Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:31:13.039Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:28:38.706Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:26:10.281Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:23:59.287Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:21:48.808Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:19:50.698Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:19:16.258Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-12T00:18:03.339Z — fingerprint `844bc3c35d1c36b5666384b28598abe8d9ff8e925c5596966eaf2a5aaa0e44e2` — cosa è cambiato: tool=ticket_claim, expected=unknown, actual=unknown
- 2026-09-11T18:17:41.425Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:15:40.124Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:13:30.458Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:11:32.093Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:09:36.833Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:07:37.531Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:05:38.020Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:03:44.287Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T18:01:44.100Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:59:47.861Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:57:46.877Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:55:51.710Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:53:52.748Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:51:54.185Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:49:53.836Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:47:58.936Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:46:01.074Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:44:15.122Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:42:28.286Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:40:46.098Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:39:00.448Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:37:23.487Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:35:36.637Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:33:47.446Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:32:06.950Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:30:22.616Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:28:27.452Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:26:33.129Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:24:35.932Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:22:32.661Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:20:56.572Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T17:20:32.081Z — fingerprint `0c31dcfd99d487efa768edd3cba6d726796748d59370a8246fa5fc8277fa7768` — cosa è cambiato: tool=ticket_complete, expected=unknown, actual=unknown
- 2026-09-11T08:57:19.106Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:55:32.507Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:53:49.489Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:52:02.403Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:50:05.716Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:48:09.499Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:46:20.530Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:44:33.173Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:42:42.199Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:40:53.302Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:39:01.537Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:37:10.827Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:35:23.003Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:33:36.615Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:32:13.482Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:31:45.941Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:29:59.337Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:28:00.976Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:26:10.260Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:24:22.717Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:22:25.346Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:20:35.667Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:18:50.364Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:17:07.638Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:15:35.216Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:15:09.371Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:13:59.002Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:12:42.116Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:12:06.924Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:10:16.191Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:08:20.715Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:06:04.398Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:03:51.681Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown
- 2026-09-11T08:01:40.759Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown

Altri finding correlati (stessa famiglia — stesso project/categoria/segnale, fingerprint esatto diverso) osservati su questo ticket invece di aprirne uno nuovo:

- 2026-09-11T07:59:27.846Z — fingerprint `219d9ee4ebe03e52b21ef72792868d0df56e62143b25674baf12420d922bbc5e` — cosa è cambiato: tool=plan_advance, expected=unknown, actual=unknown


## Comments
