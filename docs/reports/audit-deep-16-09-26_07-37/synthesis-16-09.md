# SINTESI — audit-campaign deep 16-09 (cross-review)

- audit: audit-campaign deep yano-orchestrator
- run: `01M2MB2JEWW0DF9F9GS5SVQ4RW`
- ticket sintesi: `01M2MB8G77BRCQMHPT2KDRBGJG` (role: audit-synthesizer)
- target (READ-ONLY): `/Users/alessiobacin/Development/testCode/yano-orchestrator` (v1.6.2, HEAD `faed4ad529a3f938535b9100e9f378b9836916b3`)
- data UTC: 2026-09-16
- mandato: incrocio READ-ONLY dei 6 artefatti, senza rediscovery, senza duplicati, contraddizioni esplicite, findings prioritizzati, implementation DAG separata dalla DAG audit, resource ledger. Solo artefatto audit scritto (questo file). Nessuna remediation avviata, nessun codice mutato.
- artefatti letti (6, soli consentiti):
  1. `docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json` (discovery, ticket 01M2MB6B8VFP1XW1994J1W1BAD)
  2. `docs/reports/audit-deep-16-09-26_07-37/toolchain-16-09.md` (ticket 01M2MB6P776HV6DVG9WPYKN8F6)
  3. `docs/reports/audit-deep-16-09-26_07-37/test-adequacy-16-09.md` (ticket 01M2MB6YAGAC7FQAPC1QG7EF95)
  4. `docs/reports/audit-deep-16-09-26_07-37/architecture-16-09.md` (ticket 01M2MB71JP0XCNSXZB7B6QV35W)
  5. `docs/reports/audit-deep-16-09-26_07-37/automation-control-16-09.md` (ticket 01M2MB75SSTMP4MSWJTJ0GSQXD)
  6. `docs/reports/audit-deep-16-09-26_07-37/product-ux-16-09.md` (ticket 01M2MB7WXNQG0RHZ7ANV95N5QV)

Metodo: riuso manifest + 5 capitoli; conteggi non rieseguiti (citati con source_reference al capitolo); nessun probe live aggiuntivo oltre `ls` di conferma presenza 6 file; nessun broker/Herdr/pi-spawn/test-esecuzione. Doppia confidenza per ogni SYN-finding (evidence = forza della fonte capitolare; judgment = inferenza di sintesi). Unknown marcato tale, mai successo.

---

## 1. Audit DAG (storico, non da rieseguire) vs Implementation DAG (proposta, non implementata)

### 1.1 Audit DAG — già eseguita
```
DISCOVERY (manifest: ls/help/counts/grep statici, 31 playbook, 57 ruoli, 38 prompts, 250 scripts, 149 smoke)
  -> TOOLCHAIN (probe CLI/MCP/skill/script/playbook D0/D1/AI) --+
  -> TEST-ADEQUACY (REAL 34 vs MIRROR 115, vitest 28, e2e 6 scenari) --+ paralleli, read-only
  -> ARCHITECTURE (hotspot/coupling/stato/resilienza, 15 evidenze E1-E15) --+
  -> AUTOMATION-CONTROL (A1-A12, FM-1..12, OP-1..6) --+
  -> PRODUCT-UX (42 comandi help, 3 GUI, onboarding 580+498+76 file) --+
  -> SINTESI (questo file: dedup + contraddizioni + DAG impl)
```
Separazione enforced: la DAG audit produce evidenza; la DAG implementazione sotto produce cambiamento. Non mescolare i due piani nei gate CI.

### 1.2 Implementation DAG — proposta al refactor-planner/planner (NON implementata qui)

Nodi = batch piccoli, ordinati, parallelizzabili dove segnato. Ogni nodo: pre/post-condition + test + rollback + done-criteria. Nessun nodo avviato.

