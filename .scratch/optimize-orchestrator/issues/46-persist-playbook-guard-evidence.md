Type: human
Kind: task
Status: resolved
Blocked by: 12, 24, 26

## Question

Impedire che una transizione Playbook venga autorizzata da una lista di guardie auto-dichiarata dal chiamante.

## Acceptance Criteria

- Le evidenze sono persistite per `run_id`, requisito, sorgente e chiave d’idempotenza.
- La registrazione è idempotente e auditata.
- `playbook_transition` consuma solo evidenze persistite e rifiuta requisiti mancanti.
- La lista `satisfied_requirements` non è più una superficie di bypass.
- Esistono test per persistenza, retry e rifiuto della guardia mancante.

## Resolution

Aggiunte la tabella `playbook_evidence`, i metodi storage e i tool `playbook_evidence_record`/`playbook_evidence_list`. Le transizioni verificano il set persistito nel run prima dell’update atomico di stato, effetti e audit. Le sorgenti sono ora verificate dal runtime: `run:objective_present`, `ticket:<id>:done`, `hold:<id>:answered`, probe bounded `capability:cli:<name>:available`, handshake MCP stdio `capability:mcp:<name>:handshake` e probe `capability:skill:<name>:loadable`; sorgenti arbitrarie vengono rifiutate. Smoke ticket engine aggiornato: 71 assertion verdi.
