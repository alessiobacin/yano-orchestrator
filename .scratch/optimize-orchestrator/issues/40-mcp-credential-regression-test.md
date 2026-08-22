Type: task
Status: resolved
Blocked by: 39

## Question

Aggiungere una regressione automatizzata per il blocco MCP senza scaffold parziale.

## Resolution

Aggiunto `scripts/smoke-test-mcp-credential-preflight.mjs`: in modalità non interattiva verifica exit code 1, diagnostica actionable, assenza di `package.json` e preservazione del placeholder. Test verde.