- **IMP-0 Telemetria prima di reliability-claim (P0, sblocca tutto il resto)**
  Depends: nessuno. Fa: OP-2 automation (contatori `stall_detected/published/duplicate_suppressed/broker_timeout/dispatch_timeout/heartbeat_write_fail` in JSONL + query `yano trace search`). Post: `trace search --event stall_published --run <id>` == marker JSONL; gantt li legge senza LLM. Fallback: best-effort write, nessun cambio comportamento. Done: eventi queryabili + runbook. Source: automation §8 OP-2 + §9 P0.
- **IMP-1 Pinnare finalize/orphan come pure + shared-test (P0)**
  Depends: IMP-0 (usa stessi eventi). Fa: OP-1 (estendere predicate canonico A3 a finalize-grace + orphaned, `*-shared.test` con boundary `>=`). Post: `node --test scripts/watcher/*.test.mjs` verde. Done: nessuna divergenza M3 futura. Source: automation §8 OP-1 + §9 P0.
- **IMP-2 Convertire MIRROR→REAL per aree F/G/D + gate quota REAL (P0 test)**
  Depends: IMP-0 (misura quota). Fa: rinominare 115 mirror `-presence.mjs` o convertire a import reale con FakeInstance (priorità scheduler/cron/services/feedback/trace/playbook-loader); playbook behavioral matrix (1 scenario REAL per backend-change/refactor/clean-repo/qa-full-audit/test-adequacy-audit); gate `test-all.mjs` fallisce se quota REAL < soglia o comando help senza smoke. Post: quota REAL misurata in CI; 5 playbook con scenario REAL. Done: G1+G2 chiusi. Source: test §3 P0-G1/G2 + §5.1/.2/.6.
- **IMP-3 Test dedicati uninstall/leave/frontend-dash + fault-injection persistenza + trace semantico (P1 test)**
  Depends: IMP-2 (harness REAL riusato). Fa: `uninstall --yes` in scratch-root, `leave --yes` deregistro, `frontend-dash start/stop` su porte test-env; SIGKILL/broker-drop/SQLite-locked/worktree-dirty; 1 test indice reale Ollama con skip se assente. Post: PASS/FAIL riproducibili. Done: G3+G6+G5 chiusi. Source: test §3 P1-G3/P1-G5/P2-G6 + §5.3/.4/.5.
- **IMP-4 Consolidare stall-detection + watcher-subsystem + trace-index seam (architettura, P1)**
  Depends: IMP-1 (predicate pinnato). Fa: R2 (core `detect-stalled-tickets.mjs`, `watchdog-sweep.ts` sweep in-process, `watch-stalls.mjs` thin CLI, registry solo stato) → R3 (registry 1490 split detection/registry/CLI) → R4 (index 881 dietro interfaccia storage). Post: `check-syntax` + smoke presence/send dopo ogni fetta. Done: duplicazione chiusa, nessuna nuova logica. Source: architecture §2 R2/R3/R4 + handoff R2→R4→R5→R1.
- **IMP-5 Splittare agents.ts/worktree + chiarire worktree.ts vs git-worktree.ts (P2 arch)**
  Depends: IMP-4. Fa: R5. Post: factory invariata, test esistenti verdi. Done: nessun modulo tool >400 righe. Source: architecture §2 R5.
- **IMP-6 Spacchettare activate() wiring a fette meccaniche (P2 arch, ultimo)**
  Depends: IMP-4 + IMP-5. Fa: R1 (flag/config, prompt assembly, workspace, reconcile, MQTT connect, tool assembly, widget, shutdown; criterio zero-ref identity/pi/client). Post: `check-syntax` + smoke + `test-all.mjs` (esecuzione = capitolo test, non qui). Done: `activate()` <800 righe wiring. Non toccare: storage 1258 (coeso) + `bin/yano.mjs`. Source: architecture §2 R1/R6 + F3.
