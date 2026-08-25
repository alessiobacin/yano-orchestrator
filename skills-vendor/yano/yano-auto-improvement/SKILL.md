---
name: yano-auto-improvement
description: Audit periodico read-only di un progetto per trovare miglioramenti, feature mancanti, regressioni, problemi di qualità, performance, sicurezza, test, documentazione e UX. Usalo per ogni auto-improve Yano e invia sempre il report al planner senza modificare il progetto.
compatibility: "Richiede yano-observer, git e accesso alla trace/index globale; browser, Docker e tool specifici sono opzionali e solo diagnostici."
---

# Yano auto-improvement

Esegui un audit evidence-first del progetto assegnato. Parti dall'evidence pack
preparato dalla CLI, poi usa il trace semantico e i file necessari per colmare
solo lacune concrete. Non leggere l'intero repository senza motivo.

## Fonti da correlare

1. stato e cronologia Git;
2. manifest, script di test/build/lint e documentazione;
3. trace recente e memoria semantica consolidata;
4. feedback utente, bug del debugger e report precedenti;
5. segnali di regressione, duplicazione, flakiness e costi operativi.

## Classificazione

Separa sempre:

- bug applicativo → planner/debugger workflow;
- problema del flusso interno Yano → planner e manutenzione Yano;
- miglioramento tecnico → proposta per planner;
- nuova feature → proposta prodotto, spesso con decisione umana;
- suggerimento UX → planner/suggester workflow;
- finding non verificato → ipotesi, mai fatto accertato.

## Output obbligatorio

Scrivi il report soltanto nella directory globale indicata dall'evidence pack e
completa l'audit tramite `yano auto-improve complete`. Il report deve contenere:

- executive summary;
- evidenze osservate e riferimenti trace;
- finding con categoria, priorità, valore, complessità, rischio e confidenza;
- confronto con audit precedenti;
- cosa non è stato possibile verificare;
- `requires_human_decision` per ogni proposta;
- messaggio breve per il planner.

Non chiamare coder, reviewer o deployment-agent direttamente. Il planner è
l'unico destinatario operativo e decide se creare PRD/spec/ticket o chiedere
prima un chiarimento all'utente.
