Type: task
Status: resolved
Blocked by: 08, 09

## Question

Collegare esplicitamente la guida di ricerca e la chiusura `to-spec` → `to-tickets` al prompt del planner.

## Resolution

Aggiornato `prompts/planner.md` con riferimento a `prompts/research-guide.md`, fallback onesto quando la verifica non è possibile e chiarimento che `to-tickets` usa i ticket locali e non è una skill vendored. La smoke test planning-flow ora passa con 8 assertion.
