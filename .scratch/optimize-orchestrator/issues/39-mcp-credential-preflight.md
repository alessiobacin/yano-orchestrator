Type: task
Status: resolved
Blocked by: 10, 11, 37

## Question

Gestire deterministicamente le credenziali MCP durante `yano init` senza hardcodare secret e senza creare scaffold parziali.

## Resolution

`scripts/create-project.mjs` rileva solo configurazioni MCP attive (`.mcp.json` o `.pi/mcp.json`) con header API key placeholder, chiede la chiave in terminale interattivo e aggiorna il file con scrittura temporanea atomica. In modalità non interattiva o con chiave vuota fallisce prima dello scaffold con istruzioni manuali. I file `.mcp.json.example` restano opzionali e non richiedono secret.
