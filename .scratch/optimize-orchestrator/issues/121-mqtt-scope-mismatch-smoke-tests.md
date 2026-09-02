Type: human
Kind: task
Status: resolved

## Question

Richiesto dall'utente un nuovo controllo dei log dopo l'implementazione delle
ticket #115-120, per capire se qualche fallimento osservato fosse in realtà
"attività bloccata" (stuck) che richiedesse una ristrutturazione della logica,
invece della semplice etichetta "flakiness del sandbox" usata nelle ticket
precedenti per 4 smoke test falliti:

- `smoke-test-watchdog.mjs`
- `smoke-test-team-per-instance.mjs`
- `smoke-test-ticket-engine.mjs`
- `smoke-test-yano-watcher-e2e.mjs`

Indagine reale: misurata la latenza pub/sub grezza del broker MQTT
(`mqtt.connect` → publish → message) in questo stesso sandbox: **40ms**,
broker sano e veloce, non il collo di bottiglia. I 4 test, rilanciati in
isolamento con un broker pulito, **falliscono in modo sempre identico e
deterministico** — non è flakiness, è un bug riproducibile al 100%.

Causa reale identificata leggendo `extensions/orchestrator.ts:393`:

```ts
function topics(project: string, scope = project) {
  return {
    agentCommands: (id) => `pi/${scope}/agents/${id}/commands`,
    agentStatus: (id) => `pi/${scope}/agents/${id}/status`,
    runEvents: (runId) => `pi/${scope}/runs/${runId}/events`,
    teamEvents: (team) => `pi/${scope}/teams/${team}/events`,
    // ...
  };
}
```

e dal call site reale (`extensions/orchestrator.ts:3251`):

```ts
T = topics(project, process.env.PI_ORCH_TEST_NO_EXIT === "1" ? project : projectKey(cwd, project));
```

**Ogni** topic MQTT che l'estensione usa davvero (comandi, status, eventi di
run, eventi di team) è costruito su `scope` — che di default è
`projectKey(cwd, project)`, un `workspace-<hash-sha256-della-cwd>` — **mai** la
stringa `project` grezza, a meno che il chiamante non imposti esplicitamente
`PI_ORCH_TEST_NO_EXIT=1` (idioma già usato correttamente altrove, per esempio
in `smoke-test-watch-stalls.mjs`, che fa `delete process.env.PI_ORCH_TEST_NO_EXIT`
apposta per esercitare la derivazione reale).

I 4 test falliti sottoscrivevano/pubblicavano invece sul nome `project` grezzo
(letterale, tipo `"team-smoke"`, `"watchdog-test-xxxxx"`,
`"focusboard-trace-test"`) senza mai passare da `projectKey()` né impostare
`PI_ORCH_TEST_NO_EXIT=1`. Il publish dell'estensione arrivava quindi
regolarmente al broker, ma su un topic diverso da quello ascoltato dal test:
un mismatch di scope silenzioso, non un guasto di rete o di broker.

## Answer

Non è un problema di runtime/prodotto: nessuna correzione a
`extensions/orchestrator.ts` o a `scripts/watch-stalls.mjs` era necessaria —
la derivazione `scope = projectKey(cwd, project)` è corretta e usata in modo
coerente da **tutto** il codice di produzione (watcher, planner, ogni script
`yano-*.mjs`). Il bug era isolato ai 4 file di test, che non rispettavano la
stessa convenzione. Corretti tutti e quattro con lo stesso pattern —
importare `projectKey` da `scripts/yano-trace-storage.mjs` e sottoscrivere/
pubblicare sullo scope reale invece del nome progetto grezzo:

- `scripts/smoke-test-watchdog.mjs`: sottoscrizione a
  `pi/${project}/runs/${runId}/events` → `pi/${projectKey(cwd, project)}/runs/${runId}/events`.
- `scripts/smoke-test-ticket-engine.mjs`: stessa correzione sulla sottoscrizione
  run-events.
- `scripts/smoke-test-team-per-instance.mjs`: sottoscrizione status wildcard
  `pi/team-smoke/agents/+/status` → scope derivato.
- `scripts/smoke-test-yano-watcher-e2e.mjs`: il "planner osservatore" finto
  pubblicava/sottoscriveva su `pi/focusboard-trace-test/...` mentre il vero
  `runWatch()` (import diretto di `watch-stalls.mjs`, non passa da
  `PI_ORCH_TEST_NO_EXIT`) cerca la presenza live sullo scope derivato — quindi
  il watcher non trovava **mai** un planner "vivo" e finiva sempre sul
  fallback Telegram invece che sul routing diretto via comando MQTT, che è
  esattamente il percorso che il test doveva verificare.

Impatto della correzione, oltre a "il test passa": `smoke-test-ticket-engine.mjs`
falliva così presto nello scenario che **113 asserzioni a valle non venivano
mai eseguite** (budget di retry, contratti Playbook, resumability dopo
restart simulato...) — non erano solo "un'asserzione rossa", era una fetta
enorme di copertura reale silenziosamente non testata da chissà quanto tempo.
Stesso discorso per `smoke-test-team-per-instance.mjs` (si fermava alla prima
asserzione) e `smoke-test-yano-watcher-e2e.mjs` (l'ultimo scenario, quello sul
routing diretto al planner live, non veniva mai verificato per davvero).

Verifica: tutti e 4 rilanciati 2-3 volte di fila con un broker pulito e
isolato — sempre verdi, in modo deterministico (17, 7, 113, e l'intero
scenario `smoke-test-yano-watcher-e2e.mjs` rispettivamente). Rilanciati anche
`smoke-test-watch-stalls.mjs` e `smoke-test-yano-watcher-findings.mjs`
(pattern simile, non toccati) per verificare l'assenza di regressioni
collaterali — verdi.

Nessuna "attività bloccata" nel senso di processo appeso/deadlock: verificati
anche i processi ancora attivi in questo sandbox (nessuno zombie), l'assenza
di lock file del supervisore rimasti a metà (`withSupervisorLock` rilascia
correttamente in ogni run), e l'assenza di ticket di manutenzione spuri
scritti per errore in `.scratch/optimize-orchestrator/issues/` durante tutti
i test di questa sessione. L'unico fallimento residuo reale
(`smoke-test-yano-watcher-registry.mjs`) resta quello atteso e già
documentato nella ticket #118: Herdr non è installato in questo sandbox.

## Comments

- Aperto e risolto nella stessa sessione dell'audit di resilienza, su
  richiesta esplicita dell'utente di un nuovo controllo dei log
  (branch `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
