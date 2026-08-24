Type: human
Kind: grilling
Status: resolved
Blocked by: 08, 11

## Question

Come devono essere modellate capability dichiarate, risolte e verificate per ruoli e istanze? Definire capability card, probe bounded per skill/CLI/MCP/secret, scope/permessi/versioni, cache, invalidazione, installazione da manifest e gate di dispatch senza secret leakage.

## Answer

Ogni capability card contiene almeno `name`, `kind`, `declared`, `resolved`, `verified`, `version`, `path/endpoint`, `scope`, `permissions`, `evidence`, `checked_at` ed `environment_fingerprint`.

Il runtime distingue gli stati `declared`, `resolved`, `verified`, `unavailable`, `invalid`, `expired` e `blocked`. La cache è riutilizzabile solo se manifest, versione, path/endpoint, permessi, credenziali e fingerprint dell'ambiente non sono cambiati.

Il modello di composizione resta `role + override instance`, ma il risultato finale viene validato dopo merge e deduplica. Una capability MCP project-wide è marcata come condivisa e non isolata per ruolo; se il Playbook richiede isolamento, il dispatch viene rifiutato.

Il dispatch richiede che tutte le capability richieste siano in stato `verified`. `declared` e `resolved` non sono sufficienti. Le probe non devono esporre secret.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
