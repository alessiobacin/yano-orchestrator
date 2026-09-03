---
name: yano-auto-improvement
description: Audit periodico read-only, sequenziale e evidence-first di un progetto per produrre report di miglioramento su architettura, backend, frontend, UX, performance, sicurezza, affidabilità, documentazione e prodotto; consegna sempre il report al planner senza modificare il progetto.
compatibility: "Richiede yano-observer, yano-cli, git e l'evidence pack/trace globale; browser e ricerca web pubblica sono opzionali e bounded."
---

# Yano auto-improvement

Esegui l'audit seguendo nell'ordine il playbook `auto-improvement-360`. Ogni
fase produce un checkpoint breve e verificabile prima di passare alla fase
successiva. Questo evita di perdere contesto e impedisce di costruire la
conclusione su impressioni isolate.

## Regole non negoziabili

- Sii schietto: descrivi chiaramente ciò che funziona, ciò che non funziona e
  ciò che non può essere verificato.
- Non inventare nulla: mai metriche, utenti, bug, feature, alternative, URL,
  costi o risultati di test. Un dato non disponibile resta `UNKNOWN`.
- Separa sempre `FACT`, `INFERENCE` e `HYPOTHESIS`; ogni voce include il
  riferimento all'evidenza o la ragione per cui è soltanto un'ipotesi.
- Ogni parere, finding o raccomandazione ha uno score numerico `X/10`, una
  motivazione dello score e una confidenza `X/10`. Lo score valuta il valore o
  l'urgenza della proposta; la confidenza indica quanto è solida la conclusione.
- L'audit è read-only: non modificare file, dipendenze, configurazioni, dati,
  branch, worktree, ticket o deployment. Non chiamare coder, reviewer o
  deployment-agent direttamente.
- Il planner è l'unico destinatario operativo: riceve il report, decide il
  seguito e assegna eventuali lavori agli agenti appropriati.

## Ordine dell'audit

1. **Preflight e modalità** — conferma progetto, root, limiti e capability
   principale; determina automaticamente `backend-only`, `frontend-only` o
   `full-stack` dai marker reali, senza fidarti soltanto del nome del progetto.
2. **Indice dei report esistenti** — leggi ogni `docs/improvements/*.md` se
   presente e i report nel data-root globale; indicizza stato, data, finding e
   raccomandazioni prima di formulare nuove proposte.
3. **Evidence pack** — correla Git, manifest, script e marker di test/build/lint,
   documentazione, trace/memoria, feedback, bug, regressioni, duplicazioni,
   flakiness e costi operativi. Usa solo comandi bounded e read-only.
4. **Performance, architettura e refactoring** — misura prima di affermare un
   problema di performance; controlla colli di bottiglia, complessità,
   duplicazione, dipendenze, caching, error handling e manutenibilità.
5. **Backend, API e dati** — valuta contratti, validazione, errori, auth,
   autorizzazione, idempotenza, timeout, retry, paginazione, migrazioni,
   indici, consistenza, osservabilità e privacy.
6. **Frontend e UX** — esegui questa fase solo se la modalità lo richiede.
   Valuta accessibilità, responsive behavior e gli stati loading, empty, error,
   retry, success, disabled, offline, timeout, permessi, partial, unsaved,
   validation, background, optimistic, undo e azioni distruttive.
7. **Feature e prodotto** — ricostruisci il job-to-be-done e valuta feature,
   comandi, onboarding, configurazione, UX per utente e LLM/agent, API, MCP,
   connettori, plugin, deployment, test, maturità, licenza e costi. Distingui
   sempre bug, miglioramento tecnico, feature e suggerimento UX.
8. **Micro-validazione** — proponi o esegui soltanto controlli diagnostici
   proporzionati, non distruttivi e riproducibili. Registra comando, exit code,
   input, output rilevante e limiti; non chiamare un'assenza di prova “bug”.
9. **Scoring e deduplicazione** — classifica ogni finding come `NEW`,
   `ALREADY DOCUMENTED`, `ALREADY IMPLEMENTED`, `DUPLICATE`, `UPDATED VERSION`,
   `SUPERSEDES EXISTING`, `BLOCKED` o `REQUIRES VALIDATION`. Calcola gli score
   richiesti e conserva le proposte soltanto se aggiungono valore.
10. **Report e handoff** — salva il report nel percorso globale autorizzato
    dall'evidence pack usando `yano auto-improve complete`; poi invialo al
    planner con il checkpoint finale e una richiesta d'azione esplicita.

## Fonti e confronto esterno

Ricostruisci prima la capability dai file locali. Solo dopo confrontala con
almeno tre alternative realmente comparabili, usando discovery pubblica e
fonti ufficiali HTTPS tramite i tool bounded disponibili. La gap matrix deve
separare `attuale`, `alternativa`, `evidenza`, `gap`, `impatto`, `score /10` e
`confidenza /10`. Se web o fonti non sono disponibili, registra query e
fallimenti: non colmare il vuoto con conoscenza inventata.

## Scheda obbligatoria per ogni proposta

Ogni proposta deve contenere: titolo, categoria, tipo di evidenza, riferimenti,
problema osservato, proposta concreta, benefici, rischi, priorità, valore,
complessità, tempo al valore, `requires_human_decision`, `score: X/10`,
`score_rationale`, `confidence: X/10`, `confidence_rationale`, stima a range
per tempo AI, review umana, token, effort e costo operativo. Indica anche la
fase di delivery: discovery, decisione, implementazione o validazione.

## Struttura minima del report

1. executive summary schietto;
2. scope, modalità e limiti;
3. metodo e fonti;
4. evidence pack con riferimenti trace;
5. indice e deduplicazione degli audit precedenti;
6. capability principale;
7. gap matrix delle alternative;
8. risultati performance/architettura/refactoring;
9. risultati backend/API/dati;
10. risultati frontend/UX/accessibilità, oppure `not applicable` motivato;
11. risultati feature/prodotto/tool/agent;
12. micro-validazioni e ciò che non è stato verificato;
13. proposte ordinate per impatto/costo, con score e confidenza per ciascuna;
14. handoff breve al planner e decisioni umane richieste.

Concludi soltanto quando il report è persistito e tutte le proposte hanno
score, motivazione, confidenza ed evidenza. Non segnare come fatto ciò che è
solo inferito.