- **IMP-7 UX P0: fix help + sdoppiamento (P0 prodotto, parallelo a IMP-0..3)**
  Depends: nessuno (docs/CLI-text only). Fa: riparare `start --help` (--herdr/--instance/--print-only/--json); riempire `schedule/cron --help` + riga distintiva script-first vs NL-supervisor; sdoppiare secondo `architect` elenco → `fleet projects`/`workers`. Post: ogni `--help` non vuoto; `grep architect help` = 1 concetto. Done: G1-G3 prodotto chiusi. Source: product §4 G1 + §6 P0.1-3 + toolchain §fallback schedule/cron.
- **IMP-8 UX P1: help raggruppato + doctor --fix-hint + dashboard unificata + lingua (P1 prodotto, parallelo)**
  Depends: IMP-7. Fa: 6 sezioni help + `help <cmd>` alias; `doctor --fix-hint` una riga per ✗; `yano dashboard` lista/apre Gantt+feedback+frontend-dash; glossario `agent/agents`, `dash/dashboard`, IT-vs-EN. Post: scoperta senza leggere script. Done: attrito quotidiano ridotto. Source: product §6 P1.4-7 + §4 G4/G5/G7.
- **IMP-9 Decisioni toolchain gated (planner, non batch codice)**
  Depends: nessuno; sblocca capitoli live futuri. Fa: (a) `kubectl version --client=true` retry D0; (b) handshake MCP redatto (github oauth/stitch gcloud/chrome-devtools npx) sì/no; (c) install `helm/semgrep/postman` sì/no o fallback statici accettati; (d) breakdown token via `model-advisor` sì/no. Post: ogni `unknown` toolchain diventa ready o BLOCKED esplicito. Source: toolchain §handoff + §missing-prereq 1-6.
- **IMP-10 Eseguire in CI smoke esistenti + documentare buco "nessun watcher vivo" (P1 automazione)**
  Depends: IMP-0. Fa: CI `watch-stalls/watchdog/watch-agent-await/agent-send-presence-warning/scheduler-duplicate-fire/scheduler-script-first`; doc `yano watch` Herdr+cron come requisito. Post: FM-4/FM-7 chiusi senza nuovo codice; FM-2 documentato. Source: automation §9 P1.3-4.
- **IMP-11 Hop-lint + fail-fast opzionale + tick --dry-run + bundle supervise --json (P2 automazione, dietro flag)**
  Depends: IMP-0. Fa: OP-3/OP-4/OP-5/OP-6 default-compat. Post: smoke riproducibili. Source: automation §8 OP-3..6 + §9 P2.

Ordine consigliato: IMP-9 (decisioni, subito) → IMP-0+IMP-7 in parallelo → IMP-1+IMP-10 → IMP-2 → IMP-3 → IMP-4 → IMP-5 → IMP-6; IMP-8 dopo IMP-7; IMP-11 per ultimo. Nessun passo implementato in questo ticket.

---

## 2. Findings sintetizzati (deduplicati, prioritizzati)

Legenda: SYN-ID | titolo | fonti capitolari | evidence/judgment sintesi | post/rollback nella DAG impl.

### P0 (bloccanti per claim di affidabilità/copertura/scoperta)

- **SYN-P0-1 Copertura MIRROR 115/149: presenza ≠ comportamento.**
  Fonti: test E01 (34 REAL/115 MIRROR, 0.95/0.85) + E04 (e2e 719 righe 6 scenari REAL, 0.95/0.85) + toolchain script partial (test-all mai eseguito, 0.7/0.7). Sintesi: il punto forte REAL (orchestrator core, ticket-engine fresh-reopen, plan-gate, TEST 4-6 negativi) è reale ma minoritario; la maggioranza simula. Non duplicare il conteggio altrove: unico SYN per quota REAL. evidence 0.95 / judgment 0.9 (motivo: grep+header verbatim convergenti; intensità import non pesata). DAG: IMP-2. Limiti: grep non distingue forza asserzioni; nessun test eseguito in alcun capitolo.
