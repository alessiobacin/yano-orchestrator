# ARCHITECTURE — audit-campaign deep (16-09)

- target: `/Users/alessiobacin/Development/testCode/yano-orchestrator` (v1.6.2, HEAD `faed4ad`)
- ticket: `01M2MB71JP0XCNSXZB7B6QV35W` · run `01M2MB2JEWW0DF9F9GS5SVQ4RW`
- manifest: `docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json` (letto per primo, nessuna discovery rifatta)
- mandato: READ-ONLY sul codice; unico artefatto scritto = questo file
- metodo: evidenze statiche (`wc`, `grep`, letture mirate header/sezioni). Nessuna esecuzione mutante, nessun broker/Herdr live, nessun test eseguito.

---

## 1. architecture-findings

### F1 — orchestrator.ts: boundary dichiarato vs contenuto reale (LEAK parziale, ma onesto)
- Dichiarato (header righe 1–45): solo transport + identity + presence + pub/sub; esplicitamente NON scheduler/DAG/router/budget/TLS.
- Reale: file da **3182 righe**, `export default activate()` da riga **1161 a 3182** (~2020 righe di closure). Dentro ci sono: flag/config, prompt assembly (~160 righe `loadRolePrompt`), workspace bootstrap, reconcile SQLite↔presence (`yanoReconcilePersistedState`, `yanoFindUnfinalizedRuns`, `yanoFindOrphanedTickets`), lifecycle MQTT, 12 `registerTool` (che assemblano ~40+ tool logici via factory `create*Tools`), widget/footer, watchdog sweep wiring, shutdown.
- Giudizio: il leak è **politica di orchestrazione dentro il transport** (guard, plan-gate, reconcile orfani). Il file però lo dichiara nei commenti (§910–931: "first vertical slice ticket/DAG/SQLite"). Non è architettura accidentale: è verticale intenzionale in attesa di split (lo storage è già stato estratto — vedi F3).
- Confidenze: evidenza 0.95 / giudizio 0.8.

### F2 — Direzione del coupling: fan-in alto, fan-out disciplinato
- `extensions/orchestrator.ts` importa **39 moduli scripts** (26 path distinti): 12 factory `orchestrator-tools/*`, watcher (`detect-stalled-tickets`, `heartbeat`, `watchdog-sweep`, `user-wait`), trace, feedback, model/vision routing, memory, rules, api-registry, notifications, terminal-integration.
- **Direzione sana**: le dipendenze vanno orchestrator → scripts, mai il contrario (verificato: nessun import di `extensions/` da `scripts/` — da confermare con grep inverso nel capitolo sintesi se serve).
- Cross-import tra `scripts/orchestrator-tools/*`: **basso** — 9× `yano-orchestrator-storage.ts` (solo tipi/interfaccia) + pochi shared (`playbook-loader`, `yano-api-registry`, `yano-trace-storage`, `yano-feedback`). I tool-module sono sibling isolati dietro factory `create*Tools`.
- Interfaccia `OrchestratorStorage`: il codice tool parla all'interfaccia, mai a SQL grezzo (dichiarato nell'header di `yano-orchestrator-storage.ts`). Se vero su tutto il flusso, il backend è swappabile.
- Confidenze: evidenza 0.9 / giudizio 0.85.

### F3 — Estrazione storage già avvenuta = precedente di refactor riuscito
- `scripts/yano-orchestrator-storage.ts` (1258 righe) estratto "meccanicamente (zero logic change)" da `orchestrator.ts`; header documenta il criterio: zero riferimenti a `identity`/`pi`/`ctx`/`mqttClient`. Verificato caricabile sia da orchestrator sia da Vitest via `--experimental-strip-types`.
- Questo fissa il **pattern per gli split futuri** (R1): estrarre solo regioni senza riferimenti a identity/pi/client.
- Confidenze: evidenza 0.9 / giudizio 0.85.

