# CAPITOLO TEST — Adeguatezza e Gap (audit-campaign deep, 16-09)

- audit: audit-campaign deep yano-orchestrator
- run: 01M2MB2JEWW0DF9F9GS5SVQ4RW
- ticket: 01M2MB6YAGAC7FQAPC1QG7EF95 (role: test-adequacy-analyst)
- target (READ-ONLY): /Users/alessiobacin/Development/testCode/yano-orchestrator (v1.6.2, HEAD faed4ad — da manifest)
- manifest letto per primo: docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json (nessuna discovery rifatta; conteggi verificati via ls/grep/head, nessuna esecuzione mutante del target)
- data UTC: 2026-09-16
- mandato: mappa use-case e transizioni di stato su test esistenti (scripts/test-all.mjs, vitest, smoke-test-*.mjs, e2e-full-flow); conta test per area; distingue copertura reale da presenza; percorsi negativi, persistenza, cross-command. Output: use-case-catalog, coverage-gaps, test-strategy. Solo artefatto audit scritto.

## 1. Use-case catalog (mappato su test esistenti)

Legenda: REAL = importa dinamicamente `extensions/orchestrator.ts` (stessa tecnica e2e-full-flow, FakeInstance + broker reale); MIRROR = reimplementazione/fake locale, non tocca il codice reale; LINT = check deterministico offline; UNIT = vitest (*.test.mjs).

### A. Orchestrator core deterministico — COPERTURA REALE FORTE
| Use-case / transizione | Test | Tipo |
|---|---|---|
| full flow parallelo (security-evaluator + docs-sync), worktree_finalize + WhatsApp POST su Evolution finto | scripts/e2e-full-flow.mjs TEST 1 (719 righe totali, 6 scenari) | REAL e2e |
| TDD-exception ordering tdd-agent→coder→docs-sync, plan_set validator reale | e2e-full-flow.mjs TEST 2 | REAL e2e |
| worktree_list_open rileva worktree sovrapposto da sessione precedente | e2e-full-flow.mjs TEST 3 | REAL e2e |
| worktree_finalize: dirty-main block, merge conflict reale, worktree_abandon cleanup | e2e-full-flow.mjs TEST 4 | REAL e2e, negativo |
| file_claim/file_release contesa reale tra due specialist | e2e-full-flow.mjs TEST 5 | REAL e2e, negativo |
| bypass reviewer: specialist→coder diretto, fix torna allo STESSO specialist | e2e-full-flow.mjs TEST 6 | REAL e2e, cross-role |
| ticket/DAG layer: init, run_create, spec_create, ticket_create, tickets_ready, claim, complete, run_status, wave + cycle detection, capability matching, MQTT event, riapertura fresh-process su stesso SQLite | scripts/smoke-test-ticket-engine.mjs | REAL |
| plan_set/plan_advance/plan_get gating | scripts/smoke-test-plan-gate.mjs | REAL |
| worktree create/finalize/abandon/list_open | scripts/smoke-test-worktree.mjs, smoke-test-worktree-cwd-guard.mjs | REAL |
| agent_send phase gate, report_append, session_start MQTT wiring, before_agent_start templating, agent_end publication | e2e-full-flow.mjs (dichiarato in header) | REAL |
| coordination, control-plane, reconciliation, project-scoping/scope-flag, specialist-prompt, team-per-instance, instance-liveness, response-wakeup, global-notification-fallback, approval-gate, decision-hold-single-notification | smoke-test-coordination/control-plane/reconciliation/… (lista E-REAL sotto) | REAL |

### B. Watcher / watchdog / presence / routing — COPERTURA REALE + UNIT FORTE
REAL: smoke-test-watch-stalls, smoke-test-watchdog, smoke-test-yano-watcher-e2e, smoke-test-presence-refresh (riapertura fresh), smoke-test-late-broker, smoke-test-shutdown-hang, smoke-test-launch-any-role, smoke-test-launch-planner-legacy, smoke-test-copy-prompts, smoke-test-custom-prompts, smoke-test-debug-log, smoke-test-end-project, smoke-test-feedback-queue-wake, smoke-test-gantt, smoke-test-context-compaction-e2e.
UNIT (vitest): scripts/watcher/cron-schedule, detect-stalled-tickets, detect-stalled-tickets-shared, heartbeat, herdr-tab-lifecycle, planner-health, project-runs, watchdog-sweep (8 file).
MIRROR di contorno: watch-agent-await, watcher-user-wait, watcher-cron/registry/recovery-cooldown/planner-unhealthy-escalation/findings-comments-gate, heartbeat-unification, herdr-reachability-tracking, herdr-agent-name/start-race, orphaned-agentless-tabs, duplicate-pi-session-tabs, fresh-agent-not-closed, planner-action-guard/tab-never-closed/role-not-name, agent-routing-fallback, agent-send-presence-warning, vision-routing, audit-routing, pipeline, multiround, planning-flow.