- **SYN-P0-2 Playbook behaviorale zero (31 playbook + 57 ruoli solo lint/unit).**
  Fonti: test §1.D + E07 (lint-playbooks stesso parser runtime ma solo presenza, 0.92/0.85) + manifest limitations (fasi non inventariate). Sintesi: lint verde 31/31 (toolchain 0.9/0.8) non implica flusso eseguibile. evidence 0.9 / judgment 0.85. DAG: IMP-2 (behavioral matrix 5 playbook). Limiti: contenuto fasi mai letto integralmente.
- **SYN-P0-3 Telemetria mancante: latenze/token/round-duration/duplicati/outage solo unknown.**
  Fonti: automation §5 gap + §9 P0 (0.9/0.85) + toolchain ledger token UNKNOWN + manifest pinned-model unknown. Sintesi: nessun claim "affidabile/risparmio" senza baseline (regola delegation-efficiency rispettata da tutti). evidence 0.9 / judgment 0.9. DAG: IMP-0. Limiti: run live mai eseguito per mandato.
- **SYN-P0-4 Scoperta rotta: `start/schedule/cron` help vuoti/rotti + doppio `architect`.**
  Fonti: product E03 (start 1 riga, 0.9/0.85) + E04 (schedule/cron vuoti, 0.9/0.8) + E06 (architect×2, 0.9/0.8) + toolchain fallback schedule/cron. Sintesi: l'utente non distingue i due scheduler né avvia Herdr da CLI. evidence 0.92 / judgment 0.85. DAG: IMP-7. Limiti: impatto uso reale non misurato (euristica).
- **SYN-P0-5 Stall-predicate unico già estratto; finalize/orphan ancora divergenti.**
  Fonti: automation A3+E-RT+§6.1 (0.9/0.85) + architecture R2 (0.9/0.8). Sintesi: successo parziale da estendere, non da rifare. evidence 0.9 / judgment 0.85. DAG: IMP-1→IMP-4. Limiti: semantica wake/race non osservata live.

### P1 (attrito operativo / rischi architetturali / gap comando)

- **SYN-P1-1 Comandi senza test dedicato: `uninstall` (0 ref), `frontend-dash` (0 file, ≠ `dash` testato), `leave` (0 file).**
  Fonti: test E06 (ls certo, grep sovrastima, 0.9/0.85) + toolchain CLI ready per binario ma non per comportamento. evidence 0.9 / judgment 0.85. DAG: IMP-3. Limiti: `frontend-dash` proxy 10000-10999 vs gantt 10000-19999 collisione solo statica (product G8).
- **SYN-P1-2 Scheduler/cron/services/feedback-API/trace-semantico solo MIRROR + fake Herdr/bin.**
  Fonti: test §1.F/G (solo yano-dash child-process reale + agent-memory-lessons reale) + automation A7/A8/A12 + E-RT-1. evidence 0.88 / judgment 0.82. DAG: IMP-2/IMP-3/IMP-10. Limiti: regression duplicate-fire citata ma non eseguita.
- **SYN-P1-3 Hotspot attivi: orchestrator.ts 3182 (27/50 commit), watch-stalls 1635, watcher-registry 1490, architect 1265 + 3 file >880.**
  Fonti: architecture E1/E13 (0.98/0.9, 0.9/0.85) + F4. evidence 0.95 / judgment 0.88. DAG: IMP-4→IMP-6 (storage escluso, R6). Limiti: churn ≠ difetto; coesione da nomi+size non da AST.
- **SYN-P1-4 Coupling sano (fan-in→scripts, mai inverso; tools-layer media ~240) + storage estratto come precedente.**
  Fonti: architecture F2/F3/E3/E9/E15 (0.9/0.85). Sintesi positiva: base per split meccanici. evidence 0.9 / judgment 0.85. DAG: abilita IMP-4..6. Limiti: grep testuale, import dinamici non cercati; direzione inversa "da confermare con grep inverso" (handoff arch) — resto unknown.
