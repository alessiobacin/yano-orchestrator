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

Import e promozione passano dall’architect, che segnala conflitti e requisiti
mancanti. remove disabilita logicamente; purge elimina dopo conferma esplicita.
