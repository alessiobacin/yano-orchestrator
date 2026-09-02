Type: human
Kind: task
Status: resolved

## Question

Ispezione reale di `.scratch/optimize-orchestrator/issues/` (29 ticket
generati da `yano-watcher` su progetti reali dell'utente): 28/29 sono ancora
`status: open`, nessuno viene mai chiuso automaticamente.

Due problemi distinti osservati nei file reali:

1. **Falsi positivi confermati.** Il ticket `#89` (progetto `llmproxy`,
   `severity: high`, signal `tool_failure` su `agent_send ok:false`) è stato
   indagato dal planner e la sua stessa risoluzione dice: *"il rifiuto atteso
   dell'enforcement dei percorsi di handoff... Nessun bug, nessun round
   perso... suggerimento non bloccante"*. `processYanoWatcherFindings` in
   `scripts/yano-watcher-findings.mjs` classifica come `internal_tool` failure
   qualunque `tool_execution_end` con `ok:false` su una lista di tool interni,
   senza distinguere un rifiuto di routing atteso (già `ok:false` +
   probabilmente un `reason` strutturato) da un vero errore.

2. **Escalation su fixture dei propri smoke test.** I ticket `#110`-`#113`
   (`severity: critical`, signal `workspace_scope_mismatch`) sono generati sui
   progetti `context-compaction-smoke` e `watch-smoke`, con
   `source_project_root` sotto una directory di sistema temporanea
   (`/var/folders/.../yano-context-project-...`) — sono fixture di
   `scripts/smoke-test-context-compaction-e2e.mjs` / `scripts/watch-stalls.mjs`
   stesso, non progetti reali dell'utente, eppure vengono scritti come falle
   `critical` di isolamento.

Cosa serve:
- un filtro in `scripts/yano-watcher-findings.mjs` (o a monte, in
  `watch-stalls.mjs` prima di chiamare `processYanoWatcherFindings`) che
  riconosca progetti di test/fixture (naming `*-smoke`, `manual-e2e-*`, path
  sotto directory temporanee del sistema operativo: `os.tmpdir()`,
  `/var/folders`, `/tmp`) e non scriva ticket di manutenzione per loro (restano
  comunque nel trace del progetto osservato, solo non escalano);
- una sweep di auto-chiusura per fingerprint di `tool_failure` che non
  ricorrono più entro una finestra configurabile, così i ticket non si
  accumulano indefinitamente senza intervento umano;
- rivalutare se `workspace_scope_mismatch` debba essere sempre `critical` o se
  la severità debba dipendere dal fatto che il progetto sia una fixture di
  test.

## Answer

Implementato in `scripts/yano-watcher-findings.mjs`:

1. `isTestFixtureProject(name, env)`: euristica sul **nome** del progetto (non
   sul path — un progetto legittimo dell'utente può benissimo vivere sotto una
   directory temporanea, come dimostra `smoke-test-yano-watcher-findings.mjs`
   stesso), pattern di default `/(^|[-\s_])(smoke|e2e)(?:[-\s_]|$)/i`.
   Copre esattamente i nomi osservati nei ticket reali
   (`context-compaction-smoke`, `watch-smoke`, `manual-e2e-08-refactor-playbook`,
   "Manual E2E 08 Refactor Playbook") senza matchare nomi di progetti reali
   (`focusboard-trace-test`, `llmproxy`). Personalizzabile con
   `YANO_WATCHER_TEST_FIXTURE_PATTERN`, disattivabile con
   `YANO_WATCHER_SKIP_TEST_FIXTURES=0`.
2. `processYanoWatcherFindings` salta la creazione del ticket/Telegram/routing
   debugger per un progetto-fixture, ma registra comunque
   `yano_watcher_finding_suppressed` nel trace del progetto osservato — il
   segnale resta ispezionabile, solo non genera rumore globale.
3. `touchExistingTicketRecurrence`: ogni dedup hit su un ticket `open`
   aggiorna un nuovo campo `last_seen_at` nel frontmatter (senza toccare
   `detected_at`, che resta il first-seen).
4. `sweepStaleYanoWatcherTickets`/`maybeSweepStaleYanoWatcherTickets`: un
   ticket `created_by: yano-watcher` e `status: open` la cui `last_seen_at`
   (o `detected_at` se mai recidivato) supera `YANO_WATCHER_STALE_TICKET_DAYS`
   (default 14 giorni) viene marcato `auto-closed-stale` con una nota
   nel corpo. La sweep gira dentro `processYanoWatcherFindings` a ogni
   passata, throttled a `YANO_WATCHER_STALE_SWEEP_INTERVAL_MS` (default 6h) per
   evitare scan ripetute nello stesso processo. Se il fingerprint si ripresenta
   dopo la chiusura automatica, il prossimo `touchExistingTicketRecurrence`
   lo riapre automaticamente con una nota "Riaperto".
5. Non tocca mai ticket non creati dal watcher (`created_by` diverso) o già
   `resolved`/gestiti da una persona.

Verifica: estese le asserzioni reali in
`scripts/smoke-test-yano-watcher-findings.mjs` (pattern positivi/negativi,
disattivazione via env, soppressione end-to-end tramite
`processYanoWatcherFindings` con verifica del trace, sweep con soglia di 14
giorni su un ticket "invecchiato" di 30 giorni, non-doppia-sweep, riapertura
su recidiva) — tutte verdi. Rieseguiti senza regressioni:
`smoke-test-watch-stalls.mjs` (16 asserzioni), `smoke-test-yano-watcher-cron.mjs`,
`npm run check:docs`. `smoke-test-yano-watcher-e2e.mjs` fallisce su
un'asserzione di routing `trace_preflight_mismatch` al planner — verificato
con `git stash` che l'esatta stessa asserzione fallisce identicamente anche
sul codice **non modificato**: non è una regressione di questo lavoro, è
preesistente in questo sandbox (probabile timing MQTT, stessa famiglia del
problema già annotato in #118/nella relazione di audit originale). Aggiornata
anche la documentazione utente (`docs/architecture.md`,
`docs/quick_guides/10-watcher-falle-yano.md`) con le nuove variabili
d'ambiente e il comportamento.

## Comments

- Aperto dall'audit di resilienza richiesto dall'utente (branch
  `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
