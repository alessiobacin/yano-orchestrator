# yano auto-improve

Analizza periodicamente un progetto e produce suggerimenti, senza applicare
modifiche al codice.

~~~bash
yano auto-improve init --project-root "$PWD" --interval 5d --notify auto
yano auto-improve start --project-root "$PWD" --once
yano auto-improve run --project-root "$PWD" --once
yano auto-improve status --project-root "$PWD"
yano auto-improve reports --project-root "$PWD"
~~~

I report vengono inoltrati al planner, che decide con l’utente se trasformarli
in lavoro.
