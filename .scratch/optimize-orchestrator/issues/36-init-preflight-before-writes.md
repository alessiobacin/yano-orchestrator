Type: human
Kind: task
Status: resolved
Blocked by: 11, 17, 22

## Question

Garantire che `yano init` esegua il preflight prima di qualsiasi scrittura e fallisca con istruzioni operative se manca un prerequisito.

## Resolution

`scripts/create-project.mjs` esegue ora `yano doctor` all’inizio del flusso. Se il preflight fallisce, restituisce exit code 1, stampa i comandi di correzione e conferma che non è stato scritto alcun file. Verificato con `pi` assente sul PATH: directory target rimasta vuota. Verificato anche il percorso positivo: scaffold, package.json e due Playbook creati correttamente.
