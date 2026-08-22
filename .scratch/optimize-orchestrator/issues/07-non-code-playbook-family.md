Type: grilling
Status: resolved
Blocked by: 01

## Question

Quale modello deve supportare una famiglia di Playbook per task non-code? Definire come classificare il task, scegliere il percorso alternativo, assegnare worker e validator, raccogliere evidenze, applicare gate di completamento e introdurre nuovi Playbook senza indebolire il contratto normativo o il recovery bounded.

## Answer

Il planner classifica il task e propone `playbook_id` e versione; il runtime verifica che il Playbook esista, sia compatibile e sia autorizzato prima di avviare il run.

Il percorso base non-code è `planner → task-worker/specialist → validator → planner`, con worker e validator scelti dal Playbook e con evidenze sufficienti per il gate di completamento.

Se non esiste un Playbook non-code compatibile, il runtime può usare il percorso coder come fallback. Il fallback deve essere esplicito e registrato nello stato del run, non implicito o invisibile al planner.

Un nuovo Playbook viene creato in sandbox dall'agente specializzato, validato sintatticamente e contro gli invarianti, sottoposto a human approval, versionato e poi attivato. Un Playbook già usato da un run non può essere modificato in-place: estensioni e sostituzioni richiedono una nuova versione.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
