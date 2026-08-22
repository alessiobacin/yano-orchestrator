Type: task
Status: resolved
Blocked by: 08, 16, 21, 46

## Question

Verificare che un MCP dichiarato sia realmente avviabile e risponda al protocollo MCP prima di usarlo come capability.

## Acceptance Criteria

- La sorgente `capability:mcp:<name>:handshake` usa solo server presenti nella configurazione MCP attiva.
- Il comando viene eseguito senza shell arbitraria, con timeout e buffer bounded.
- Viene inviato un `initialize` JSON-RPC e serve una risposta con `id`, `protocolVersion` e `serverInfo`.
- Configurazioni mancanti, server non avviabili o handshake invalido falliscono closed.
- L’evidenza verificata viene persistita e resa idempotente dal producer Playbook.

## Resolution

Implementata la probe MCP stdio nel producer `playbook_evidence_record`, con risoluzione di `.mcp.json`, `.pi/mcp.json` o `mcp.json`, timeout 5s e nessuna esecuzione tramite shell. Aggiunto smoke test con server MCP fixture e dichiarazione assente: ticket engine 71 assertion verdi.
