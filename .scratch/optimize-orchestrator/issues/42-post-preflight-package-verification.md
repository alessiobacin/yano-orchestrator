Type: task
Status: resolved
Blocked by: 35, 39, 41

## Question

Verificare che preflight broker/credential e relativi smoke test siano presenti nel tarball installabile.

## Resolution

`npm pack` + installazione temporanea verificati: il tarball include `doctor.mjs`, `create-project.mjs`, i due smoke test di preflight, `mcp.json.example` e Playbook; il binario installato esegue `yano --version` e `yano doctor --json` correttamente.
