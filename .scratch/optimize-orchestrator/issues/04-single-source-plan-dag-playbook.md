Type: grilling
Status: resolved
Blocked by: 01

## Question

Come si garantisce che Playbook, `plan_set`/`plan_advance` e ticket DAG siano una rappresentazione coerente dello stesso run? Definire mapping fase-ticket, gate di avanzamento, completezza, dipendenze, ticket inattesi o mancanti, rollback/replanning e quale componente può mutare ciascuna rappresentazione.

## Answer

La gerarchia è:

- il Playbook definisce la macchina a stati e le regole normative;
- il piano rappresenta l'intenzione qualitativa del planner;
- il ticket DAG rappresenta le unità operative e le dipendenze, validate dal runtime.

`plan_set` è accettato solo se ogni fase dichiara ticket esistenti, senza duplicati, e ogni ticket appartiene a una sola fase. `plan_advance` è consentito solo quando tutti i ticket della fase sono `done` e approvati; ticket `failed`, `blocked` o mancanti impediscono l'avanzamento.

Il replanning può modificare il piano e riaprire o modificare ticket esistenti, ma deve passare nuovamente dalla validazione con Playbook e DAG. Il planner è l'unico autorizzato a proporre modifiche al piano; il runtime è l'unico autorizzato ad aggiornare stato delle fasi, gate e consistenza effettiva.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
