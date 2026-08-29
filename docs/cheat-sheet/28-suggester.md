# yano suggester

Raccoglie e classifica suggerimenti degli utenti senza modificare la repo.

~~~bash
yano suggester init --project-root "$PWD" --notify auto
yano suggester submit --project-root "$PWD" --title "Idea" --description "Dettagli"
yano suggester start --project-root "$PWD" --once
yano suggester status --project-root "$PWD"
yano suggester approve --suggestion-id SUGGESTION_ID --actor superadmin --yes
~~~

Solo dopo l’approvazione del superadmin il planner può pianificare
l’implementazione.