### F4 — File enormi: classifica main-tree (worktree esclusi)
| file | righe | ruolo |
|---|---|---|
| extensions/orchestrator.ts | 3182 | transport+policy (hotspot) |
| scripts/watch-stalls.mjs | 1635 | watcher CLI zero-token |
| scripts/yano-watcher-registry.mjs | 1490 | watcher registry |
| scripts/yano-architect.mjs | 1265 | architect provisioning |
| scripts/yano-orchestrator-storage.ts | 1258 | SQLite layer (estratto) |
| scripts/yano-repair.mjs | 1098 | repair/reconcile |
| scripts/yano-auto-improver.mjs | 923 | audit read-only |
| scripts/launch-planner.mjs | 886 | spawn ruoli |
| scripts/yano-trace-index.mjs | 881 | semantic index (ollama at query) |
| scripts/orchestrator-tools/agents.ts | 783 | tool agenti (più grande dei tool-module) |
| scripts/yano-scheduler.mjs | 769 | job ricorrenti |
| scripts/yano-recovery.mjs | 712 | snapshot/restore |
| scripts/doctor.mjs | 711 | prereq check |
| scripts/orchestrator-tools/worktree.ts | 653 | worktree tools |
| orchestrator-tools totale (17 moduli) | 4101 | layer tool (media ~240/modulo, sana) |
| trace totale (4 file) | 1891 | CLI+storage+index+timeline |
| watcher core (5 file) | 3766 | detection+sweep+heartbeat+health+registry |
- Soglia: oltre ~800 righe il file merita seam review; oltre ~1200 è hotspot. Hotspot confermati: orchestrator.ts, watch-stalls, watcher-registry, architect, storage (ma questo è layer coeso).
- Churn: `orchestrator.ts` toccato in **27/50 commit recenti** — hotspot attivo, non legacy fermo.
- Confidenze: evidenza 0.98 / giudizio 0.9.

### F5 — Error path: molti, stratificati, in prevalenza best-effort documentati
- 64 `try` / 68 `catch` in orchestrator.ts. Campione: config malformata → fallback a flag (r.395–396); `JSON.stringify` → 0 (r.504); trace failure → mai rompere orchestrazione (r.1475–1477); footer diagnostics advisory (r.1400); lease lock con `process.kill(pid,0)` + throw se identità duplicata (r.1258–1260 — **fail-closed corretto**).
- `process.exit` ×5 (posizioni da mappare nel capitolo test/sicurezza; non lette nel dettaglio qui).
- Rischio residuo: i fallback silenziosi su config malformata possono mascherare misconfigurazioni (log? livello? — unknown statico, da verificare con lettura mirata o smoke).
- Confidenze: evidenza 0.9 / giudizio 0.75.

### F6 — Stato: gerarchia chiara, una sola source of truth per dominio
- SQLite `orchestrator.db` = verità per run/ticket/DAG (commento r.461–465, 918–921, 2672–2673).
- MQTT retained = solo roster presenza effimera (QoS1, LWT `offline`, stale-sweep ~45s, prune client-side).
- Eventi MQTT = QoS0 **non retained** by design: chi si (ri)connette legge SQLite, mai replay (r.461–465). Corretto.
- Assignment fencing: `assignment_id` + `seenAssignments` Map per dedup redelivery QoS1 (r.1277). Transazioni SQLite e retry full-crash con fencing citati nei commenti (r.931) — **implementazione da verificare nel capitolo test**, non assunta qui.
- Shared mutable in `activate()`: ~10 contenitori (`presence`, `pendingReplies`, `inboundQueue`, `seenAssignments`, `activeOperations`, timer, storage, revision, publish-chain, hydration-promise, flags mqtt). Single-thread Node, ma interleave async: la `presencePublishChain` serializza le publish (buono). Da verificare: cap su `seenAssignments` (leak memoria se mai potato — `staleSweepTimer` esiste, copertura unknown).
- Confidenze: evidenza 0.9 / giudizio 0.8.

### F7 — MQTT resilience: progettata, non verificabile live qui
- `reconnectPeriod: 2000`, LWT retained `offline`, `clean:true` con resubscribe a ogni riconnessione, distinzione `everConnected` connecting/reconnecting nel widget, shutdown pulito che pubblica `offline` esplicito invece di affidarsi al LWT (r.3141–3145).
- Limite: nessuna prova live (mandato read-only, broker mai avviato). Stale-sweep e LWT race in caso di crash restano **unknown dinamici**.
- Confidenze: evidenza 0.85 / giudizio 0.7.