- **SYN-P1-5 Stato gerarchico corretto (SQLite verità, MQTT effimero QoS0 non-retained, fencing assignment/generation/UNIQUE) ma enforcement-race unknown.**
  Fonti: architecture F6/E7 (0.9/0.8) + automation E-ID-1 (0.92/0.87) + §7. evidence 0.91 / judgment 0.83. DAG: IMP-0 (misura) + IMP-3 (fault-injection). Limiti: transazioni/race/carico mai provati; `seenAssignments` pruning unverified (D6, 0.7/0.6) + `process.exit`×5 non mappati.
- **SYN-P1-6 MQTT resilienza progettata (reconnect 2s, LWT offline, clean+resubscribe, shutdown esplicito) ma mai provata live; broker TCP REACHABLE ≠ routing verificato.**
  Fonti: architecture F7/E6/E11 (0.85/0.7, 0.9/0.8) + toolchain TCP socket (0.6/0.6) + automation FM-1/FM-2/FM-8. Sintesi dedup: un solo SYN per "broker". evidence 0.85 / judgment 0.72. DAG: IMP-10. Limiti: mandato read-only; stale-sweep/LWT-race unknown dinamici.
- **SYN-P1-7 Toolchain: CLI core ready, 3 binari unready (helm/postman/semgrep), kubectl partial, MCP tutti unknown/partial, scripts partial, topology unknown.**
  Fonti: toolchain CLI matrix 1-15 + MCP matrix + script/playbook matrix + missing-prereq 1-6 + fallback per capitolo. evidence 0.88 / judgment 0.8 (media pesata; singoli in capitolo). DAG: IMP-9 (decisioni) prima di sbloccare e2e/browser/deploy/SAST/handshake. Limiti: `yano mcp`/`doctor` riflettono progetto corrente non solo target; playwright/ollama solo per delega doctor D1.
- **SYN-P1-8 Error-path best-effort documentati + lease fail-closed corretto; rischio fallback-silenziosi config.**
  Fonti: architecture F5 (64 try/68 catch, 0.9/0.75) + automation FM-8/FM-12. evidence 0.88 / judgment 0.75. DAG: IMP-0 (contatore `broker_timeout_total`) + verifica log livello (10 min follow-up). Limiti: campione catch non esaustivo.
- **SYN-P1-9 Tre GUI curate ma separate (Gantt migliore, feedback REST, frontend proxy) + status/fleet/logs utili ma grezzi.**
  Fonti: product E07 (0.85/0.75) + E09 (0.85/0.7) + §5. evidence 0.85 / judgment 0.75. DAG: IMP-8 (dashboard unificata). Limiti: solo `head`, nessun server/browser live.
- **SYN-P1-10 Onboarding abbondante non progressivo (580+498+41+35) + lingua mista IT/EN.**
  Fonti: product E02/E08/E10 (0.98/0.95, 0.92/0.7, 0.9/0.8) + I5/I7. evidence 0.9 / judgment 0.72. DAG: IMP-8 (split 5'/30'/power + indice per-obiettivo + scelta lingua CLI). Limiti: qualità riga-per-riga demandata a docs-sync.

### P2 (adozione / debito / ipotesi)

- **SYN-P2-1 Persistenza solo reopen pulito (28 file marker); mancano SIGKILL/broker-drop/SQLite-locked/disco-pieno.**
  Fonti: test E05 (0.9/0.8) + automation FM-9/FM-10. evidence 0.88 / judgment 0.8. DAG: IMP-3.
- **SYN-P2-2 Routing reale multi-istanza solo e2e TEST 6 + coordination; planner-tab/presence-warning/vision-audit solo mirror; hop-limit/new_round e fire-and-forget con recovery codificata ma race non misurati.**
  Fonti: test P2-G7 + automation E-DEL-1/E-DEL-2/E-AWAIT-1 + FM-3/FM-4/FM-5. evidence 0.9 / judgment 0.82. DAG: IMP-10 (smoke in CI) + IMP-11 (hop-lint/fail-fast flag). Limiti: latenza/ordine wake-vs-get non misurati.
