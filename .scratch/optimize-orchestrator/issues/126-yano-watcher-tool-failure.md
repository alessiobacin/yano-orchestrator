---
type: debugger
kind: task
created_by: yano-watcher
status: open
severity: high
category: internal_tool
signal: tool_failure
fingerprint: b65063522db620e9207e179e0803209e31032175a4548b7be33af85f820dc172
detected_at: 2026-09-02T17:02:10.230Z
source_project: llmproxy
source_project_root: /Users/alessiobacin/Development/Modules-platform-implementation/llmProxy
source_project_key: workspace-b83c072cbe03
run_id: unknown
round: unknown
task: unknown
instance: planner-01
evidence_record_id: unknown
---

# Un tool interno di Yano è terminato con errore.

Type: debugger
Kind: task
Created-by: yano-watcher
Status: open
Fingerprint: b65063522db620e9207e179e0803209e31032175a4548b7be33af85f820dc172

## Sintesi

Il watcher ha rilevato un comportamento attribuibile al flusso interno di Yano, non un semplice errore del codice del progetto osservato. Questo ticket è destinato a una successiva analisi di **yano-debugger** o di un LLM incaricato della manutenzione di Yano.

## Evidenza osservabile

- Segnale: `tool_failure`
- Categoria: `internal_tool`
- Progetto osservato: `llmproxy` (/Users/alessiobacin/Development/Modules-platform-implementation/llmProxy)
- Timestamp del record: `2026-09-02T17:00:29.405Z`
- Record di trace: `unknown`

```json
{
  "ts": "2026-09-02T17:00:29.405Z",
  "seq": 573,
  "instance": "planner-01",
  "role": "planner",
  "project": "llmproxy",
  "project_key": "workspace-b83c072cbe03",
  "trace_mode": "full",
  "type": "tool_execution_end",
  "tool_call_id": "call_4661c514adea44daa1d35d4a",
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

---

## Round 1 — debugger (`debugger-yano-orchestrator`) — 2026-09-02

Stato: **triaged** (via `yano debugger transition ... --to triaged`)

### Diagnosi

**Falso positivo del classificatore del watcher.** L'`ok:false` segnalato
(seq 573, `tool_execution_end`, tool `agent_send`) è il **rifiuto atteso
dell'enforcement dei path di handoff**: planner-01 ha tentato un handoff
diretto `planner → reviewer-01` per il task `fix-codex-models-metadata`,
non consentito dai path `planner → coder → reviewer → planner`
(+ varianti specialist/frontend). Il payload del rifiuto (record fratello
seq 574, `tool_execution_end_payload`):

> agent_send: refused — handoff planner → reviewer is not allowed for
> "fix-codex-models-metadata". The enforced paths are ...

Il planner si è ripreso nello stesso turno: seq 576-580 re-invia a
`coder-01` (`agent_send` → esito `ok:true`, assignment
`01M1HH1EZ40FEH8JY4MWGYQFAY`), poi `agent_await` (seq 582-583). Nessun
round perso, nessun agente orfano, nessuna perdita di isolamento, round
proseguito.

### Evidenza (riproduzione deterministica, zero side effect)

Script temporaneo `/tmp/repro-bug-0B75454A.mjs` (solo lettura del modulo
installato `yano-orchestrator` 1.5.17, nessuna scrittura):

- Input: record identico a seq 573 → `detectYanoFindings` produce
  `internal_tool / tool_failure / high` con **fingerprint
  b65063522db620e9... — uguale a quello del ticket** (match esatto).
- Il classificatore non ha accesso al payload del rifiuto: il record
  `tool_execution_end` non contiene `result`/`error`, e `textOf()` non
  legge il record `tool_execution_end_payload` (riga 87 di
  `scripts/yano-watcher-findings.mjs`).
- Controfattuale: un predicato refusal-aware sul payload fratello
  (`/refused|not allowed|enforced paths|policy/i` e `error == null`)
  riconoscerebbe il caso come rifiuto atteso e sopprimerebbe il finding.

### Causa radice

`detectYanoFindings` (riga 154-155) eleva a `internal_tool/tool_failure/`
`high` **qualsiasi** `tool_execution_end ok:false` su tool della lista
INTERNAL_TOOLS (che include `agent_send`, `plan_advance`, `ticket_claim`,
`worktree_finalize`, ...), senza distinguere un rifiuto strutturato atteso
(policy di routing, fase lockata, ticket non READY, hop limit, fixture in
arrivo, `user_confirmed` mancante in `worktree_finalize`, ecc.) da un
errore reale (eccezione). Stessa classe di falso positivo già documentata
dal planner in #89 e come problema #1 di #116; il fix `ea8cdb7` ha
aggiunto il filtro fixture e la sweep di auto-chiusura, ma **non** il
filtro rifiuti attesi qui richiesto.

### Impatto

- Impatto reale dell'evento: nessuno (recupero nello stesso turno).
- Impatto reale del difetto del watcher: rumore di manutenzione
  ricorrente (29 ticket di questa classe sui progetti reali, 28 ancora
  open) che compete con le vere falle nei ticket dei difetti Yano.

### Azione proposta (per il planner)

1. In `scripts/yano-watcher-findings.mjs`, sopprimere `tool_failure`
   quando per lo stesso `tool_call_id` esiste un record
   `tool_execution_end_payload` con `error == null` e testo/`details` di
   rifiuto (`refused`/`not allowed`/`enforced paths`/`policy`/`reason`
   strutturato), oppure quando il record porta già `refused: true` /
   `error == null`.
2. Alternativa/rinforzo a monte: far emettere ai tool orchestrator un tipo
   di record strutturato `tool_refused` (o `ok:false` con campo `reason`)
   in modo che il classificatore non debba sniffare payload testuali.
3. Valutare backfill per i ticket aperti della stessa classe (fingerprint
   con rifiuto handoff su `agent_send` — es. #89, #101-103, #105-107,
   #114-115 e ora #126).
4. Aggiungere un test di regressione in
   `scripts/smoke-test-yano-watcher-findings.mjs` con il record/caso
   qui riprodotto.

### File letti (mai modificati)

- `scripts/yano-watcher-findings.mjs` (righe 87, 100-166, 444-490+)
- `scripts/watch-stalls.mjs` (righe 1320-1340)
- Trace: `~/Library/Application Support/yano/data/traces/workspace-b83c072cbe03/events/planner-01.jsonl` (seq 566-583)
- `prompts/debugger.md`
