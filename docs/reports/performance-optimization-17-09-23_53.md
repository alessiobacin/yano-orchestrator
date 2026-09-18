# Round 3 (consolidato docs-sync) — performance-optimization-loop watcher CPU (2026-09-17)

- **Run**: 01M2RNKDAT36GT40A2VEVA1YSY
- **Playbook**: performance-optimization-loop
- **Ticket coder (Round 1)**: 01M2RNM89EPER6QRK7XJ2ZH0CA — coder-02
- **Ticket reviewer (Round 2)**: 01M2RNME4NSZX77RFDX77ZKCJH — reviewer-02
- **Ticket docs-sync (Round 3)**: 01M2RNMJWKKX334Z9H550ANQNA — docs-sync-01
- **Worktree candidate**: `.worktrees/watcher-cpu-opt` (branch `task/watcher-cpu-opt`)
- **Baseline-reference immutabile**: `4a2be2d` (mai modificata; snapshot `/tmp/yano-r1/scripts-base/`,
  harness isolato `/private/tmp/yano-r1/`)
- **Ipotesi round 1 (confermata review)**: finestra 60min + checkpoint dedup persistente
- **Data/ora misura**: 2026-09-17T23:14Z (campagne benchmark Round 1); verifica review 2026-09-17T23:36Z;
  consolidato docs-sync `docs/reports/performance-optimization-17-09-23_53.md`
- **Fonte dati**: Round 1 + Round 2 del report task
  (`.pi/extensions/yano-orchestrator/reports/watcher-cpu-opt.md` nel worktree) — consolidati qui,
  nessun numero reinventato.

## Baseline / candidate

- **Baseline**: `4a2be2d` — `scripts/watch-stalls.mjs` con default `--lookback-ms 86_400_000` (24h)
  e 3 full-scan storiche per passata (stall-route, context-route, compaction-completed).
- **Candidate** (SOLO nel worktree, mai in main):
  - `scripts/watch-stalls.mjs` (+97/−15): default `--lookback-ms` 86_400_000 → 3_600_000 (60min),
    usage aggiornata; checkpoint dedup persistente caricato a inizio passata e salvato best-effort
    a fine passata; seed del primo passaggio bit-identico alla baseline; a regime letture
    since-bound + union per passaggi concorrenti.
  - `scripts/watcher/notify-checkpoint.mjs` (+103, nuovo): `loadNotifyCheckpoint` /
    `saveNotifyCheckpoint` su `<traces>/<project-key>/notify-checkpoint.json` (atomico tmp+rename,
    dir 0700/file 0600, load-merge-write union mai clobber, cap 20k prune oldest-first,
    `seeded` solo se entrambi gli snapshot contesto+compaction completi; stallKeys salvati sempre).
- **Commit**: nessun commit in main; modifiche uncommitted nel worktree su `4a2be2d`
  (branch `task/watcher-cpu-opt`). Merge al planner su promozione esplicita.

## Benchmark prima/dopo (mediane, wall `real`, 3 run/lato, trace frozen byte-identici)

Harness `/private/tmp/yano-r1/`: `YANO_DATA_DIR` per-lato su copia frozen (membox 533M /
newmiodoc 2,3G / orchestrator 439M), reset cold-state da pristine prima di OGNI run cold,
broker morto, Telegram dry-run, ticket in fakerepo, DB SQLite live in sola lettura.

| progetto | baseline cold mediana | candidate cold mediana | Δ cold | candidate steady mediana | Δ steady vs baseline |
| --- | --- | --- | --- | --- | --- |
| membox | 5,04 s (5,15 / 4,79 / 5,04) | 5,32 s (4,77 / 6,55 / 5,32) | +5,6% (rumore I/O) | 2,02 s (2,02 / 2,79 / 1,10) | **−59,9%** |
| newmiodoc | 22,23 s (7,98 / 42,77 / 22,23) | 11,96 s (11,96 / 8,25 / 13,04) | −46,2% | 4,63 s (6,86 / 4,29 / 4,63) | **−79,2%** |
| orchestrator | 12,76 s (15,17 / 12,76 / 11,09) | 9,71 s (9,71 / 11,34 / 9,42) | −23,9% | 1,88 s (3,16 / 1,88 / 1,49) | **−85,3%** |

Mediane e Δ ricontrollati dal reviewer sui run grezzi: tutti esatti.
Lo steady-state (checkpoint attivo) è il caso operativo reale del watcher persistente (ogni 5min).
Il cold membox +5,6% è rumore I/O su run brevi, irrilevante a regime.

## Latenza

- Latenza per passata = wall `real` sopra: a regime 2,02 s / 4,63 s / 1,88 s
  contro 5,04 s / 22,23 s / 12,76 s di baseline (−60%/−79%/−85%).
- Profilazione read-only (2 round, frozen copy): le 3 full-scan dedup SENZA `since` dominavano
  la passata (1,7–5,1 s su alberi 0,5–2,4 GB); le 4 letture since-bound scendono 24h→60min
  (es. newmiodoc 1.713→598 ms, orchestrator 3.051→1.869 ms).

## Errori / equivalenza / oracle

- **Equivalenza dedup** (I1): seed checkpoint vs full-scan baseline sugli stessi dati —
  stall MISS=0/22 chiavi, ctx MISS=0/159 fingerprint, su tutti e 3 i progetti.
  Extra keys solo dal seed-run stesso (fail-open ammesso).