### F8 — bin/yano.mjs: dispatcher sottile, rischio drift commenti
- 450 righe, ~35 import `run*` da scripts, header di 43 righe che mappa comandi→script. Sano; rischio solo documentale (header vs registrazioni effettive).
- Confidenze: evidenza 0.9 / giudizio 0.85.

---

## 2. refactor-candidates (ordinati per valore/rischio, tutti behavior-preserving)

### R1 — Spacchettare `activate()` per regioni senza riferimenti a identity/pi/client (precedente: storage)
- Regioni: flag/config (606–680), prompt assembly (680–960), workspace (987–1087), reconcile helpers (1062–1160, già top-level: candidati a `scripts/orchestrator-lifecycle/reconcile.ts`), MQTT connect/subscribe (2180–2330), tool assembly (2600–2950), widget (2560–2620), shutdown (3130–3182).
- Criterio di estrazione: stesso dello storage (zero ref a identity/pi/ctx/mqttClient). Le factory `create*Tools` sono già fuori; resta da estrarre il **wiring**, non la logica.
- Test richiesti: `check-syntax` + smoke presence/send esistenti + `test-all.mjs` (esecuzione = capitolo test).
- Confidenze: evidenza 0.9 / giudizio 0.8.

### R2 — Consolidare stall-detection su un core (duplicazione reale)
- Oggi: `watch-stalls.mjs` (1635) + `watchdog-sweep.ts` (386) + `detect-stalled-tickets.mjs` (46) + `heartbeat.mjs` (57) + `planner-health.mjs` (152) + `yano-watcher-registry.mjs` (1490). `orchestrator.ts` importa già `detectStalledTickets` come core condiviso.
- Proposta: core = `detect-stalled-tickets.mjs`; `watchdog-sweep.ts` = sweep in-process; `watch-stalls.mjs` = thin CLI wrapper; registry = solo stato/config watcher. Nessuna nuova logica, solo spostamento + re-export.
- Confidenze: evidenza 0.9 / giudizio 0.8.

### R3 — Watcher-subsystem: separare detection / registry / CLI
- `yano-watcher-registry.mjs` (1490) è il secondo file più grande; con `project-runs.mjs` e `yano-watcher-findings.mjs` forma un sottosistema da ~2500+ righe con test dedicati (`watcher/*.test.mjs` ×8). Seam naturale già riflessa nei test.
- Confidenze: evidenza 0.85 / giudizio 0.75.

### R4 — Trace: separare index (dipendenza pesante) da storage/CLI
- `yano-trace-index.mjs` (881, richiede ollama at query) vs storage (471) + CLI (450) + timeline (89). L'index è l'unico con dipendenza esterna pesante: seam = interfaccia index dietro `yano-trace-storage`.
- Confidenze: evidenza 0.85 / giudizio 0.8.

### R5 — `orchestrator-tools/agents.ts` (783): splittare send/activity/presence
- È il tool-module più grande (media layer ~240). Split interno per area, interfaccia factory invariata.
- `worktree.ts` (653) vs `git-worktree.ts` (134): chiarire/mergeare lo split (due moduli worktree confondono).
- Confidenze: evidenza 0.85 / giudizio 0.75.

### R6 — NON-refactor (deliberato)
- `yano-orchestrator-storage.ts` (1258): coeso, già estratto, con test. Non toccare.
- `bin/yano.mjs`: già sottile. Solo lint header-vs-registrazioni.
- Confidenze: evidenza 0.9 / giudizio 0.85.

---

## 3. dependency-risks

### D1 — Superficie runtime minima (positivo)
- Solo `mqtt ^5` + `yaml ^2.8`. Lockfile presente (`package-lock.json` 57KB). `engines: node >=22.5`. Nessuna dipendenza framework pesante.
- Confidenze: evidenza 0.95 / giudizio 0.9.

### D2 — `--experimental-strip-types` (rischio toolchain)
- Sia `orchestrator.ts` sia `yano-orchestrator-storage.ts` girano come `.ts` plain sotto strip-types; `check-syntax` lo valida (verificato OK qui, exit 0). Rischio: flag sperimentale, comportamento può cambiare tra minor Node. Mitigazione esistente: `check-syntax` in `test-all.mjs`. Da valutare pinning versione Node in CI (capitolo toolchain/test).
- Confidenze: evidenza 0.9 / giudizio 0.8.

