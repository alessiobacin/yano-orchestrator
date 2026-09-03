# `full-stack-developer` — implementazione cross-layer proporzionale

Il planner valuta questo playbook quando un task tocca sia frontend sia
backend, ma non richiede più specialisti indipendenti. Propone sempre la
topology prima di avviare il lavoro:

1. `full-stack-developer → full-stack-reviewer` per modifiche normali o con
   rischio non banale;
2. `full-stack-developer` con self-review distinta solo per task locali,
   semplici e a basso rischio, motivando la scelta nel report.

Il full-stack developer esegue test backend, verifica browser/E2E quando la UI
è eseguibile, aggiorna i documenti pertinenti e inoltra il lavoro al reviewer.
Il full-stack reviewer separa Spec e Standards, ripete le verifiche e approva
o respinge con evidenze riproducibili. `docs-sync` resta il gate documentale
finale e il planner mantiene la conferma utente prima di finalizzare.

Ogni relazione autonoma prodotta dagli agenti va in
`docs/reports/<tipo>-<gg-mm-HH_MM>.md`; il report condiviso del task resta
quello usato per il coordinamento dei round.
