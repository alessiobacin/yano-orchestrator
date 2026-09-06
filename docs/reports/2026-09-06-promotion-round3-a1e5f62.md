# Promozione Round 3 — performance-optimization-loop (2026-09-06)

- **Run**: 01M1MF74R67KXXWDVQQJREBQJS
- **Playbook**: performance-optimization-loop (bind 19b7f3fdb79d…)
- **Candidate promosso**: `a1e5f62` — `perf: skip old trace files in since-bounded reads`
- **Worktree candidate**: `.worktrees/performance-optimization-yano` (branch `task/performance-optimization-yano`)
- **Baseline-original immutabile**: `.worktrees/perf-baseline-original` @ `253456f` (mai modificata)
- **Nuova reference baseline**: `a1e5f62` (per il Round 4)

## Cosa cambia

`scripts/yano-trace-storage.mjs` (+20) — in `readTraceRecords`, quando `since` è settato: `statSync(file)` e **skip del file se `mtimeMs + 2000 < since.getTime()`** (`SAFETY_MARGIN_MS = 2000` commentata: granularità mtime + clock skew, conservativa). `walkJsonl` e import invariati. Un file non scritto da since−2s non può contenere record con `ts ≥ since` (append-only, mtime = ultima scrittura).

**Cambio di comportamento intenzionale (documentato e approvato in review/QA)**: i record **senza `ts`** in file vecchi (mtime+2s < since) escono dalle query since-bound (oggi inclusi per sempre). Motivo: un record scritto prima della finestra (provato dal mtime) non ha titolo a stare in una query since; i ts-less in file recenti restano letti e mantenuti. I path senza `since` (dedup/fingerprint/recovery) non toccati.

## Perché

`readTraceRecords` con `since` leggeva+parsificava **tutto** l'albero trace (~930 MB, 11.197 file) quando solo ~8% dei file (<1 giorno) poteva contenere record in finestra; `watch-stalls.mjs` lo chiama 3× per sweep con `since`. Costo: 4–5 s per chiamata cold.

## Evidenze (Round 3)

- **Misura (harness `/tmp/yano-r3-harness.mjs`, stesso lato per baseline `cac32d1` e candidate `a1e5f62`, since=24h, cold+warm, mediana di 9/lato)**:
  - Albero reale FROZEN: cold **4.031,7 → 1.450,0 ms (−64,0%)**, warm **4.201,0 → 1.875,5 ms (−55,4%)** — baseline min 3.624 > candidate max 1.545 (cold), nessuna sovrapposizione.
  - Albero sintetico deterministico: cold **−58%**, warm **−65%**.
  - Δ ≫ soglia 3% su tutti i punti → **`promote_large_gain`**, promozione immediata.
  - Nota onesta: la prima stima del reviewer (cold −75% / warm −10,8%) differiva per condizioni harness; la misura formale (frozen copy, allProjects, since congelato) è quella riportata qui.
- **QA/qualità**: 9/9 test PASS (6 smoke + check-syntax + check:docs + lint:playbooks 24/24); **equivalenza**: I1 no-since identico (reale 100.000/100.000 al limite, sintetico 4.202/4.202), I2 ts≥since identico (18.112/18.112 reale; 281/281 sintetico), I3 removals = esattamente **44.816 ts-less in file skippati** (0 added, 0 non-ts-less removals), skip safety 0 record ts≥since nei file saltati (10.283 file / 254.322 record ispezionati).
- **Concurrency**: skip motivato (modifica read-only statSync+skip, nessun mutex/DB-scrittura; i 6 smoke coprono il path condiviso).
- **Contesto/token**: `unknown` (modifica tempo-CPU). **Costo**: +0%.

## Decisione

Δ ≥ 3% → promozione automatica (`promote_large_gain`); nessuna decisione umana richiesta. `promote` (gen 20→21) e `next_round` (gen 21→22) applicati dal planner.

## Contatori loop aggiornati

- **Stagnazione (≤1%)**: serie interrotta (0/5) — round 2 e 3 entrambi ≫ soglia
- **Plateau (>1% e <3%)**: 0/3
- **Promozioni**: 3 (7ad9b35, ca4c512, a1e5f62) — nuova reference baseline = `a1e5f62`

## Prossimo round

Round 4: nuova ipotesi di bottleneck misurabile nell'harness, da selezionare in `bottleneck_selected` (gen 22).