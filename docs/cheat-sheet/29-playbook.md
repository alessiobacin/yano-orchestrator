# yano playbook

Esplora, verifica, trasporta e gestisce il catalogo globale dei playbook.

~~~bash
yano playbook list --json
yano playbook show knowledge-authoring --json
yano playbook check bundle.json --json
yano playbook candidates --task "Scrivere documentazione" --json
yano playbook export knowledge-authoring --out knowledge-authoring.json
yano playbook import knowledge-authoring.json --dry-run --json
yano playbook remove knowledge-authoring --yes
yano playbook purge knowledge-authoring --yes
~~~

Nel piano runtime di `clean-repo`, `repo-curator` è il ruolo obbligatorio della
fase 1; `docs-sync` resta nella fase finale e `reviewer` verifica il risultato.

Import e promozione passano dall’architect, che segnala conflitti e requisiti
mancanti. remove disabilita logicamente; purge elimina dopo conferma esplicita.

Il binding di una run non è un comando CLI: il Planner chiama il tool
orchestrator `playbook_bind` dopo `run_create` e conserva il checksum. Non
usare `yano playbook bind` da shell.
