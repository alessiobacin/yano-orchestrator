# CAPITOLO AUTOMAZIONE-CONTROLLO — audit-campaign deep 16-09

- **Target (read-only):** `/Users/alessiobacin/Development/testCode/yano-orchestrator` (v1.6.2, HEAD `faed4ad529a3f938535b9100e9f378b9836916b3`)
- **Manifest:** `docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json` (letto per primo, nessuna discovery rifatta)
- **Ticket:** `01M2MB75SSTMP4MSWJTJ0GSQXD` — run `01M2MB2JEWW0DF9F9GS5SVQ4RW`
- **Playbook:** `playbooks/automation-control-audit.yaml` (id `automation-control-audit`, variant deep)
- **Mandato:** ricostruire trigger, code, deleghe agent_send/await, retry, timeout, idempotenza, state propagation, recovery (watchdog-sweep, detect-stalled-tickets, storage, invoke, launch-planner). Failure mode + opportunità script-first con postcondition. Solo artefatto audit, nessun codice mutato.

## 1. Scope

Audit statico read-only del piano automazione-controllo. Verificati via `grep`/`head`/`wc`/`git rev-parse` i file chiave; **nessuna esecuzione live** (broker MQTT, Herdr, `pi` spawn, scheduler tick, watcher loop non avviati per mandato). Ogni sezione sotto riporta evidenze con comando + exit_code + artifact + source_reference + expected/observed + doppia confidence + limiti + resource_record, come da contratto playbook (`evidence` + `dual_confidence` + `unknown_is_not_success`).

## 2. Automation map