- **Oracle qualità** (zero stall persi + zero doppie notifiche): smoke verdi nel worktree —
  queue-wake 7/7, hijack 7/7, e2e-flow 8/8, scheduler-script-first 15/15.
  Riverificati dal reviewer con riesecuzione indipendente (non citati a fiducia).
- **Nota onesta drift DB**: newmiodoc baseline run 1 vedeva 1 stall, candidate 0 — ticket passato
  a `done` alle 11:27 tra le campagne (DB live per disegno, trace frozen). Non regressione.
- **Contesto/token**: `unknown` (modifica tempo-CPU). **Costo LLM**: +0% (nessuna chiamata aggiunta;
  1 file JSON <10 KB per progetto).

## Ipotesi con score e confidenze (audit-confidence-contract)

- **Ipotesi round 1 (finestra 60min + checkpoint dedup)** — score 9/10, evidence_confidence 9/10,
  judgment_confidence 9/10 (coder-02). Tre campagne indipendenti sullo stesso stato frozen: Δ −60/−85%
  a regime con equivalenza MISS=0; varianza residua solo rumore I/O cold.
- **Promozione immediata** — score 9/10, evidence_confidence 9/10, judgment_confidence 8/10 (coder-02;
  giudizio 8 perché il merge spetta a planner/reviewer).
- **Reviewer-02 (verifica indipendente)**: calcoli benchmark esatti, disegno checkpoint corretto
  (fail-open, atomico, union, cap 20k fail-open "notify once more", `seeded` solo a seed completo,
  stall-route/context-route solo da questo watcher, compaction da altri processi via since-bound).
  Nessun puntuale bloccante. Verdetto: **APPROVATO — promuovi (`promote_large_gain`)**.

## Modifica esatta

1. `scripts/watch-stalls.mjs` — import `loadNotifyCheckpoint, saveNotifyCheckpoint`;
   `parseArgs` default `lookbackMs: 86_400_000` → `3_600_000` con commento motivato
   (allineato a `DEFAULT_LOOKBACK_MS = 3600000` in `scripts/yano-watcher-registry.mjs:75`;
   override `--lookback-ms` invariato); `watchUsage` riga lookback con `(default 3600000 = 60min)`;
   `runWatch`: load checkpoint + `notifySince`, seed full-scan solo al primo passaggio,
   a regime since-bound + union concorrenti, persist best-effort mai bloccante a fine passata.
2. `scripts/watcher/notify-checkpoint.mjs` (nuovo, +103) — persistenza
   `<traces>/<project-key>/notify-checkpoint.json` come sopra.
3. Docs-sync (questo round): `docs/cheat-sheet/25-watcher.md` + `docs/quick-guides/10-watcher-falle-yano.md`
   allineate a lookback default 60min + checkpoint per-progetto best-effort fail-open
   (nota non bloccante del reviewer); questo report consolidato.

## Test

- `npm run check-syntax` → OK (coder + reviewer rieseguito).
- `npm run check:docs` → passed (coder: 9 superfici; reviewer: rieseguito passed; docs-sync: riverificato).
- Smoke nel worktree contro candidate (reviewer rieseguiti): queue-wake 7 passed, hijack 7 passed,
  e2e-flow 8 passed, scheduler-script-first 15 passed.
- Sanity modulo checkpoint (reviewer): `loadNotifyCheckpoint` su path inesistente → null;
  path per-progetto sotto traces/ OK (file probe rimosso subito dopo).
- Benchmark harness NON rieseguito dal reviewer (18 run cold+steady fuori budget review) —
  verifica aritmetica completa sui run grezzi del Round 1.

## Decisione: PROMOZIONE

**`promote_large_gain` — reviewer APPROVATO.** Δ steady-state ≫ soglia 3% su tutti e 3 i progetti
(−59,9%/−79,2%/−85,3%) + oracle verdi + equivalenza dimostrata. Il merge in main resta al planner
su promozione esplicita (già data per questo task; merge eseguito dal planner, non da questo round).

## Contatori loop aggiornati

- **Stagnazione (≤1%)**: 0/5 — **Plateau (>1% e <3%)**: 0/3
- **Promozioni (questo loop)**: 1 proposta (`promote_large_gain`, reviewer APPROVATO) —
  reference baseline resta `4a2be2d` finché il planner non promuove con merge.

## Rischio residuo

- Cold membox +5,6%: rumore I/O su run brevi, assente steady-state; nessun impatto operativo.
- DB live in harness (drift `done` 11:27): per disegno; trace frozen garantiscono il confronto.
- Checkpoint best-effort per-progetto: assente/corroso/version-mismatch → fallback full-scan baseline
  (fail-open); cap 20k → dedup antiche fallisce in "notify once more", mai in silenzio perso.
- Passaggi concorrenti: union load-merge-write, mai clobber; compaction da altri processi coperta
  da lettura since-bound, non dal solo checkpoint.
- Permessi file 0600/dir 0700: nessun segreto dentro (solo chiavi route + record compaction già nel trace).

## Prossimo round

Round successivo (dopo merge): nuova ipotesi di bottleneck misurabile — candidati: typed fast-path
sui filtri `signal`, oppure batching delle 4 letture since-bound in un'unica passata con
ripartizione in memoria; selezione in `bottleneck_selected`. Concurrency dedicata: skip motivato
per questo round (union + best-effort + trace append-only intoccato).
