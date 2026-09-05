# Promozione Round 2 — performance-optimization-loop (2026-09-05)

- **Run**: 01M1MF74R67KXXWDVQQJREBQJS
- **Playbook**: performance-optimization-loop (bind 19b7f3fdb79d…)
- **Candidate promosso**: `ca4c512` — `perf: optimize trace index hybrid/keyword search hot path`
- **Worktree candidate**: `.worktrees/performance-optimization-yano` (branch `task/performance-optimization-yano`)
- **Baseline-original immutabile**: `.worktrees/perf-baseline-original` @ `253456f` (mai modificata)
- **Nuova reference baseline**: `ca4c512` (per il Round 3)

## Cosa cambia

`scripts/yano-trace-index.mjs` (+67/−5) — ottimizzazione dell'hot path di ricerca in `searchTraceRecords`:
1. **Pre-filtro lessicale cheap** (keyword mode): righe senza nessun token della query scartate prima del ranking completo — per costruzione equivalente al filtro finale `lexical_score > 0`.
2. **Parse JSON condizionale**: `embedding_json` parso solo quando serve (modalità non-keyword); `payload_json` solo quando `includePayload` — niente re-parsing per riga per query.
3. **Cache normalizzazione** (`normalizedText`, Map bounded 128k): lowercase/NFKD calcolati una volta per documento — output bit-identico alla funzione precedente (pura memoizzazione).

## Perché

Il bottleneck Round 2 selezionato: la ricerca ibrida/lessicale su `yano trace search` faceva full scan con cosine similarity + lexicalScore completi su tutta la collezione e re-parsing JSON/normalizzazione per ogni riga a ogni query — costo crescente col volume di trace (rilevante per il recupero di contesto del planner).

## Evidenze (Round 2, stessa config baseline del Round 1)

- **Misura (harness `/tmp/yano-bench-probe.mjs`, N=2000, 3 ripetizioni/lato, mediana delle mediane, baseline `41cbc0d` vs candidate `ca4c512`)**:
  - **keyword: 69.3 ms → 18.7 ms (−73.0%)** — nessuna sovrapposizione tra i lati (baseline 68.0/72.8/69.3 vs candidate 21.7/17.0/18.7) → **promozione immediata (`promote_large_gain`, Δ ≥ 3%)**.
  - hybrid: 108.3 → 107.0 ms (−1.2%, rumore — costo dominato da latenza embedding Ollama della query, non dal codice).
- **QA/qualità**: 3 smoke PASS (trace-index, trace, trace-memory), check:docs PASS, lint:playbooks 24/24, check-syntax OK — **nessuna regressione**.
- **Equivalenza funzionale**: 54 combinazioni (3 mode × 3 varianti × 6 query) a N=400 e N=2000 → **0 divergenze** (id/score/lexical/recency identici riga per riga, payload incluso).
- **Concurrency**: skip motivato (modifica CPU-bound read-only, cache module-level bounded, nessuno stato condiviso cross-session; nessun test stress esistente).
- **Contesto/token**: `unknown` (modifica CPU-bound, non del contesto) — invariante `no_invention`. **Costo**: +0% (nessuna chiamata LLM extra).

## Decisione

Δ keyword −73% ≥ soglia di promozione (3%) → `promote_large_gain` applicato senza necessità di decisione umana (diversamente dal Round 1, dove la promozione era una deviazione autorizzata dall'utente). `promote` (gen 14→15) e `next_round` (gen 15→16) applicati dal planner.

## Contatori loop aggiornati

- **Stagnazione (≤1%)**: serie interrotta dal round 2 (Δ −73%) → contatore 0/5
- **Plateau (>1% e <3%)**: 0/3
- **Promozioni**: 2 (7ad9b35, ca4c512) — nuova reference baseline = `ca4c512`

## Prossimo round

Round 3: nuova ipotesi di bottleneck misurabile nell'harness, da selezionare in `bottleneck_selected` (gen 16).