| # | Automation surface | Trigger | Code (source_reference) | Cosa fa (observed) |
|---|---|---|---|---|
| A1 | `yano watch` standalone zero-token watcher | CLI `yano watch [--once\|--away…]` / Herdr pane / cron | `scripts/watch-stalls.mjs` (1635 righe) → `watcher/detect-stalled-tickets.mjs` + `watcher/heartbeat.mjs` | Legge `orchestrator.db`, pubblica `ticket_stalled` su MQTT `pi/<project>/runs/<run>/events`, appende marker JSONL, opzionale tripwire WhatsApp. Non giudica, non agisce sul ticket. |
| A2 | In-process watchdog sweep (planner wake) | `setInterval(watchdogSweep, WATCHDOG_INTERVAL_MS)` vivo solo mentre una sessione planner è attiva | `scripts/watcher/watchdog-sweep.ts` (386 righe) chiamato da `extensions/orchestrator.ts:2322` | Stesso core stall + escalation a livelli + heartbeat file + `yanoFindUnfinalizedRuns` + `yanoFindOrphanedTickets` + tier auto-terminate opt-in. Risveglia il planner via `pi.sendMessage`. |
| A3 | Canonical stall predicate (single source of truth) | Chiamato da A1 (adapter sqlite rows) e A2 (adapter `OrchestratorStorage`) | `scripts/watcher/detect-stalled-tickets.mjs` (46 righe, pura, DI) | `status==running AND run active AND run NOT in openHold AND elapsed>=stallMs`. Sostituisce due implementazioni divergenti (M4). |
| A4 | Anti-double-publish gate | Ogni publish `ticket_stalled` da A1 | `scripts/watcher/heartbeat.mjs` (57 righe): `writeWatchdogHeartbeat` / `readWatchdogHeartbeatAgeMs` / `shouldPublishStallEvent` | A2 scrive heartbeat per-project a ogni pass; A1 pubblica su MQTT solo se heartbeat stale/missing (`maxAge 5min`). Fail-open: unknown → publish. |
| A5 | Delega inter-agente `agent_send` / `agent_get` / `agent_await` / `agent_list` (+ publish/activity/terminate) | Tool call LLM dentro sessione `pi` con estensione orchestrator | `scripts/orchestrator-tools/agents.ts` (783 righe; 8° handler) + costanti duplicate in `extensions/orchestrator.ts:121-203` | `agent_send` ritorna subito `assignment_id` (ULID); `agent_await` blocca fino a reply o timeout; `agent_get` poll non bloccante. Hop-count anti-loop, timeout branch con wake + notifica. Dettagli §3. |
| A6 | Plan gate enforcement | `plan_set` (planner-only) → `agent_send` rifiutato se fase locked; `plan_advance` sblocca | `scripts/orchestrator-tools/plan.ts` (410 righe) su `plan-gate.ts`; vincoli fase-1 coder/refactoring-specialist/tdd-alone + ultima fase docs-sync | Impedisce structuralmente specialist-before-coder (Rev 20/21) e piani senza docs-sync (Rev 24). |
| A7 | Scheduler script-first + tick/supervise | `yano schedule tick` ogni minuto (crontab `* * * * * … watcher supervise`), `yano cron`, `yano invoke` | `scripts/yano-scheduler.mjs` (769 righe), `scripts/yano-invoke.mjs` (89 righe) | Job = script deterministico + `executeScript` bounded; `dispatchPlanner` compone argv launch; `last_run_slot` dedupe; supervisor con `dispatch_timeout` + `retry_of`. |
| A8 | Deterministic invoke bridge | `yano invoke --role planner[:scope]\|yano-local-pc --prompt …` da scheduler-script o CLI | `scripts/yano-invoke.mjs:composePlannerInvoke` | Planner path: `spawn yano.mjs start --herdr --instance scheduled-invoke-planner --role planner --project <scope> --json --print-only` (print, non exec). yano-local-pc path: delega a client MQTT-aware, mai hang (status 1 se broker assente). |
| A9 | Agent spawn point | `yano start` → `launch-planner.mjs`; planner lancia team via shell da prompt (orchestrator.ts NON compone mai argv `pi` — solo `execFile` self-report herdr + `git`) | `scripts/launch-planner.mjs` (886 righe) | Qualunque ruolo (Rev 44); `--skill` mattpocock solo planner, chrome-devtools solo reviewer/frontend-developer (Rev 49); `packageRoot` vs `cwd` split (Rev 31); `--print-only` per verifica. |
| A10 | Storage + idempotency/fencing layer | Ogni tool ticket/hold/playbook/effect/evidence | `scripts/yano-orchestrator-storage.ts` (1258 righe, `OrchestratorStorage`) + schema SQLite | `UNIQUE(slug,kind,idempotency_key)`, `UNIQUE(run,requirement,key)`, `PK(hold,op,key)`, `dedupe_key UNIQUE`, `generation` + `expected_generation`, `recovery_generation`, checksum playbook. |
| A11 | Planner health / workspace match | Watcher supervisor recovery path | `scripts/watcher/planner-health.mjs` (pattern `PLANNER_IDENTITY_PATTERN`, match per ruolo non per nome — Rev 66) | Evita duplicati `planner-01` quando Herdr usa nomi unici `planner-<project>-<hash>`. |
| A12 | Trace pipeline | `appendRawTraceRecord` (sorgente verità JSONL) + index SQLite + semantico Ollama solo a query time | `scripts/yano-trace*.mjs`, `yano-trace-storage.mjs` | Correlazione per `run_id`/filtri; raw preservato (recovery playbook). |

## 3. State and event flow (deleghe agent_send/await)

**Evidenza E-DEL-1 — costanti e hop/timeout.**
- Comando: `grep -n "MAX_HOPS\|TIMEOUT_MS\|WATCHDOG_STALL_MS\|…" scripts/orchestrator-tools/agents.ts extensions/orchestrator.ts scripts/watcher/heartbeat.mjs …` — exit_code 0.
- Artifact: `scripts/orchestrator-tools/agents.ts:97,100,335,345,503-539,703-735`; `extensions/orchestrator.ts:124-125,148-149,166,190,202-203,1685,2322,3116`.
- Source_reference: `agents.ts:97` `TIMEOUT_MS = Number(PI_ORCH_TIMEOUT_MS)||1_800_000`; `:100` `MAX_HOPS = …||24`; `:335` descrizione `agent_await` "Default timeout 30 minutes"; `:538-539` `hops = new_round?0:inbound.hops+1; if (hops>=MAX_HOPS) throw`; `:703-735` timeout branch (30 min) con `entry.result={error:timeout}`, `scheduleEviction`, wake `pi.sendMessage` + `notification_dispatch(reason:agent_send_timeout)`; `orchestrator.ts:1685` check hops inbound; `:3116` `withTimeout(p,ms)`.
- Expected: delega bounded con anti-loop e wake su timeout. Observed: sì, testuale confermato.
- evidence_confidence 0.95 / judgment_confidence 0.9 (motivo: righe lette verbatim, semantica wake/timeout da commenti+codice adiacente senza esecuzione live).
- Limiti: nessun invio live; latenza reale MQTT e ordine wake vs `agent_get` race non misurati; nome pinned LLM unknown (manifest boundary).

