Type: human
Kind: task
Status: resolved

## Question

Rimuovere la credenziale MCP hardcoded da `mcp.json`, ruotare la chiave esposta tramite il provider competente e definire il riferimento sicuro usato dal runtime/preflight. Verificare che configurazione, log, report ed eventi MQTT non possano ristampare il secret e registrare l'esito della remediation.

## Comments

- L'utente conferma che la chiave è stata rimossa dalla configurazione locale il 2026-08-22. La rotazione presso il provider e la verifica del riferimento sicuro restano da confermare.

## Answer

La credenziale hardcoded è stata rimossa dalla configurazione locale e la vecchia chiave è stata ruotata/revocata presso il provider. Il nuovo secret non deve essere scritto in `mcp.json`, YAML, report, log o eventi MQTT: `yano init` lo richiede quando necessario e lo passa tramite il riferimento sicuro previsto dal bootstrap/preflight.

La configurazione MCP deve restare priva di credenziali statiche. Il preflight deve verificare la presenza, validità e scope del secret senza ristamparne il valore.

## Comments

- Remediation confermata dall'utente il 2026-08-22.
