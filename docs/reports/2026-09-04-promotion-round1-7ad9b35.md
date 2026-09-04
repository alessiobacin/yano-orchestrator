# Promozione Round 1 — performance-optimization-loop (2026-09-04)

- **Run**: 01M1MF74R67KXXWDVQQJREBQJS
- **Playbook**: performance-optimization-loop (bind 19b7f3fdb79d…)
- **Candidate promosso**: `7ad9b35` — `perf: lower watcher context-compaction threshold default 0.82 -> 0.50`
- **Worktree candidate**: `.worktrees/performance-optimization-yano` (branch `task/performance-optimization-yano`)
- **Baseline-original immutabile**: `.worktrees/perf-baseline-original` @ `253456f` (mai modificata)

## Cosa cambia

`scripts/watch-stalls.mjs` — default di `--context-compact-ratio` per la compaction del contesto del watcher: **0.82 → 0.50** (+ 6 superfici documentali allineate). Nessun'altra modifica.

## Perché

La metrica obiettivo del run (context tokens per turno) dipende dalla frequenza con cui il watcher compatta il contesto delle sessioni. La soglia di default vecchia (0.82) cade FUORI dal regime di utilizzo osservato (47–63% di contesto effettivo vs window nelle trace baseline); il nuovo default (0.50) cade DENTRO il regime, quindi la compaction scatta quando `effective_context_tokens/context_window_tokens ≥ 0.5` invece di attendere il 82%. Effetto atteso: riepiloghi più frequenti/aggressivi, meno reinvio di contesto per chiamata LLM. Score/confidence al momento della misura: effect atteso **6/10**, confidence **5/10** (verificabile pienamente solo in sessione reale con watcher candidate — non misurabile nell'harness per l'invariante `no_global_mutation`).

## Evidenze (Round 1)

- **QA/qualità**: 13/13 smoke PASS ×3 run (12 identici a baseline + watch-stalls regression aggiunta), oracle 4/4 (check:docs, lint:playbooks 24/24, lint:capabilities 16/16, check-syntax) — **nessuna regressione**.
- **Verifica mirata default 0.50**: 11 assertion PASS (tutti i punti di legge della soglia, nessun residuo 0.82 nel codice, override env `YANO_WATCH_CONTEXT_COMPACT_RATIO=0.9` → soglia 0.9, override flag 0.7, valore invalido → fallback 0.5, comportamento soglia con contesto 0.99/0.05).
- **Delta prestazionali misurati**: tutti nel rumore (12-smoke mediana ≈ −1.5%; startup −45/−66% dominati da cache; context-compaction-e2e +0.5%) → Δ ≤ 1% = **stagnazione round 1/5**.
- **Context tokens per turno col candidate**: `unknown` (nessuna sessione reale esegue il candidate; 0 eventi `context_compaction_completed` nelle trace) — registrato come unknown per l'invariante `no_invention`, non inventato.
- **Costo**: nessun aumento di costo osservato (max cost increase +2% rispettato).

## Decisione

Guardia `promotion_rule_satisfied` (Δ ≥ 3%) **falsa** e `stop_condition_satisfied` (5 round stagnanti) **falsa** → nessuna transizione automatica applicabile; nessuna transizione "continua senza promuovere" nel playbook. **Decisione umana richiesta** (hold `hold-ddd89fd847c7b753fe74151487a0e69e`): l'utente ha risposto **A — "ok continua il flusso fino alla fine"**: promuovere `7ad9b35` come nuova reference baseline (nessuna regressione, beneficio atteso documentato) e proseguire i round fino alla condizione di stop del playbook (5 round stagnanti consecutivi → stop; o plateau/≥3% → promozione).

La promozione di un candidate con Δ ≤ 1% è una **deviazione bounded autorizzata dall'utente** (evidenza `promotion_rule_satisfied` = hold answered), non un'inferenza da run singolo: il candidate è qualitativamente identico, non regredisce nulla, e il suo effetto (compaction più frequente) è teoricamente fondato e giace nel regime misurato.

## Contatori loop aggiornati

- **Stagnazione (≤1%)**: 1/5
- **Plateau (>1% e <3%)**: 0/3
- **Promozioni**: 1 (7ad9b35) — nuova reference baseline per il Round 2

## Prossimo round

Nuova ipotesi di bottleneck misurabile nell'harness (round 2), da selezionare nell'orchestrazione successiva.