**Evidenza E-DEL-2 — envelope e correlation identity.**
- Comando: `grep -n "agent_send\|pendingReplies\|assignment_id\|campaign_id" scripts/orchestrator-tools/agents.ts | head -n 80` — exit_code 0.
- Artifact: `agents.ts:104` (assignment ULID time-sortable), `:136-144` shape `{assignment_id,hops}`, `:183` `getCurrentInbound {hops,campaign_id,chapter_id,phase_id}`, `:644-769` publish: `pendingReplies.set`, `pi.appendEntry("orchestrator-log",{outbound_command,assignment_id,target,hops})`, `logEvent("agent_send_out",{…,new_round,prompt_preview(200),route,fallback_target,watcher_bootstrap,campaign_id,chapter_id,phase_id})`, return `details:{assignment_id,target,hops,no_live_target,route,…}`.
- Expected: ogni edge asincrono correlabile (invariante playbook `every_async_edge_correlatable`). Observed: sì — `slug` auto-appende audit line al report (orchestrator.ts:721), `assignment_id` + env hop/campaign/chapter/phase propagati.
- evidence_confidence 0.93 / judgment_confidence 0.88 (motivo: propagazione dichiarata nel codice letto; routing effettivo broker non osservato live).
- Limiti: `trace_reference` per singolo send non catturato (serve run live); fallback_target/watcher_bootstrap semantics da prompt, non da smoke run.

**Evidenza E-AWAIT-1 — await/get semantics + Revisione 30.**
- Artifact: `agents.ts:309-369` (`agent_get` unknown-or-resolved; `agent_await` `timeout_ms` override, `setTimeout→{error:timeout}`, `entry.awaiting` flag così la reply risolve direttamente il turno bloccato); `orchestrator.ts:331-338,1845-1876` (fire-and-forget fix: se nessuno chiama più get/await, la reply va in wake/notification invece di perdersi).
- Expected: nessun reply perso in silenzio. Observed: codice prevede entrambi i path.
- evidence_confidence 0.9 / judgment_confidence 0.85. Limiti: race timing non testato qui (smoke `watch-agent-await`, `agent-send-presence-warning` esistono ma non eseguiti per mandato).

## 4. Retries & timeouts

