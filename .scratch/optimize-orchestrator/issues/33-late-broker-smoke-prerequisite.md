Type: human
Kind: task
Status: resolved
Blocked by: 02

## Question

Evitare che il test di riconnessione MQTT fallisca con errore non gestito quando il binario `mosquitto` non è installato.

## Resolution

Aggiornato `scripts/smoke-test-late-broker.mjs`: l’assenza del prerequisito produce `SKIPPED` diagnostico con exit code 0; gli altri errori di avvio del broker restano failure. Nell’ambiente corrente il test è stato eseguito come skipped perché `mosquitto` non è disponibile.