- **SYN-P2-3 Dipendenze runtime minime (mqtt+yaml, lockfile) ma strip-types sperimentale + git-sincrono caldo + CLI esterni (herdr 133/pi 91/docker 22) + segreti staticamente sani/live unknown.**
  Fonti: architecture D1-D5 (0.95/0.9, 0.9/0.8, 0.85/0.7). evidence 0.88 / judgment 0.78. DAG: IMP-9 (pin Node CI) + profilazione event-loop (non qui). Limiti: vulnerabilità = capitolo dipendenze; permessi/log-leak unknown.
- **SYN-P2-4 UX adozione: help piatto 42 voci, alias opachi, porte sovrapposte, changelog non linkato, Gantt senza deep-link/export.**
  Fonti: product G3/G4/G6/G8/G9 + I4/I6/I8 + §6 P2. evidence 0.8 / judgment 0.7. DAG: IMP-8.
- **SYN-P2-5 Ipotesi mercato/concorrenti (H1-H4 prodotto): differenziale reale (worktree/DAG-SQLite/watchdog/closing-checklist/trace) ma raccontato da maintainer; scommessa home-locale.**
  Fonti: product §7 (ipotesi, non verificate read-only). Sintesi: tenere come ipotesi, non come finding. evidence 0.4 / judgment 0.5 (motivo: nessun confronto web/uso live eseguito). DAG: fuori perimetro (capitolo mercato dedicato se richiesto). Limiti: serve rete + telemetry utente (tempo-to-first-run, SUS).

---

## 3. Contraddizioni esplicite (mantenute, non risolte qui)

- **C1 Potenza vs adozione.** Architecture/test chiedono più copertura/strumenti (gate quota REAL, contatori, behavioral matrix); product avverte che più superficie = meno adozione e propone ridurre la superficie percepita (gruppi, dashboard unica) prima di aggiungere comandi. Risoluzione demandata al planner: IMP-2/IMP-0 (misura) prima di nuovi comandi; IMP-7/IMP-8 (riduzione percepita) in parallelo. Source: product §11 + test §5.6 + automation OP-2.
- **C2 Fail-open vs fail-closed.** Watcher heartbeat missing→publish (fail-open, duplicato preferito a miss, FM-1/FM-6) vs lease identità duplicata→throw (fail-closed, F5) vs auto-terminate OFF default (FM-10, solo notifica). Non è incoerenza: policy diverse per dominio (osservabilità vs identità vs distruzione). Non unificare senza policy per-run. Source: automation §6.2 + architecture F5.
- **C3 Statico-verde vs dinamico-unknown.** lint 31/31 + docs-check 8/8 + doctor 27/30 ok (toolchain ready) convivono con e2e mai eseguito + handshake mai fatto + routing mai osservato. Sintesi: "ready" toolchain = pronto-a-provare, non funzionante-provato. Vietato citare un ready senza il suo limite. Source: toolchain chapter + manifest boundary.
- **C4 Gantt nome vs funzione.** "Gantt" promette pianificazione, mostra attività/storia onesta ("non confermato", "ultima evidenza") — punto di forza epistemico ma gap di editing/deep-link. Tenere l'onestà, rinominare o aggiungere vista "cosa mi aspetta". Source: product §5.
- **C5 Leak intenzionale vs accidentale (F1).** Header dichiara transport-only ma `activate()` contiene policy (guard/plan-gate/reconcile). Sintesi: verticale intenzionale documentata (§910-931 "first vertical slice") in attesa di split, non incidente — ma il debito resta (IMP-6). Source: architecture F1-F3.
- **C6 Doppio scheduler.** `schedule` (script-first deterministico) vs `cron` (CRUD NL + supervisore) sono entrambi legittimi tecnicamente (automation A7) ma indistinguibili umanamente (product I1, help vuoti). Non eliminare uno: documentare la frase distintiva (IMP-7) poi misurare uso (IMP-0) prima di unificare.
- **C7 `yano mcp`/`doctor` progetto-corrente vs target.** I FAIL MCP (3 voci mancanti in `yano-local-pc/.mcp.json`) e la lista apple-*/evolution-api appartengono al progetto corrente, non provano nulla sul target. Ogni riuso deve mantenere la distinzione (toolchain limiti). Source: toolchain MCP matrix + limiti.
- **C8 Italiano vs inglese.** Help IT + README EN + errori misti: naturale per maintainer IT, frizione per adozione esterna. Decisione esplicita richiesta (IMP-8), non fix silenzioso. Source: product I7/G7.

