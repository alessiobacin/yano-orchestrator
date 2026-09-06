# STOP loop — performance-optimization-loop (2026-09-06)

- **Run**: 01M1MF74R67KXXWDVQQJREBQJS
- **Playbook**: performance-optimization-loop (bind 19b7f3fdb79d…)
- **Decisione**: hold `hold-4cf43fb7c9e6dc04065d824ec78f694b` — risposta utente **B (STOP/PLATEAU)**
- **Worktree candidate**: `.worktrees/performance-optimization-yano` (branch `task/performance-optimization-yano`)
- **Baseline-original immutabile**: `.worktrees/perf-baseline-original` @ `253456f` (mai modificata)

## Motivo dello stop

Round 5 bloccato: l'ipotesi selezionata (comparatore byte-order in
`yano trace index compare`) è stata scartata da coder-05 in fase candidate per
vincolo di equivalenza (`localeCompare` ≠ byte-order su timestamp con offset
importabili via `yano trace import`); nessun commit. L'utente ha scelto, alla
domanda A/B, **B — chiudere il loop qui** (plateau), applicare le 2 note doc del
devil's advocate e finalizzare il merge di `task/performance-optimization-yano`
in master.

## Promozioni completate (4/4, tutte promosse con `promote_large_gain`)

| Round | Commit | Cambio | Δ misurato | Report |
| --- | --- | --- | --- | --- |
| r1 | `7ad9b35` | default watcher `--context-compact-ratio` 0.82→0.50 | beneficio atteso documentato (metrica chiave non misurabile nell'harness) | `docs/reports/2026-09-04-promotion-round1-7ad9b35.md` |
| r2 | `ca4c512` | trace index hybrid/keyword search hot path | ≤1% (rumore) | `docs/reports/2026-09-05-promotion-round2-ca4c512.md` |
| r3 | `a1e5f62` | skip file vecchi nelle letture since-bound (`mtimeMs + 2000 < since`) | cold −64,0%, warm −55,4% | `docs/reports/2026-09-06-promotion-round3-a1e5f62.md` |
| r4 | `f444246` | typed fast-path nelle letture trace record | cold −41,3%, warm −36,4% | `docs/reports/2026-09-06-promotion-round4-f444246.md` |

r1/r2 sono già presenti in master come patch-equivalenti (19d9677 / 79e83e8 +
report), quindi il merge netto porta r3+r4+documentazione.

## Note doc del devil's advocate (applicate)

1. **Caso restore/mtime stantio (round 3)** — nota `--since` aggiunta a
   `docs/quick-guides/yano-trace.md` + commento nel codice
   (`scripts/yano-trace-storage.mjs`, già nel candidate, commit `080da7c`),
   poi anche nel changelog qui sotto.
2. **Nota ts-less nel changelog** — i record **senza `ts`** in file vecchi
   (mtime+2s < since) escono dalle query since-bound: comportamento
   intenzionale, documentato in questa sezione e nei report r3 (sezione
   "Cambio di comportamento intenzionale").

## Contatori finali

- **Stagnazione (≤1%)**: 0/5 — **Plateau (>1% e <3%)**: 0/3
- **Promozioni**: 4 — reference baseline finale: `f444246`

## Decisione

`stop` (transizione playbook, generazione 28→29) applicata dal planner;
loop chiuso in `stopped` (terminale). Nessun merge fino a conferma finale
esplicita dell'utente prevista dalla scelta B.