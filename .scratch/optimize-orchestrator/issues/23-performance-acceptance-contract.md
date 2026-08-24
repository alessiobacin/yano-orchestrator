Type: human
Kind: grilling
Status: resolved
Blocked by: 13, 14, 16

## Question

Quali metriche e budget di performance devono essere garantiti dal runtime dopo l'introduzione di Playbook, preflight, persistence e watchdog? Definire latenza dispatch, overhead preflight/cache, durata sweep, contesa SQLite, throughput MQTT, limiti accettabili e test di regressione.

## Answer

Le metriche minime sono latenza `yano start`/preflight, overhead capability cache hit/miss, latenza dispatch, durata sweep watchdog, contesa e latenza SQLite, throughput e latenza MQTT e tempo di resume dopo crash.

I budget sono distinti tra cold path e warm path e configurabili per ambiente. Le soglie sono criteri di accettazione hard: il test fallisce quando vengono superate.

Benchmark e test di carico devono essere riproducibili, con dataset, scenario e versione dell'ambiente registrati. Una regressione blocca la release/package, ma non interrompe automaticamente un run già attivo.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