---

## 4. Resource ledger (sintesi: costo probe vs costo inferenza)

Probe sintesi (tutti read-only, bounded):
1. `ls docs/reports/` → conferma 6 file presenti (manifest + 5 capitoli prima di scrivere). exit 0.
2. Rilettura integrale 5 capitoli + manifest JSON (contenuti in contesto; nessun `node`/`docker`/`broker`/`pi-spawn` eseguito in sintesi).
3. Nessuna scrittura fuori da questo file; nessun `git` mutante; nessun test eseguito (mandato + boundary manifest `requires_broker_herdr_credentials`).

Costi per capitolo (riportati, non rieseguiti):
- toolchain: ~19 comandi + ~25 file, budget playbook 180/500/80min/22000token rispettato; token puntuale UNKNOWN.
- test: grep/ls/head/wc su 149 smoke + 28 test + e2e 719 righe; nessuna esecuzione.
- architecture: E1-E15 (`wc/grep/head/cat/ls/git log/check-syntax`); 9565 righe lette in automazione;Circa: orchestrator 3182, agents 783, watch-stalls 1635, storage 1258, scheduler 769, launch-planner 886.
- automation: ~8 comandi + 5 read header (80 righe); nessun `node` oltre version/rev-parse.
- product: help/ls/head/wc/grep (~15 comandi); measurements {help 42, scripts 18, README 580, quick-start 498, guide 41, cheat 35, gantt 16.9/13.6KB, doctor ~35, fleet 8, logs 10}.

Measurements sintesi: {input_files: 6, output_files: 1, live_probes: 0, code_mutations: 0}.
Model: `llmproxy` via `PI_MODEL`/`PI_PROVIDER` env; pinned provider:model name unknown (come manifest + tutti i capitoli — limite env noto, impatto: nessun breakdown token; azione IMP-9d).
Budget: nessun comando mutante; inferenza LLM non quantificabile (telemetria provider non esposta — marcato unknown per contratto, mai stimato).

---

## 5. Evidenze di sintesi (source_reference ai capitoli + doppia confidence + limiti)