### C. Run/ticket DAG persistenza & recovery — MEDIO-FORTE
REAL: ticket-engine (persistenza SQLite + fresh-process reopen — contratto resumability). UNIT: scripts/yano-orchestrator-storage.test.mjs, orchestrator-tools/run/tickets/ticket-scheduling/plan/plan-gate/worktree/git-worktree (16 file orchestrator-tools). MIRROR: yano-recovery, yano-repair (fake Herdr + snapshot obsoleto scope MQTT), yano-repair-all/apply/agent-start-race, retention-backup, completed-run-supervision, orphaned-notify, bulk-close-watcher-tickets, report-audit, e2e-report-regressions.

### D. Playbook / ruoli / capability catalog — SOLO LINT + UNIT, nessun behaviorale
LINT: lint:playbooks (stesso parser + contract loader del runtime, 31 playbook), lint:capabilities (probe registry, schema_version 1). UNIT: orchestrator-tools/playbooks, capability-cards, agents, misc, governance-proposals, decision-holds, retention-policy. MIRROR: playbook-loader, yano-playbook-catalog, yano-clean-repo/refactor/conversation/debate/get-the-best-from-playbook, yano-qa-inventory, clean-repo-documentation-contract. GAP: nessun test esegue un playbook end-to-end (contenuto fasi non inventariato — cfr. manifest limitations).

### E. CLI commands (42 righe help) — DISEVENNE
Dedicati presenti: copy-prompts, ponytail, yano-deps, yano-docs-check, yano-test-environment, yano-cli(+installer), yano-config, yano-status, yano-projects, yano-dash (child-process reale con regressione SSE documentata), yano-scheduler(+script-first, duplicate-fire-regression), yano-services(+dash-builtin), yano-trace(+index/memory/analysis), yano-feedback, yano-capabilities, yano-model-advisor, yano-watcher-*, gantt(-readable), init-existing/herdr/preflight, update-reload/linked, piglio repair/recovery.
GAP dedicati: `uninstall` (0 riferimenti in alcuno smoke-test — grep 0 file), `frontend-dash` (0 file dedicati; solo yano-dash che è il comando alias `dash`, non il proxy 10000-10999), `leave` (0 file dedicati, 8 riferimenti incidentali), `test-env` (1 solo file), `docs-check` (1), `deps` (2), `copy-prompts`/`ponytail` (2 ciascuno, minimali).

### F. Feedback / API / dash / services / scheduler / cron — SOLO MIRROR (tranne dash)
MIRROR: feedback-activity/api-handler/concurrency/e2e-flow/queue-wake/screenshot-status-update, api-registry, yano-services(-dash-builtin), yano-scheduler(-script-first/-duplicate-fire), yano-os-scheduler, server-status, yano-dash-state, gantt-readable. ECCEZIONE reale: smoke-test-yano-dash.mjs (spawn child-process reale, kill SIGTERM reale, regressione SSE socket).

### G. Trace / memory / embeddings / local-pc — SOLO MIRROR (tranne 1)
MIRROR: yano-trace(-index/-memory/-analysis), yano-embeddings, agent-memory, agent-memory-accumulation, codemem-localpc-ask/store/rehydrate, code-mem-context, project-context, daily-digest/log-rotation/default-digest-job, project-log-size-alert. REAL: solo smoke-test-agent-memory-lessons.mjs.

### H. Contratti docs/audit — PRESENZA, non semantica
check:docs (8 categorie canoniche), smoke-test-audit-artifacts (assert su confidence-contract + presenza playbook/prompts audit), smoke-test-yano-docs-check, qa-inventory scan. Verificano esistenza/pattern, non correttezza semantica dei contenuti.

## 2. Conteggi per area (verificati, non riusati dal manifest)

