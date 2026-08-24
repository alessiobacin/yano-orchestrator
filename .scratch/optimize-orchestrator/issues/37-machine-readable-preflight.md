Type: human
Kind: task
Status: resolved
Blocked by: 11, 16, 36

## Question

Esportare il preflight di `yano` in forma machine-readable per enforcement deterministico e integrazione con installer/CI.

## Resolution

`yano doctor --json` ora restituisce `{ ok, checks[] }` con stato e dettaglio per ogni prerequisito, mantenendo invariato l’output umano predefinito. `yano init` continua a bloccare prima delle scritture quando `ok=false`. Verificati parsing JSON, exit code e help CLI.