- SYN-E1 — source_reference: toolchain §CLI-matrix 1-15 + §MCP-matrix + §Script+playbook-matrix + §Missing-prereq 1-6. Expected: readiness per capitolo. Observed: core ready, 3 unready, kubectl partial, MCP unknown, scripts partial, topology unknown. evidence 0.88 / judgment 0.8 (motivo: probe D0 reali + doctor D1 + giudizio suitability AI dichiarato). Limiti: MCP/handshake/test-pass-fail/kubectl-version/token unknown; distinzione progetto-corrente/target.
- SYN-E2 — source_reference: test §1.A-H + §2 conteggi + E01-E08. Expected: use-case→test mapping. Observed: REAL 34 / MIRROR 115, e2e 6 REAL, vitest 28/4541 righe, gap P0-G1/G2 P1-G3..G5 P2-G6..G8. evidence 0.93 / judgment 0.85. Limiti: grep-import ≠ forza asserzioni; `fail` sovrastima negativi; nessun test eseguito.
- SYN-E3 — source_reference: architecture §1 F1-F8 + §2 R1-R6 + §3 D1-D6 + E1-E15. Expected: boundary/coupling/stato/resilienza/refactor-seam. Observed: leak intenzionale, fan-in sano, storage precedente, hotspot + churn, best-effort + fail-closed lease, SQLite-verità/MQTT-effimero, resilienza progettata-non-provata, dispatcher sottile. evidence 0.9 / judgment 0.82. Limiti: statico, no AST/dinamico; D6 + exit×5 non mappati; inversa scripts→extensions da confermare.
- SYN-E4 — source_reference: automation §2 A1-A12 + §3 E-DEL + §4 retry/timeout + §6 FM-1..12 + §7 E-ID-1 + §8 OP-1..6. Expected: trigger/code/deleghe/retry/idempotenza/recovery. Observed: doppia vigilanza A1/A2 + predicate canonico A3 + gate A4; hop 24/timeout 30min/wake; scheduler bounded+dedupe; storage UNIQUE/generation/checksum. evidence 0.91 / judgment 0.85. Limiti: nessun invio/tick live; race/ordine/latenze non misurati; redact.ts/review-log non ispezionati.
- SYN-E5 — source_reference: product §2 FATTI + §3 INFERENZE I1-I8 + §4 G1-G9 + §5 GUI + §6 P0-P2 + E01-E10. Expected: valutazione umana comandi/GUI/gap/concorrenti. Observed: 42 voci piatte, help due-velocità, doctor migliore pattern, 3 GUI curate-separate, onboarding abbondante-non-progressivo, IT/EN misto. evidence 0.88 / judgment 0.75. Limiti: GUI da statico; mercato H1-H4 ipotesi; nessuna misura utente reale; completion non verificata.
- SYN-E6 — source_reference: manifest `boundary_capability_index` + `command_inventory` + `test_inventory` + `limitations`. Expected: boundary read-only vs credenziali. Observed: rispettato da tutti i capitoli (nessuno spawn/install/secret). evidence 0.95 / judgment 0.9. Limiti: pinned model unknown; fasi playbook non inventariate.

---

## 6. Handoff al planner / refactor-planner

1. Decisioni gated subito (IMP-9): kubectl-retry, handshake MCP, install helm/semgrep/postman vs fallback, breakdown token. Senza queste, i capitoli live restano BLOCKED espliciti (non tentare live di nascosto).
2. Ordine: IMP-9 → IMP-0 + IMP-7 paralleli → IMP-1 + IMP-10 → IMP-2 → IMP-3 → IMP-4 → IMP-5 → IMP-6; IMP-8 dopo IMP-7; IMP-11 ultimo.
3. Gate sintesi: (a) mai citare ready senza limite; (b) mai stimare token/latenze/risparmi senza baseline (OP-2 prima); (c) implementation DAG ≠ audit DAG nei report CI; (d) ogni nodo IMP con postcondition verificabile + rollback + smoke dopo.
4. Follow-up da 10 minuti lasciati aperti (non fatti per budget): potatura `seenAssignments` (D6), livello log fallback-silenziosi config (F5), grep inverso scripts→extensions (F2), `process.exit`×5 mapping, shell-completion probe (G2 prodotto).
5. File: questo è l'unico artefatto scritto; codice non mutato; altri ticket non toccati; remediation non avviata.

## 7. Limiti globali, documenti, verifiche

- Limiti: nessuna esecuzione live/test/broker/Herdr/spawn/scheduler-tick/watcher-loop/GUI-server/browser; nessun handshake MCP; nessuna credenziale toccata; nessun conteggio rifatto oltre conferma `ls`; pinned model unknown; `yano mcp`/`doctor`/`fleet`/`logs` con dati transitori campagna.
- Documenti consultati: i 6 artefatti elencati in testa (nessun altro file letto per regola no-duplicate-reading, salvo `ls` conferma).
- File analizzati: nessuno oltre i 6 (misure e righe citate via source_reference capitolare, non riletture).
- Approfondimenti aggiuntivi: nessuno oltre perimetro.
- Non verificato: handshake MCP, pass/fail test, routing MQTT, kubectl versione, token accounting, semantica playbook fasi, potatura map, exit mapping, completion, mercato/concorrenti, misure utente.
- Verifiche rieseguite in sintesi: `ls docs/reports/` (6 file presenti) — sola verifica diretta; tutto il resto è citazione capitolare con doppia confidenza.