| Area | Conteggio verificato |
|---|---|
| smoke-test-*.mjs totali | 149 file |
| REAL (importano extensions/orchestrator) | 34 (lista §4 E01) |
| MIRROR/fake (nessun import reale) | 115 |
| vitest *.test.mjs | 28 file (4 root + 8 watcher + 16 orchestrator-tools), 4541 righe totali |
| e2e-full-flow.mjs | 719 righe, 6 scenari, ~TEST 1–6 |
| lint/gate in test-all.mjs | check:package-version, check-syntax, check:docs, lint:capabilities, lint:playbooks, check-skill-isolation, test:unit, 149 smoke, e2e (runner auto-avvia broker docker se 127.0.0.1:1883 irraggiungibile; YANO_TEST_MODE=1 tranne e2e) |
| marker negativi (conflict/BLOCKED/refus/fail/invalid/expired/stale/dirty/abort/reject, case-insensitive) | 99/149 smoke (sovrastima: "fail" matcha "failed" nei log — vedi limiti) |
| marker persistenza (restart/fresh/reopen/survive) | 28 file (lista §4 E05) |
| comandi senza smoke dedicato | uninstall (0 ref), frontend-dash (0 file), leave (0 file) |

## 3. Coverage-gaps (prioritizzati)

- P0-G1 MIRROR 115/149: la maggioranza dei smoke non tocca il codice reale (dichiarato dagli stessi header come "MIRROR reimplementation … never the real file"). Copertura = presenza, non comportamento. Strategia: convertire per area (prima F/G/D) a import reale o marcare esplicitamente `presence-only` nel nome.
- P0-G2 Playbook behaviorale zero: 31 playbook + 57 ruoli verificati solo da lint/unit; nessuna esecuzione reale di un playbook. Rischio: contratto lint verde ma flusso rotto.
- P1-G3 `uninstall`, `leave`, `frontend-dash` senza test dedicato; `frontend-dash` (proxy 10000-10999) distinto da `yano-dash` testato. Rischio: comandi distruttivi/proxy non coperti.
- P1-G4 Scheduler/cron/services/feedback-API solo mirror con fake Herdr/bin: race reali (duplicate-fire coperto solo da 1 regression mirror), restart pm2/docker, healthcheck, concorrenza feedback solo simulati.
- P1-G5 Trace semantico (Ollama embeddings at query time) mai verificato: yano-trace-* tutti mirror; nessun test con indice reale.
- P2-G6 Persistenza kill--9 / broker-down mid-transaction: solo reopen pulito (ticket-engine fresh-process); mancano fault-injection (SIGKILL, broker drop, SQLite locked, disco pieno).
- P2-G7 Transizioni planner-tab/must-never-close, agent-send-presence-warning, vision/audit-routing solo mirror: il routing reale multi-istanza è coperto solo da e2e TEST 6 e coordination.
- P2-G8 Docs/audit-artifacts verificano pattern, non semantica: check:docs verde con doc obsoleta ma pattern-compliant.

## 4. Evidenze (comando + exit_code + artifact + source_reference + expected/observed + confidence doppia + limiti + resource_record)

