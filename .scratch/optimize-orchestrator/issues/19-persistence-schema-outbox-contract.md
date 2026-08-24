Type: human
Kind: grilling
Status: resolved
Blocked by: 13, 14

## Question

Quale schema SQLite e quali transazioni implementano stato corrente, generation, lease/fencing, idempotency keys, outbox/inbox e sweep del watchdog? Definire vincoli, indici, unicità, recovery del database, migrazioni versionate e comportamento davanti a record duplicati o parziali.

## Answer

Il database persistente per progetto/run separa almeno `runs`, `phases`, `tickets`, `leases`, `idempotency_keys`, `outbox`, `inbox`, `watchdog_sweeps`, `approvals` e `schema_meta/migrations`.

SQLite usa WAL, foreign key enforcement, busy timeout e transazioni immediate per le mutazioni del control plane.

Sono obbligatori vincoli unici su `run_id + ticket_id + generation`, `idempotency_key`, `outbox message_id`, `inbox consumer_id + message_id` e un solo lease attivo per risorsa.

Una migrazione mancante, fallita o verso uno schema più nuovo del runtime blocca l'apertura del database senza riparazioni automatiche. Outbox/inbox e lease hanno retention e cleanup espliciti, senza eliminare dati necessari per audit, recovery o deduplicazione.

Corruzione o impossibilità di apertura del database portano il run in `blocked`, attivano escalation e impediscono qualsiasi dispatch MQTT.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
