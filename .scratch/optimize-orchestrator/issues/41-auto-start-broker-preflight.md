Type: human
Kind: task
Status: resolved
Blocked by: 11, 21, 37

## Question

Avviare automaticamente il broker MQTT ufficiale durante `yano init` quando Docker è già disponibile ma la porta non risponde.

## Resolution

`runDoctor` supporta `autoStartBroker` e `packageRoot`: in `yano init` esegue il compose MQTT versionato del pacchetto, attende la porta 1883 e aggiorna il risultato machine-readable con `broker_auto_started`. Se Docker/compose non sono disponibili, mantiene il fallback manuale senza inventare comandi o installazioni.