- E01 — comando: `grep -l "extensions/orchestrator" scripts/smoke-test-*.mjs | wc -l` + `grep -L … | wc -l` | exit_code: 0 | artifact: nessuno scritto (lettura) | source_reference: scripts/smoke-test-*.mjs (root target), header e2e-full-flow.mjs righe 1–45 ("Every previous smoke test … is a hand-copied MIRROR … never the real file"), header smoke-test-ticket-engine.mjs righe 1–35 | expected: quota REAL vs MIRROR ignota | observed: 34 REAL / 115 MIRROR su 149 totali; lista REAL: agent-memory-lessons approval-gate context-compaction-e2e control-plane coordination copy-prompts custom-prompts debug-log decision-hold-single-notification end-project feedback-queue-wake gantt global-notification-fallback instance-liveness late-broker launch-any-role launch-planner-legacy plan-gate project-scope-flag project-scoping reconciliation report-audit response-wakeup shutdown-hang specialist-prompt team-per-instance ticket-engine watch-stalls watchdog whatsapp-notify worktree-cwd-guard worktree yano-status yano-watcher-e2e | evidence_confidence: 0.95 (grep testuale diretto) | judgment_confidence: 0.85 (import reale ≠ asserzioni forti; alcuni REAL potrebbero importare solo per utility) | limiti: grep non distingue intensità d'uso dell'import; non eseguito alcun test | resource_record: {commands: ["grep -l/-L extensions/orchestrator scripts/smoke-test-*.mjs"], measurements: {smoke_total: 149, real: 34, mirror: 115}, model: "llmproxy (PI_MODEL/PI_PROVIDER env; pinned name unknown)"}
- E02 — comando: `ls scripts/smoke-test-*.mjs | wc -l; cat scripts/test-all.mjs` | exit_code: 0 | artifact: nessuno | source_reference: scripts/test-all.mjs (funzioni ensureBroker/run/main: targets = package-version + syntax + docs + capabilities + playbooks + skill-isolation + vitest + tutti gli smoke + e2e; YANO_TEST_MODE=1 tranne e2e; auto-`docker compose -f mqtt/compose.yaml up -d`) | expected: runner sequenziale con broker auto-avviato (da manifest how_to_run) | observed: confermato; 149 smoke enumerati via readdirSync sort; fallimento = throw con exit code | evidence_confidence: 0.98 | judgment_confidence: 0.9 | limiti: runner letto intero ma non eseguito (mandato read-only; broker/docker/creds richiesti) | resource_record: {commands: ["ls scripts/smoke-test-*.mjs | wc -l", "cat scripts/test-all.mjs"], measurements: {smoke: 149}, model: "llmproxy"}
- E03 — comando: `ls scripts/*.test.* scripts/watcher/*.test.mjs scripts/orchestrator-tools/*.test.mjs; wc -l … | tail -5; ls vitest.config.*` | exit_code: 0 | artifact: nessuno | source_reference: 28 file *.test.mjs; nessuna vitest.config in root (solo `vitest run` da package.json); max: agents.test 330, watchdog-sweep 281, herdr-tab-lifecycle 239 righe | expected: unit da manifest (4+8+16) | observed: confermato 4 root + 8 watcher + 16 orchestrator-tools = 28 file, 4541 righe totali | evidence_confidence: 0.95 | judgment_confidence: 0.85 | limiti: nessuna esecuzione vitest; qualità asserzioni non campionata oltre le dimensioni | resource_record: {commands: ["ls scripts/*.test.* scripts/watcher/*.test.mjs scripts/orchestrator-tools/*.test.mjs", "wc -l …"], measurements: {test_files: 28, total_lines: 4541}, model: "llmproxy"}
- E04 — comando: `wc -l scripts/e2e-full-flow.mjs; head -60 …; grep -n "=== TEST" …` | exit_code: 0 | artifact: nessuno | source_reference: scripts/e2e-full-flow.mjs righe 1–45 (header REAL-vs-MIRROR), 321/494/527/565/615/642 (TEST 1–6), 699 (PASS assertions) | expected: 6 scenari REAL contro orchestrator.ts + broker mosquitto + worktree git + Evolution finto | observed: confermato; TEST 4 conflict reale, TEST 5 contesa claim, TEST 6 bypass reviewer | evidence_confidence: 0.95 | judgment_confidence: 0.85 | limiti: header dichiara esclusioni (LLM decision-making via FakeInstance, nessun test del binario `pi`) | resource_record: {commands: ["wc -l + head + grep TEST scripts/e2e-full-flow.mjs"], measurements: {e2e_lines: 719, scenarios: 6}, model: "llmproxy"}
- E05 — comando: `grep -l -i "restart|fresh process|brand new|reopen|survive" scripts/smoke-test-*.mjs scripts/*.test.mjs` | exit_code: 0 | artifact: nessuno | source_reference: 28 file (ticket-engine fresh-process reopen SQLite; plan-gate, coordination, presence-refresh, reconciliation, context-compaction-e2e, …) + scripts/yano-orchestrator-storage.test.mjs | expected: persistenza verificata oltre il reopen pulito | observed: solo reopen pulito; nessun SIGKILL/broker-drop/SQLite-locked/disco-pieno | evidence_confidence: 0.9 | judgment_confidence: 0.8 | limiti: marker testuale, non verifica semantica di ogni match | resource_record: {commands: ["grep -l persistenza …"], measurements: {persistence_files: 28}, model: "llmproxy"}
- E06 — comando: `for c in <42 comandi>; do grep -l -i …; done; ls scripts/smoke-test-*uninstall* …` | exit_code: 0 | artifact: nessuno | source_reference: bin/yano.mjs --help (da manifest, 42 righe), assenza file smoke-test-*uninstall*/frontend-dash*/leave*; copy-prompts/ponytail/yano-deps/yano-docs-check/yano-test-environment presenti ma minimali | expected: 1 smoke dedicato per comando | observed: uninstall 0 ref / frontend-dash 0 file (yano-dash testa `dash`, non il proxy) / leave 0 file (8 ref incidentali) | evidence_confidence: 0.9 | judgment_confidence: 0.85 | limiti: grep per nome comando sovrastima (es. "end"/"data"/"status" matchano parole comuni); l'assenza file dedicati è invece certa via ls | resource_record: {commands: ["grep -l per comando", "ls smoke-test-*uninstall*/*frontend-dash*/*leave*"], measurements: {uninstall_refs: 0, frontend_dash_files: 0, leave_files: 0}, model: "llmproxy"}
- E07 — comando: `head -30 scripts/lint-playbooks.mjs; head -20 scripts/lint-capabilities.mjs; head -30 scripts/check-documentation-sync.mjs; head -25 scripts/smoke-test-audit-artifacts.mjs` | exit_code: 0 | artifact: nessuno | source_reference: lint-playbooks (stesso parser+loader runtime, 31 yaml), lint-capabilities (probe registry, schema_version 1), check-documentation-sync (8 categorie), audit-artifacts (assert confidence-contract + presenza playbook/prompts) | expected: gate deterministici offline | observed: confermati; verificano presenza/pattern, non semantica né esecuzione | evidence_confidence: 0.92 | judgment_confidence: 0.85 | limiti: playbook fasi non inventariate (cfr. manifest limitations) | resource_record: {commands: ["head lint-playbooks/lint-capabilities/check-docs/audit-artifacts"], measurements: {playbooks: 31}, model: "llmproxy"}
- E08 — comando: `head -40 scripts/smoke-test-ticket-engine.mjs; head -30 scripts/smoke-test-yano-repair.mjs; head -20 scripts/smoke-test-yano-dash.mjs` | exit_code: 0 | artifact: nessuno | source_reference: ticket-engine header (REAL, broker + SQLite + fresh-process, esclusioni Playbook/replanning/budget/retry dichiarate); yano-repair header (fake Herdr/bin, snapshot scope MQTT obsoleto); yano-dash header (child-process reale, regressione SSE documentata) | expected: campione rappresentativo REAL vs fake vs eccezione reale | observed: confermato il gradiente; yano-dash è l'unico mirror-area con lifecycle OS reale | evidence_confidence: 0.9 | judgment_confidence: 0.85 | limiti: campione di 3 file, non tutti i 149 letti integralmente | resource_record: {commands: ["head ticket-engine/repair/dash"], measurements: {sampled: 3}, model: "llmproxy"}

