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
yano mcp agent list --agent yano-local-pc --json
yano mcp agent add --agent yano-local-pc --name evolution-api \
  --config '{"command":"npx","args":["-y","mcp-evolution-api"],"env":{"EVOLUTION_API_URL":"${YANO_CONFIG:EVOLUTION_API_URL}","EVOLUTION_API_KEY":"${YANO_CONFIG:EVOLUTION_API_KEY}"}}'
yano mcp agent update --agent yano-local-pc --name evolution-api --config '<JSON>'
yano mcp agent show --agent yano-local-pc --name evolution-api --json
yano mcp agent remove --agent yano-local-pc --name evolution-api
```

`--agent` accetta il nome/ID dell'istanza. Le variabili `${YANO_CONFIG:KEY}`
vengono risolte dalla configurazione globale solo nel file runtime protetto.
Riavvia l'agente dopo una modifica.

`list` distingue `built_in` (MCP materializzati automaticamente), `added`
(aggiunti con CRUD CLI) ed `effective` (configurazione realmente disponibile).
I valori delle variabili segrete sono mascherati.

Il template di progetto dichiara sempre anche `agentation`:
`npx -y agentation-mcp server`. La capability è assegnata al planner, che
riceve le annotazioni e le inoltra al frontend developer quando sono problemi
frontend. Per preparare una review visuale usa `yano frontend-review start`;
il planner lo esegue solo dopo il consenso dell'utente.
