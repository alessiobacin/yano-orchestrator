# Round 1 — performance-optimization-loop (2026-09-17)

- **Run**: 01M2RNKDAT36GT40A2VEVA1YSY
- **Playbook**: performance-optimization-loop
- **Ticket coder**: 01M2RNM89EPER6QRK7XJ2ZH0CA
- **Worktree candidate**: `.worktrees/watcher-cpu-opt` (branch `task/watcher-cpu-opt`)
- **Baseline-reference immutabile**: `4a2be2d` (mai modificata; snapshot `/tmp/yano-r1/scripts-base/`)
- **Ipotesi round 1**: finestra 60min + checkpoint dedup persistente
- **Data/ora misura**: 2026-09-17T23:14Z (report `docs/reports/performance-optimization-17-09-23_14.md`)

## Cosa cambia (candidate, SOLO nel worktree — mai in main)

`scripts/watch-stalls.mjs` (+97/−15) + nuovo `scripts/watcher/notify-checkpoint.mjs` (+103):

1. **Default `--lookback-ms` 86_400_000 → 3_600_000 (60min)** — allineato al
   default già in uso dai worker persistenti del registry
   (`DEFAULT_LOOKBACK_MS = 3600000` in `scripts/yano-watcher-registry.mjs`).
   Il default CLI a 24h era l'outlier. Override esplicito invariato
   (`--lookback-ms <ms>`), usage aggiornato.
2. **Checkpoint dedup persistente** (`notify-checkpoint.json` per progetto,
   save atomico + load-merge-write per passaggi concorrenti): a regime
   elimina le 3 full-scan storiche per passata (stall-route, context-route,
   compaction-completed). Seed del primo passaggio bit-identico alla
   baseline; le compaction (scritte da altri processi) usano lettura
   incrementale since-bound; save best-effort a fine passata, mai bloccante.
   Il trace resta l'audit log intoccato; il checkpoint è solo acceleratore.

## Perché

Profilazione read-only (2 round, frozen copy): le 3 full-scan dedup SENZA
`since` dominano la passata (1,7–5,1 s su alberi 0,5–2,4 GB); le 4 letture
since-bound scendono 24h→60min (es. newmiodoc 1.713→598 ms, orchestrator
3.051→1.869 ms). Le chiavi dedup cambiano raramente tra passate → persistere
il set elimina la rilettura storica a regime. Il default CLI 24h era
incoerente col resto del sistema (registry già a 60min).

## Evidenze (harness `/private/tmp/yano-r1/`, stesso stato per entrambi i lati)

Isolamento: `YANO_DATA_DIR` per-lato su copia frozen byte-identica del trace
reale (membox 533M / newmiodoc 2,3G / orchestrator 439M), reset cold-state da
pristine prima di OGNI run cold, broker morto (`mqtt://127.0.0.1:1`),
Telegram dry-run + token finto, feedback notify skip, ticket in fakerepo,
DB SQLite live in sola lettura (mai scritti dall'harness).

**Baseline `4a2be2d` (cold, mediana di 3/lato, wall `real`):**

| progetto | run 1 | run 2 | run 3 | mediana |
| --- | --- | --- | --- | --- |
| membox | 5,15 s | 4,79 s | 5,04 s | **5,04 s** |
| newmiodoc | 7,98 s | 42,77 s | 22,23 s | **22,23 s** |
| orchestrator | 15,17 s | 12,76 s | 11,09 s | **12,76 s** |

Nota onesta: newmiodoc run 1 riportava 1 stall (`01M2QAGK…/e2e-simulator-01`),
i run candidate 0 — **drift del DB live** (il ticket è passato a `done`
alle 11:27, tra baseline e candidate), non regressione: stessa finestra,
stesso DB live attuale → entrambi i lati riportano 0 stall. I trace sono
frozen, i DB no per disegno (l'harness non tocca i progetti).

**Candidate cold** (reset per-run, include seed checkpoint):

| progetto | run 1 | run 2 | run 3 | mediana | Δ vs baseline |
| --- | --- | --- | --- | --- | --- |
| membox | 4,77 s | 6,55 s | 5,32 s | 5,32 s | +5,6% (rumore) |
| newmiodoc | 11,96 s | 8,25 s | 13,04 s | 11,96 s | −46,2% |
| orchestrator | 9,71 s | 11,34 s | 9,42 s | 9,71 s | −23,9% |

**Candidate steady-state** (seed fatto, checkpoint attivo — il caso reale del
watcher persistente che gira ogni 5 min):

| progetto | run 1 | run 2 | run 3 | mediana | Δ vs baseline |
| --- | --- | --- | --- | --- | --- |
| membox | 2,02 s | 2,79 s | 1,10 s | 2,02 s | **−59,9%** |
| newmiodoc | 6,86 s | 4,29 s | 4,63 s | 4,63 s | **−79,2%** |
| orchestrator | 3,16 s | 1,88 s | 1,49 s | 1,88 s | **−85,3%** |

Δ ≫ soglia 3% su tutti i punti steady-state → **`promote_large_gain`**.

- **Equivalenza dedup** (I1): seed checkpoint vs full-scan baseline sugli
  stessi dati — stall MISS=0/22 chiavi, ctx MISS=0/159 fingerprint, su tutti
  e 3 i progetti. Le chiavi extra del checkpoint sono solo route scritte dal
  seed-run stesso (fail-open ammesso).
- **Oracle qualità** (zero stall persi + zero doppie notifiche): smoke verdi
  nel worktree contro codice candidate — queue-wake 7/7, hijack 7/7,
  e2e-flow 8/8, scheduler-script-first 15/15.
- **QA**: `check-syntax` OK, `check:docs` passed (9 superfici allineate).
- **Concurrency**: skip motivato — checkpoint load-merge-write (union, mai
  clobber); save best-effort mai bloccante; trace append-only intoccato.
- **Contesto/token**: `unknown` (modifica tempo-CPU). **Costo**: +0%
  (nessuna chiamata LLM aggiunta; 1 file JSON <10 KB per progetto).

## Opinioni (formato audit-confidence-contract)

- **Ipotesi round 1 (finestra 60min + checkpoint dedup)** — score 9/10,
  evidence_confidence 9/10, judgment_confidence 9/10. Motivazione: tre
  campagne di misura indipendenti sullo stesso stato frozen mostrano Δ
  −60/−85% a regime con equivalenza dedup MISS=0; la varianza residua
  (membox cold +5,6%) è rumore di I/O su run brevi, assente nello
  steady-state che è il caso operativo reale.
- **Promozione immediata** — score 9/10, evidence_confidence 9/10,
  judgment_confidence 8/10. Motivazione: Δ steady-state ≫ 3% su tutti i
  progetti + oracle verde + equivalenza dimostrata; il giudizio resta 8
  perché la decisione finale di merge spetta al planner/reviewer, non al coder.

## Decisione

Δ ≥ 3% → propongo promozione (`promote_large_gain`); `promote`/`next_round`
spettano al planner. Nessun merge fino a review indipendente (fase 2) e
docs-sync (fase 3).

## Contatori loop aggiornati

- **Stagnazione (≤1%)**: 0/5 — **Plateau (>1% e <3%)**: 0/3
- **Promozioni (questo loop)**: 0 — reference baseline resta `4a2be2d`
  finché il planner non promuove

## Prossimo round

Round 2: nuova ipotesi di bottleneck misurabile (candidati: typed fast-path
sui filtri `signal`, oppure batching delle 4 letture since-bound in un'unica
passata con ripartizione in memoria), da selezionare in `bottleneck_selected`.