| Policy | Valore / codice | Retry behavior (observed) |
|---|---|---|
| `agent_send`/`agent_await` | `TIMEOUT_MS` 30 min (`PI_ORCH_TIMEOUT_MS`), per-call `timeout_ms` override | Nessun retry automatico del send; timeout → `entry.result={error:timeout}` + eviction schedulata + wake mittente + notifica. Nuovo round solo esplicito con `new_round:true` (planner decide; max 3 round da prompt prima di chiedere all'utente). |
| Hop ceiling | `MAX_HOPS` 24 (`PI_ORCH_MAX_HOPS`) | Drop con errore oltre soglia; `new_round:true` resetta a 0 (rischio: round multipli senza flag vengono droppati — vedi FM-3). |
| In-process watchdog | `WATCHDOG_INTERVAL_MS` 120s, `STALL_MS` 900s (15 min), `FINALIZE_GRACE_MS` 600s, `AUTO_TERMINATE_MS` 1200s OFF default | Sweep ogni 2 min; `thresholdLevel=floor(elapsed/STALL)` → escalation progressiva; tier hard-stuck pubblica terminate envelope solo se `PI_ORCH_WATCHDOG_AUTO_TERMINATE=true`, altrimenti notifica e planner rilancia. |
| Standalone watch | `--stall-ms` 900s, `--interval-ms` 300s, `--lookback-ms` 24h, staleness window `min(stall,10min)` per tool-call activity | Poll SQLite; 章 `findStalledTicketsFromDb` riusa predicate canonico; away-mode assorbe rumore (una passata pulita silenziosa). |
| Heartbeat gate | `YANO_WATCHDOG_HEARTBEAT_MAX_AGE_MS` 300s (2.5× sweep) | `shouldPublishStallEvent`: unknown→true (fail-open), altrimenti `age>maxAge`. |
| Scheduler exec | `executeScript timeoutMs` default 120s (`job.timeout_ms`), `YANO_SCHEDULE_DISPATCH_TIMEOUT_MS` 180s | `spawnSync` bounded; `dispatch_timeout` → `permanent_failure:true` + `retry_of` record (`recordInstance … automatic_retry:true`) + `retryRecoverableFailures`; contended dual-crontab pass skippata (`last_run_slot` dedupe). Nessun retry infinito ogni timeout. |
| Ticket recovery | `ticket_requeue {max_retries,max_replans,reason}` + `recovery_generation` persistita | Retry bounded esplicito; dependent resta blocked su failed (no cascade auto). |
| MQTT/network guard | `withTimeout(client.endAsync(),1500)`, herdr `execFile timeout:10_000`, `yano-invoke` default 120s | Fail-open/bounded: ritorna `undefined`/status 1, mai hang. |
| broker reconnect | `orchestrator.ts:2167-2183` commenti | Retry background con self-heal quando broker torna up (non verificato live). |

**Evidenza E-RT-1.** Comando `grep -n "dispatchPlanner\|dedupe\|timeout\|retry\|cronMatches" scripts/yano-scheduler.mjs` exit 0 — artifact `yano-scheduler.mjs:252` (cron 5 campi obbligatorio), `:263-266` (`executeScript` spawnSync bounded 8MB buffer), `:274-330` (dispatchPlanner+launchPlannerAndWait), `:360-408` (supervisor dispatch_timeout/retry_of/permanent_failure), `:423` (`last_run_slot===slot` skip), `:505+` (`cronMatches`). Expected: dispatch bounded + dedupato + retry tracciato. Observed: sì. evidence 0.9 / judgment 0.85. Limiti: tick live non eseguito; doppia installazione crontab (`CRON_MARKER` supervisor) solo statica.

## 5. Logging and trace

- `agent_send_out` / `outbound_command` (agents.ts:739-740) con `prompt_preview` troncato a 200 char — actionable senza leak di reasoning completo (invariante `logs_are_actionable`).
- `notification_dispatch {ok,detail,channels,reason:agent_send_timeout}` + `will_retry` nei log event (orchestrator.ts:2463-2488).
- Watcher: marker JSONL append-only + `ticket_stalled` MQTT + heartbeat `{checked_at}` per-project (best-effort, mai bloccante — heartbeat.mjs).
- Trace: `appendRawTraceRecord` JSONL = source of truth; SQLite/index derivati; filtro `run` (`yano-trace-storage.mjs:412`); semantico Ollama solo a query time → raw preservato anche con index spento (recovery playbook `preserve_raw_events`).
- Log quality: event/actor/project/outcome presenti nel codice letto; redazione via `orchestrator-tools/redact.ts` (non ispezionato a fondo — gap dichiarato).
- **Gap strumentazione (unknown, non success):** latenze/token/round-duration reali non misurabili senza run live; `redact.ts` coverage e `review-log.mjs` su coppia `agent_send_out/wake_in` citati ma non verificati qui → telemetry mancante da colmare prima di qualunque claim di affidabilità (failure_route playbook: `recommend_instrumentation_before_claiming_reliability`).

## 6. Failure & recovery

### 6.1 Recovery inventory (verificato)

- **watchdog-sweep.ts (A2):** `yanoFindStalledTickets(storage,project,now,STALL)` → livelli → `yanoPublishEvent` + `sendNotifications` (WhatsApp tripwire) + `writeWatchdogHeartbeat`; poi `yanoFindUnfinalizedRuns` (grace 10 min) e orphaned/disconnected-instance detection (auto-fail + richiesta relaunch, Rev 42). Deps iniettate via getter per preservare closure semantics (commento header M3).
- **detect-stalled-tickets.mjs (A3):** pura/DI `{tickets,runs,openHoldRunIds},nowMs,stallMs`; pinning semantico via `detect-stalled-tickets-shared.test.mjs` (inclusivo `>=`).
- **storage (A10):** SQLite via `OrchestratorStorage`; migrazioni non-distruttive; `UNIQUE`/`generation` fencing (dettagli §7).
- **invoke (A8):** `composePlannerInvoke` valida `projectRoot` esistente, spawn `print-only` — nessun side effect; yano-local-pc path ritorna status 1 se broker assente.
- **launch-planner (A9):** `--print-only` per dry-run argv; skill scoping per ruolo; fix stale `pi -e extensions/orchestrator.ts` (Rev 44) che costava ~58k token di ridiagnosi.

### 6.2 Failure modes (con pagina di recovery)

| ID | Failure mode | Evidenza | Recovery esistente | Residuo / azione |
|---|---|---|---|---|
| FM-1 | Doppio publish stall (A1+A2 vivi) | heartbeat.mjs header M5 + `shouldPublishStallEvent` | Gate heartbeat; duplicato preferito a miss (fail-open) | Accettato by-design; monitorare duplicati via trace. |
| FM-2 | Watchdog in-process morto (nessun planner aperto) | orchestrator.ts:143 header "only runs while planner alive"; watch-stalls.mjs header | A1 detached tripwire copre il buco | Richiede Herdr pane/cron attivo; se anche quello giù → nessuno rileva (documentare). |
| FM-3 | Hop-limit drop silenzioso senza `new_round` | agents.ts:539 + prompt planner "new_round obbligatorio" | Errore esplicito + istruzione prompt (max 3 round) | Script-first: lint pre-send che avvisa se chain>20 senza flag (OP-3). |
| FM-4 | Fire-and-forget senza await perde reply | Rev 30 (orchestrator.ts:331-338) | Wake/notification fallback | Verificare con smoke `watch-agent-await` in CI. |
| FM-5 | Send a target non-live | agents.ts:581-586 `noLiveTargetWarning` | Warning ma send comunque (assignment creato) + timeout 30 min dopo | Migliorare a fail-fast opzionale per run interattivi (OP-4). |
| FM-6 | Heartbeat missing/corrupt → publish duplicato | `readWatchdogHeartbeatAgeMs→null→true` | Fail-open intenzionale | OK; aggiungere metrica duplicati. |
| FM-7 | Doppio crontab supervisor → doppia osservazione | yano-scheduler.mjs:134-140 | Contended pass skipped (`last_run_slot`) | OK statico; test regression esistente (`…-duplicate-fire-regression`) non eseguito qui. |
| FM-8 | `withTimeout→undefined` nasconde outage broker | orchestrator.ts:3116 | Loop resta vivo + self-heal a reconnect | Aggiungere contatore `broker_timeout_total` (OP-2). |
| FM-9 | Ticket orphaned su istanza morta resta `running` 15 min | watchdog-sweep orphaned path + Rev 42 | Auto-fail + richiesta relaunch (non auto-relaunch) | Accettato; relaunch resta decisione planner/umana. |
| FM-10 | Auto-terminate OFF default → hard-stuck oltre 20 min solo notificato | `WATCHDOG_AUTO_TERMINATE_ENABLED=false` default | Notifica obbligatoria con azione planner | Non abilitare globalmente senza policy; valutare per-run opt-in. |
| FM-11 | Plan gate blocca send legittimi se planner non avanza fase | plan.ts:46-59 enforcement | `plan_advance` esplicito; `plan_set` preserva fasi complete | UX: messaggio refusal già esplicito; nessuno script-change. |
| FM-12 | Scheduler `dispatch_timeout` senza conferma lancio | yano-scheduler.mjs:360-388 | `permanent_failure` + retry_of tracciato, retry sospesi fino a prossima occorrenza | OK; evitare retry immediato aggressivo (già così). |

## 7. Idempotenza & state propagation

- **Worktree/report/claim:** `worktree_create` idempotente per slug (riuso tra round); `report_append` append atomico (anti-lost-update tra specialisti paralleli); `file_claim` advisory TTL 20 min, expired auto-free, `file_release` idempotente.
- **Storage keys (grep exit 0 su `yano-orchestrator-storage.ts`):** `UNIQUE(slug,kind,idempotency_key)` (finalize evidence), `UNIQUE(run_id,requirement,idempotency_key)` (playbook evidence), `PRIMARY KEY(hold_id,operation,idempotency_key)` (decision holds), `dedupe_key UNIQUE` (runs/effects), `UNIQUE(run,role,instance,capability)` (capability cards), `generation`/`expected_generation` fencing su `transitionPlaybook`/`answer/cancel/escalateHold`/`ackEffect`, `createDecisionHold→{created}` per idempotency_key, `bindPlaybook` con checksum+snapshot immutabili.
- **Scheduler:** job legacy senza id ricreati idempotentemente (yano-scheduler.mjs:84); `last_run_slot` dedupe; `retry_of` chain preserva causalità.
- **State propagation:** `agent_send` porta `hops/campaign_id/chapter_id/phase_id/slug/prompt_preview/route`; `agent_send_out` + `orchestrator-log` + report-line automatica (slug) + MQTT event + trace raw + heartbeat file. Plan-gate: fasi `locked/unlocked/complete` persistite + audit append.
- **Evidenza E-ID-1.** Comando `grep -n "idempot\|UNIQUE\|PRIMARY KEY\|generation\|dedupe_key\|INSERT INTO" scripts/yano-orchestrator-storage.ts | head -n 60` exit 0 — artifact righe 118,177,195-213,224-466,502-630 (vedi output). Expected: fencing/idempotenza per ogni mutazione. Observed: sì su schema/interface. evidence 0.92 / judgment 0.87. Limiti: enforcement runtime (race concorrenti) non provato senza carico; isolamento skill (`check-skill-isolation`) non rieseguito.

## 8. Deterministic opportunities (script-first, con postcondition)

| ID | Candidato | Precondition | Postcondition verificabile | Fallback |
|---|---|---|---|---|
| OP-1 | Stall predicate già estratto (A3) — estendere a `finalize-grace` + `orphaned` come funzioni pure con shared-test | Esistono `watchdog-sweep.test` + `detect-*.test` | `node --test scripts/watcher/*.test.mjs` verde + nuovo `*-shared.test` per finalize/orphan con boundary `>=` pinnato | Tenere implementazioni correnti fino a test verdi |
| OP-2 | Contatori deterministici watcher (`stall_detected_total`, `stall_published_total`, `stall_duplicate_suppressed_total`, `broker_timeout_total`, `heartbeat_write_fail_total`) in JSONL | Nessuna metrica contatore oggi (solo marker/eventi) | Post: `yano trace search --event stall_published --run <id>` ritorna N == marker JSONL; dashboard gantt li legge senza LLM | Nessun cambio comportamento se write fallisce (best-effort come heartbeat) |
| OP-3 | Pre-send hop lint (`hops>=20 && !new_round` → warning bloccante opzionale) | Hop chain disponibile via `getCurrentInbound` | Post: send a 24 senza flag rifiutato con errore `hop limit` riproducibile in smoke; con flag passa | Default warn-only, mai block senza flag esplicito |
| OP-4 | Fail-fast opzionale send-a-target-offline (`--require-live-target`) | `noLiveTargetWarning` già calcolato | Post: con flag, send a istanza non-live ritorna errore immediato invece di timeout 30 min; senza flag comportamento invariato | Default invariato (compat) |
| OP-5 | Scheduler dry-run `tick --dry-run` che stampa dispatch senza spawn | `dispatchPlanner` già puro fino a `launchPlannerAndWait` | Post: output argv == `yano-invoke` composed argv per stesso job; zero processi spawnati | Solo lettura, nessun effetto |
| OP-6 | Heartbeat + stall bundle in un unico `watcher_supervise --json` | Heartbeat, stalled, unfinalized già letti separatamente | Post: JSON contiene `{checked_at, stalled[], unfinalized[], published[]}` con `run_id`/`ticket_id` per ogni voce; retry/unknown espliciti | Fallback a comandi separati se bundle assente |

Esclusioni rispettate: nessuna stima latenza/token inventata; nessun claim di risparmio senza baseline (per playbook `delegation-efficiency`).

## 9. Prioritized actions

1. **P0 — Colmare telemetria prima di claim di affidabilità:** definire `stall_published`, `duplicate_suppressed`, `broker_timeout`, `dispatch_timeout` come eventi queryabili + runbook. (OP-2)
2. **P0 — Pinnare finalize/orphan come pure + shared-test** come fatto per stall (OP-1). Previene la prossima divergenza M3.
3. **P1 — Eseguire in CI (non qui) gli smoke esistenti** `watch-stalls`, `watchdog`, `watch-agent-await`, `agent-send-presence-warning`, `scheduler-duplicate-fire-regression`, `scheduler-script-first` — chiudono FM-4/FM-7 senza nuovo codice.
4. **P1 — Documentare il buco "nessun watcher vivo"** (FM-2): `yano watch` in Herdr + cron supervisor come requisito, non suggerimento.
5. **P2 — Hop-lint + fail-fast opzionale** (OP-3/OP-4) dietro flag, default compat.
6. **P2 — `tick --dry-run`** (OP-5) per audit futuri senza side effect.

## 10. Resource accounting

- **Inference vs deterministico:** questo capitolo è audit read-only (LLM): ~8 comandi `grep/head/wc/ls/git` + 5 `read` header (80 righe) + manifest JSON. Nessun broker/Herdr/LLM-spawn, nessuno script `node` eseguito oltre `node --version`/`git rev-parse`. Lavoro deterministico del sistema auditato (watcher/scheduler/invoke/storage) descritto ma non rieseguito — costi/tempi reali restano unknown.
- **Comandi (exit_code 0 tutti):**
  - `ls scripts/watcher/ + orchestrator-tools/ | head + cat automation-control-audit.yaml | head -n 120`
  - 5× `read` (watch-stalls, detect-stalled-tickets, watchdog-sweep, yano-invoke, launch-planner — prime 80 righe)
  - `grep agent_send|withTimeout|idempotency|retry|timeout… extensions/orchestrator.ts`
  - `grep hop|timeout|assignment_id… agents.ts + grep idempot… storage + ls scheduler*`
  - `grep dispatchPlanner|cronMatches… scheduler + heartbeat/planner-health/trace/plan-gate`
  - `grep MAX_HOPS|TIMEOUT_MS|WATCHDOG_*… (5 file) + cat heartbeat.mjs`
  - `wc -l (11 file) + node --version + git rev-parse HEAD`
- **Measurements:** orchestrator.ts 3182 / agents.ts 783 / watch-stalls.mjs 1635 / detect-stalled 46 / watchdog-sweep.ts 386 / heartbeat.mjs 57 / storage 1258 / invoke 89 / launch-planner 886 / scheduler 769 / plan.ts 410 / playbook yaml 64 — totale 9565 righe lette in target; node v26.5.0; HEAD `faed4ad`; timeouts vedi §4.
- **Model:** `llmproxy` via `PI_MODEL`/`PI_PROVIDER` (nome pinned provider:model non esposto — dal manifest discovery).
- **Limiti globali:** broker/Herdr/pi-spawn/trace semantica/MCP reachability/full test-all+e2e richiedono credenziali vive (manifest `requires_broker_herdr_credentials`); `redact.ts`, `review-log.mjs`, smoke/watcher-registry non riletti a fondo; brief ruolo `automation-control-auditor` usato come fallback playbook id dove assente.

---

*Report scritto read-only in `docs/reports/audit-deep-16-09-26_07-37/automation-control-16-09.md` del target; nessun file codice mutato. Dual-confidence per evidenza sopra; ogni unknown marcato tale, mai successo.*