### D3 — Broker singolo = SPOF (mitigato dal design)
- Un solo Mosquitto locale (dev: `127.0.0.1:1883` via compose; `mosquitto.conf` binda `0.0.0.0` **dentro** il container — loopback garantito dal port-mapping, documentato; `mosquitto.native.conf` binda `127.0.0.1`). `clean:true` = le sessioni non sopravvivono al disconnect; mitigato da resubscribe + SQLite come verità + QoS1/fencing. Nessun TLS/ACL di default — dichiarato esplicitamente fuori scope (header r.33). Per produzione: broker gestito + `mqtt-tls-*` flags (già esistenti, mai verificati live qui).
- Confidenze: evidenza 0.9 / giudizio 0.8.

### D4 — CLI esterni: herdr (133 ref), pi (91), docker (22), git, npx, gcloud, ollama
- Conteggio statico da `grep -ho` su orchestrator+scripts. Disponibilità live e fallback = capitolo toolchain (dichiarazioni in `capabilities.yaml`, non verificate qui).
- Rischio specifico: `execFileSync("git")` ×14 + `execFile("git")` ×5 — operazioni git sincrone nel percorso caldo possono bloccare l'event loop (da profilare, non assunto come problema).
- Confidenze: evidenza 0.85 / giudizio 0.7.

### D5 — Segreti: postura statica sana
- Nessun segreto hardcoded osservato; `mqtt-password` via flag, TLS via path file letti con `readFileSync`, API secrets via `resolveApiSecret` (registry). Redazione trace via `redactRuntimeProjection`. Gestione live dei segreti (permessi file, log-leak) = unknown, capitolo sicurezza.
- Confidenze: evidenza 0.85 / giudizio 0.7.

### D6 — Memoria `seenAssignments` senza cap visibile
- Dedup map `assignment_id → seenAt`; esiste `staleSweepTimer` ma la potatura di questa specifica map non è stata verificata. Se mai potata, crescita illimitata su istanze longeve (planner). **Da verificare con lettura mirata** (follow-up da 10 minuti, non fatto qui per budget).
- Confidenze: evidenza 0.7 / giudizio 0.6.

---

## 4. Evidenze (comando + exit + artifact + source + expected/observed + confidenze + limiti + resource)