## 5. Test-strategy (proposta, nessun cambio applicato)

1. Rinominare/marcare i 115 mirror (`-presence.mjs`) o convertirli a import reale con FakeInstance (priorità: scheduler/cron/services/feedback/trace/playbook-loader).
2. Playbook behavioral matrix: 1 scenario REAL per i playbook più usati (backend-change, refactor, clean-repo, qa-full-audit, test-adequacy-audit) con asserzioni su phase-gate + report sections, riusando l'harness e2e.
3. Test dedicati P1: `uninstall --yes` in scratch-root (assert rimozione senza tocco home reale), `leave --yes` (assert deregistro watcher), `frontend-dash start/stop` su porte test-env isolate (come yano-dash fa con SIGTERM reale).
4. Fault-injection persistenza: SIGKILL mid-ticket + broker down mid-publish + SQLite `database is locked` + worktree dirty, assert recovery/repair idempotente.
5. Trace semantico: 1 test con indice reale (skip se Ollama assente) + fallback JSONL grezzo; embeddings dietro `YANO_TEST_MODE`.
6. Gate di copertura: fallire `test-all.mjs` se quota REAL < soglia o se nuovo comando help senza smoke dedicato (check generato da `--help`).
7. Negativi cross-command: estendere e2e TEST 4–6 a pause/resume/recovery/repair sullo stesso run (stato propagato, no perdite).

## 6. Limiti globali

- Nessuna esecuzione di test (mandato read-only + broker/docker/creds richiesti da manifest boundary); tutti i verdetti sono statici (file letti + --help da manifest).
- `grep -l -i fail` sovrastima i negativi; i conteggi REAL/MIRROR sono per import, non per forza delle asserzioni.
- Pinned provider:model resta unknown (PI_* env, cfr. manifest).
- Questo file è l'unica scrittura (artefatto audit consentito); nessun codice mutato.
