# Validazione audit multi-livello su code-mem

**Data:** 2026-09-11<br>
**Progetto osservato:** `/Users/alessiobacin/Desktop/code-mem`<br>
**Scopo:** verificare che il nuovo impianto di audit possa partire da un progetto reale, riusare l’ultimo report disponibile e separare evidenze deterministiche da analisi che richiedono agenti.

## Stato

La validazione infrastrutturale è completata. Non sono state apportate modifiche a `code-mem`; il suo worktree era già sporco e ogni modifica locale è stata preservata. La campagna multi-agente completa resta un’esecuzione on demand: in questa fase sono stati eseguiti gli strumenti deterministici e la verifica della suite esistente, non sono stati avviati agenti LLM specialistici.

## Evidenze di base

- Report precedente riusato: `code-mem/docs/reports/auto-improvement-11-09-09_01.md`.
- Manifest generato con `scripts/audit-manifest.mjs`: 139 file, 2 script npm (`build`, `test`), 0 playbook nel progetto osservato.
- Il manifest rileva `chrome-devtools` e `github` nella configurazione MCP dichiarata. Questa è una configurazione del workspace/progetto, non prova che code-mem esponga direttamente quelle capability come prodotto.
- Classificazione delega: 4 candidati D0, 0 D1, 0 AI. Il risultato è un inventario iniziale, non una valutazione di adeguatezza dei test.
- `npm test` di code-mem: 18 test passati, 10 falliti.

I fallimenti sono concentrati nel percorso `cm update --memory`, che tenta di scaricare lo script remoto da GitHub tramite `wget`; l’ambiente di esecuzione non consentiva quella rete. È quindi una condizione **blocked-by-environment**, non una prova sufficiente di regressione applicativa. Resta comunque un rischio reale da coprire: il comando ha una dipendenza di rete implicita e il progetto non dispone ancora di una modalità offline/mock per testarlo in modo ripetibile. Un’aspettativa stale sui dati di memoria va invece riesaminata nel capitolo di adeguatezza dei test.

## Cosa conferma il report precedente

Il report esistente descrive code-mem come CLI locale-first e individua già questi assi di lavoro:

1. assenza di MCP/API e GUI/TUI;
2. assenza di CI, lint e typecheck automatici;
3. un solo percorso collegato allo script `npm test`, mentre esistono script tddb/e2e/manuali non inclusi nella guardia standard;
4. possibile drift tra documentazione e CLI (`cm update --memory`);
5. `scan --deep` con installazione/runtime `acorn` e dipendenza dalla rete;
6. shell-out a `curl`/`wget`, da valutare per robustezza, sicurezza e portabilità;
7. benchmark interno senza confronto riproducibile tra versioni;
8. confronto iniziale con claude-mem, Engram, Mem0 e graphify.

Questi punti diventano input condivisi per i capitoli specialistici: non devono essere riscoperti da ogni agente.

## Esecuzione per livello

### QA standard

Obiettivo: ottenere rapidamente una baseline ripetibile.

- eseguire manifest e classificazione D0/D1/AI;
- eseguire il comando di test ufficiale;
- distinguere pass, fail applicativo e blocked-by-environment;
- verificare che i comandi documentati principali esistano e mostrino un errore leggibile su input invalido;
- registrare un log di esecuzione con commit, ambiente e durata.

**Esito attuale:** manifest completato; baseline test eseguita; manca ancora una matrice completa comando/use-case.

### QA medio

Obiettivo: verificare i contratti osservabili e i casi d’uso che l’utente umano si aspetta.

- matrice comando × opzione × stato iniziale × risultato atteso;
- casi felici, dati vuoti, duplicati, memoria inesistente, path non valido, database corrotto e interruzione a metà;
- test offline per ogni shell-out di rete;
- idempotenza e sicurezza di ripetizione di `add`, `update`, `delete`, `scan` e ricerca;
- verifica di documentazione/CLI drift;
- copertura degli script esistenti non richiamati da `npm test`;
- misura di tempi, file letti/scritti e subprocess per distinguere ciò che può essere D0 da ciò che richiede giudizio AI.

**Dipendenze:** il capitolo standard deve fornire manifest, comandi supportati e ambiente riproducibile; dopo si possono parallelizzare adeguatezza test, toolchain e automazione.

### QA profondo

Obiettivo: una valutazione completa di prodotto e codice, non solo una green build.

- analisi architetturale e refactor dei file sovradimensionati, duplicazioni, dead code, API interne e confini dei moduli;
- controllo della logica dei comandi: comportamento atteso da un umano, opzioni mancanti, output, errori, help, exit code, compatibilità e reversibilità;
- verifica completa del flusso memoria e dei suoi invarianti con test di proprietà/mutazione dove utili;
- osservabilità: log strutturati, correlation id, durata, errori, rete, subprocess, quantità di dati e redazione dei segreti;
- analisi sicurezza, portabilità, performance e affidabilità in condizioni offline o parzialmente degradate;
- valutazione di GUI/TUI/API/MCP: cosa serve davvero, quale superficie dati manca, quale interfaccia riduce il costo cognitivo;
- confronto aggiornato con concorrenti e ricerca di spazi di prodotto non coperti;
- piano di miglioramento ordinato per valore, rischio, costo, dipendenze e parallelizzabilità.

**Dipendenze:** la sintesi profonda deve attendere i capitoli di test, architettura, toolchain/automation e product/UX; nessun agente deve rileggere l’intero repository quando il manifest e gli estratti mirati sono già disponibili.

## Ordine di prosecuzione consigliato

```text
manifest + baseline
        │
        ├── test adequacy ───────┐
        ├── toolchain readiness ─┼── automation/observability
        ├── architecture health ─┘
        └── AI vs deterministic delegation
                         │
                   product / UX / market
                         │
                    refactor plan
                         │
                    final synthesis
```

Il ledger delle risorse è già disponibile nel nuovo orchestrator. Per la campagna reale ogni capitolo dovrà propagare `campaign_id`, `chapter_id` e `phase_id`; il ledger registrerà modello/provider, istanza, durata, token noti o sconosciuti, round, tool deterministici, retry e compaction. In questa validazione non ci sono record LLM da rendicontare.

## Decisioni operative

1. Non considerare `npm test` verde/rosso come unico criterio di qualità.
2. Separare sempre difetto del prodotto, difetto del test e blocco dell’ambiente.
3. Prima di delegare ad agenti, usare manifest, grep strutturato, parser, contatori, coverage e smoke test deterministici.
4. Usare agenti specialistici solo per interpretazione, casi d’uso, trade-off, UX, mercato e sintesi.
5. Trattare l’assenza di API/MCP/GUI come ipotesi di prodotto da valutare, non come difetto automatico.
