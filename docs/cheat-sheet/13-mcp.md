# yano mcp

Verifica i server MCP configurati e quelli associati a un ruolo.

~~~bash
yano mcp
yano mcp planner
yano mcp --json
~~~

Per installazione, autenticazione o errori di un MCP seguire le istruzioni
riportate dal comando e dal playbook coinvolto.

## MCP per singolo agente

```bash
yano mcp agent list --json
yano mcp agent list --agent computer-locale --json
yano mcp agent add --agent computer-locale --name evolution-api \
  --config '{"command":"npx","args":["-y","mcp-evolution-api"],"env":{"EVOLUTION_API_URL":"${YANO_CONFIG:EVOLUTION_API_URL}","EVOLUTION_API_KEY":"${YANO_CONFIG:EVOLUTION_API_KEY}"}}'
yano mcp agent update --agent computer-locale --name evolution-api --config '<JSON>'
yano mcp agent show --agent computer-locale --name evolution-api --json
yano mcp agent remove --agent computer-locale --name evolution-api
```

`--agent` accetta il nome/ID dell'istanza. Le variabili `${YANO_CONFIG:KEY}`
vengono risolte dalla configurazione globale solo nel file runtime protetto.
Riavvia l'agente dopo una modifica.

`list` distingue `built_in` (MCP materializzati automaticamente), `added`
(aggiunti con CRUD CLI) ed `effective` (configurazione realmente disponibile).
I valori delle variabili segrete sono mascherati.
