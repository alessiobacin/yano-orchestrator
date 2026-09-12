# Audit campaign

`audit-campaign` è il coordinatore riusabile per una valutazione completa di
un’applicazione o di Yano stesso. Non è un report monolitico: crea un dossier a
capitoli, ciascuno con uno specialista, un confine e un contratto di evidenza.

## Livelli

| Variante | Include | Uso |
|---|---|---|
| `standard` | manifesto, QA funzionale, adeguatezza test essenziale, architettura e sintesi | gate frequente e costo contenuto |
| `medium` | standard + toolchain, automazione/observability, UX/prodotto/feature | revisione periodica completa |
| `deep` | medium + test negativi/cross-command, mutation, trace/resource ledger e confronto di mercato più ampio | refactor o decisioni strategiche |

Le varianti sono disponibili anche nei playbook specialistici. Per esempio si
può eseguire solo `test-adequacy-audit` o solo `ai-delegation-audit` senza creare
la campagna intera.

## Ordine della campagna

1. Il Planner conferma root, variante, `campaign_id`, budget e confine read-only.
2. `repo-cartographer` produce una volta il manifesto deterministico. Gli altri
   capitoli consumano quel file e dichiarano ogni lettura aggiuntiva.
3. `toolchain-evaluator` fa il preflight di CLI, MCP, skill, script e playbook;
   una capability dichiarata ma non raggiungibile resta `unready`.
4. QA, adeguatezza test, architettura, automazione e prodotto possono partire
   in parallelo solo con approvazione esplicita e collision check. I capitoli
   dipendenti aspettano i relativi artefatti.
5. `audit-synthesizer` deduplica senza cancellare contraddizioni e separa la
   DAG dell’audit dalla DAG di implementazione.
6. Il Planner ordina i task: prima osservabilità/test e fix di rischio, poi
   refactor meccanici, poi cambi prodotto/UX; decide quali nodi possono correre
   in parallelo e quali devono attendere.

## Script deterministici e ledger

```text
node scripts/audit-manifest.mjs --project-root <dir> --output audit-manifest.json
node scripts/audit-delegation.mjs --manifest audit-manifest.json --output delegation.json
node scripts/audit-resource-ledger.mjs --trace-root <YANO_DATA_DIR>/traces --project <name> --output ledger.json
```

Il resource ledger raggruppa gli eventi per `campaign_id` e `chapter_id` e
conserva modello/provider, turni, inference round, retry, compaction, durata,
tool call e token. I campi non esposti dal provider sono `null` e marcati
`partial_provider_usage_unknown`; non sono stime presentate come misure.

## Contratto di ogni capitolo

Ogni relazione contiene perimetro, domande, passi, fonti, comandi, atteso vs
osservato, classificazione `FACT`/`INFERENCE`/`HYPOTHESIS`, due confidenze,
limiti, findings, task candidati e handoff. Nessun agente scrive codice durante
l’audit: la remediation è una fase distinta, in worktree isolato, con una
nuova verifica dei capitoli pertinenti.

### Confidenza dell’evidenza e del giudizio

Ogni capitolo e ogni finding usa il contratto condiviso
[`prompts/audit-confidence-contract.md`](../../../prompts/audit-confidence-contract.md):

| Campo | Significato |
|---|---|
| `evidence_confidence` | da 0 a 10: quanto la prova è diretta, completa e riproducibile |
| `judgment_confidence` | da 0 a 10: quanto l’LLM ritiene solida la propria interpretazione/conclusione |
| `judgment_confidence_rationale` | motivazione breve e osservabile, con il principale limite |
| `confidence` | alias retrocompatibile di `evidence_confidence`; se presenti entrambi devono coincidere |

Le due dimensioni non vengono mediate in un unico numero. Una prova può essere
certa ma la sua interpretazione restare discutibile; in quel caso i valori sono
diversi. Un dato non verificabile è `0`/`UNKNOWN`, mai una confidenza implicita.
La motivazione non contiene chain-of-thought: descrive soltanto evidenza,
ambiguità e limite operativo.
