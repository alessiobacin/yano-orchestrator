---
type: human
kind: task
created_by: yano-watcher
status: open
severity: critical
category: isolation
signal: workspace_scope_mismatch
fingerprint: ef1cadbe5809dc6c641186be7a4e2e30e14d4b878e2752ba2f7a7768a2cd581a
detected_at: 2026-09-02T21:42:50.217Z
last_seen_at: 2026-09-03T08:02:23.308Z
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

Type: human
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

## Diagnosi yano-debugger (BUG-20260902-317715D8)

Status: reproduced — causa radice identificata. Il debugger non corregge: il
fix passa dal normale flusso planner → coder (ticket di manutenzione Yano).

### Sintesi della causa

`yano-scheduler.mjs` lancia `scheduler-service` con il flag esplicito
`--project-scope yano-system` (namespace MQTT isolato riservato ai servizi di
sistema). Il flag è registrato nell'estensione
(`pi.registerFlag("project-scope", ...)`, `extensions/orchestrator.ts:2625`) e
usato in `extensions/orchestrator.ts:3374`
(`T = topics(project, flags.projectScope || projectKey(cwd, project))`), ma
`readCliFlags()` (linee 569-585) NON legge mai `project-scope`: manca sia
dall'interfaccia `CliFlags` sia dall'oggetto restituito. Quindi
`flags.projectScope` è sempre `undefined` e lo scope effettivo degenera in
`projectKey(cwd, project)`.

Per `scheduler-service` la cwd del pane Herdr è
`/Users/alessiobacin/Development/testCode/yano-orchestrator` (evidenza: `herdr api
snapshot`) → `projectKey()` = `workspace-d3dda6a0cb4d` = ESATTAMENTE la key del
progetto osservato. Il scheduler sottoscrive e pubblica quindi sullo stesso
albero MQTT del progetto (`pi/workspace-d3dda6a0cb4d/agents/...`) invece che
su `pi/yano-system/agents/...`.

Conseguenza: ogni heartbeat produce `presence_ignored_scope_mismatch` in
entrambe le direzioni — il scheduler scarta le card del progetto
(`card.project: yano-orchestrator` ≠ `expected_project: yano-scheduler`) e
ogni agente del progetto scarta la card del scheduler
(`card.project: yano-scheduler` ≠ `expected_project: yano-orchestrator`). La
card retained del scheduler risulta "live" nel fleet del progetto (isolamento
rotto); il guard in-depth (`onPresenceMessage`) impedisce l'ingresso in roster,
ma il rumore è continuo e il workspace del progetto è contaminato da un
agente di sistema.

### Evidenza osservabile

- Trace `scheduler-service` (project `yano-scheduler`): `session_start` alle
  `2026-09-02T21:40:23.609Z` con `project_scope_override: true`,
  `default_project: yano-orchestrator`, `project_key: workspace-d3dda6a0cb4d`;
  poi decine di `presence_ignored_scope_mismatch` (seq 4+).
- Trace `coder-01` (project `yano-orchestrator`): `presence_ignored_scope_mismatch`
  alle `2026-09-02T21:44:53.728Z` ecc. con
  `topic: pi/workspace-d3dda6a0cb4d/agents/scheduler-service/status`,
  `card_project: yano-scheduler`, `expected_project: yano-orchestrator`.
- `herdr api snapshot`: pane `scheduler-service` con `cwd =
  /Users/alessiobacin/Development/testCode/yano-orchestrator`.
- `npm ls -g yano-orchestrator`: installazione globale reale (nessun symlink),
  quindi la cwd del pane — non un link — determina la key.

### Riproduzione deterministica

Script: `/tmp/repro-workspace-scope-mismatch.mjs` (eseguito, tutti i check PASS,
exit 0; nessun messaggio MQTT reale inviato):

1. `readCliFlags()` non contiene `getFlag("project-scope")` → `flags.projectScope`
   è sempre `undefined` (bug confermato sul sorgente reale).
2. `pi.registerFlag("project-scope")` esiste → flag pubblicizzato ma morto.
3. `projectKey(cwd, "yano-scheduler") === "workspace-d3dda6a0cb4d"` (key osservata).
4. Con `flags.projectScope === undefined` lo scope effettivo = `workspace-d3dda6a0cb4d`
   e la wildcard di presenza = `pi/workspace-d3dda6a0cb4d/agents/+/status` (topic
   osservati nei trace).
5. Il guard `onPresenceMessage` rifiuta le card in entrambe le direzioni
   (esattamente i payload osservati).

### Fix proposto (da eseguire nel flusso planner → coder)

- Aggiungere `projectScope` a `interface CliFlags` e leggerlo in
  `readCliFlags()` con `pi.getFlag("project-scope")`.
- Aggiungere un test di regressione (smoke) che componga `readCliFlags` con
  `--project-scope yano-system` e verifichi che lo scope MQTT sia
  `pi/yano-system/...` e non `projectKey(cwd)`.
- Verificare `npm run check-syntax` e i test esistenti dopo la modifica.

### Criteri di chiusura del ticket

- [ ] Fix merged (readCliFlags legge project-scope)
- [ ] Regressione presente (scope isolato verificato)
- [ ] Nuovo round senza `presence_ignored_scope_mismatch` tra scheduler e progetto
- [ ] Notifica/deduplicazione watcher intatte