| # | comando (exit) | artifact / source_reference | expected / observed | conf (evid/giud) | limiti |
|---|---|---|---|---|---|
| E1 | `find … -exec wc -l` main-tree, esclusi worktrees (exit 0) | top30 supra §F4; `extensions/orchestrator.ts:3182`, `scripts/watch-stalls.mjs:1635`, `scripts/yano-watcher-registry.mjs:1490` … | atteso hotspot su orchestrator / osservato + 6 file >880 righe, tools-layer media ~240 | 0.98 / 0.9 | statico; worktrees esclusi a mano (prima run contaminata da `.worktrees/`, scartata) |
| E2 | `head -n 100 extensions/orchestrator.ts` (exit 0) | header righe 1–45: boundary + tabella coms→orchestrator + NOT-implemented | atteso transport-only / osservato transport + slice ticket/DAG intenzionale | 0.95 / 0.8 | header = intenzione, non prova |
| E3 | `grep -E 'from "\.\./scripts' extensions/orchestrator.ts` (exit 0) | 39 import, 26 path distinti (12 factory tools + watcher + trace + …) | atteso accoppiamento stellare / osservato monodirezionale verso scripts | 0.9 / 0.85 | grep testuale, non AST; import dinamici non cercati |
| E4 | `grep -n "export default function\|registerTool" …` (exit 0) | `activate()` 1161→3182; 12 `registerTool` | atteso dispatcher sottile / osservato ~2020 righe di closure | 0.95 / 0.85 | spans via grep, non parser |
| E5 | `grep -c "try {"`=64, `"catch"`=68, `"process.exit"`=5 (exit 0) | campione `} catch` r.395,504,571,684,953,1258,1322,1400,1475… | attesi error path / osservati best-effort documentati + lease fail-closed | 0.9 / 0.75 | semantica dei catch da campione, non esaustiva |
| E6 | `grep -n "reconnect\|LWT\|will:\|keepalive" …` (exit 0) | `reconnectPeriod: 2000` (r.2196), `will:` offline retained (r.2198–2202), shutdown esplicito (r.3141–3145) | attesa resilienza base / osservata progettata e commentata | 0.85 / 0.7 | nessuna prova live |
| E7 | `grep -n "retain…\|SQLite\|assignment_id\|dedupe" …` (exit 0) | r.461–465 QoS0 non-retained; r.1277 `seenAssignments`; r.2666–2673 SQLite truth | attesa gerarchia stato / osservata e documentata | 0.9 / 0.8 | transazioni/race = unknown |
| E8 | `grep -n "let client\|new Map\|let .*Timer\|let .*Storage" …` (exit 0) | ~10 stati condivisi in closure (r.1272–1381) + `presencePublishChain` | atteso stato diffuso / osservato serializzato dove conta | 0.9 / 0.75 | interleaving async non modellato |
| E9 | `ls scripts/orchestrator-tools/ + watcher/; wc -l` (exit 0) | tools 4101 tot/17 moduli; watcher-core 3766/6 file; trace 1891/4 file | attesa frammentazione / osservati 3 sottosistemi coesi con seam chiare | 0.95 / 0.85 | coesione da nomi+size, non da grafo |
| E10 | `cat package.json` (exit 0) | deps `mqtt ^5, yaml ^2.8`; dev `typebox, vitest`; engines `node>=22.5` | attesa superficie ampia / osservata minima + lockfile | 0.95 / 0.9 | vulnerabilità = capitolo dipendenze |
| E11 | `cat mqtt/compose.yaml; grep listener mqtt/*.conf` (exit 0) | compose `127.0.0.1:1883`; container `0.0.0.0` (namespace) + commento; native `127.0.0.1` | attesa loopback / osservato loopback-via-mapping, documentato | 0.9 / 0.8 | traffico mai sniffato |
| E12 | `grep -hoE "herdr\|pi\|docker…" ` (exit 0) | herdr 133, pi 91, docker 22, git sync 14+5 | attesa dipendenze esterne / osservate e concentrate | 0.85 / 0.7 | conteggio testuale, non call-graph |
| E13 | `git log --name-only -50` (exit 0) | orchestrator.ts 27/50, package.json 15, watcher-registry 12 | atteso hotspot attivo / osservato | 0.9 / 0.85 | churn ≠ difetto |
| E14 | `node --experimental-strip-types scripts/check-syntax.mjs extensions/orchestrator.ts` (exit 0) | `OK … sintatticamente valido` | attesa validità / osservata | 0.95 / 0.9 | solo sintassi top-level, non tipi |
| E15 | `head -n 40 scripts/yano-orchestrator-storage.ts` (exit 0) | header estrazione meccanica + criterio zero-ref | attesa split riuscito / osservato documentato | 0.9 / 0.85 | "zero logic change" da header, non da diff |

- resource_record: comandi E1–E15 sopra, tutti read-only (`wc`, `grep`, `head`, `cat`, `ls`, `git log`, `check-syntax`); measurements nelle tabelle §F4/E1–E15; model `llmproxy` (pinned name unknown da env, come da manifest).
- Limiti globali: nessuna esecuzione live (broker/Herdr/pi spawn mai avviati); nessun test eseguito; nessun grafo dinamico/AST (no madge/tsc); segreti/TLS solo statici; `seenAssignments` pruning non verificato (D6); `process.exit` ×5 non mappati (passare a capitolo sicurezza/test).

---

## 5. Handoff al sintetizzatore

- Findings contendibili: F1 (leak intenzionale vs accidentale), F5-fallback-silenziosi (serve verifica log), D6 (potatura map — verifica da 10 min).
- Nessuna contraddizione col manifest: estende boundary-capability-index e entrypoints con misure e seam.
- Proposta DAG implementazione (per refactor-planner, non implementata qui): R2 (watcher-core) → R4 (trace-index) → R5 (agents.ts/worktree) → R1 (activate wiring) a fette meccaniche con `check-syntax` + smoke dopo ognuna; storage e bin esclusi.
