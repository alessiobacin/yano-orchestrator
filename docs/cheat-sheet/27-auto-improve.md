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

Playbook usato dal ruolo: `auto-improvement-360`.

Ordine: preflight → modalità progetto → report precedenti → evidence →
performance/architettura → backend/API/dati → frontend/UX se applicabile →
feature/prodotto → micro-test → score/dedup → report → planner.

Regola: nessuna invenzione. Ogni parere ha `score /10`, motivazione,
`confidence /10`, tipo di evidenza e riferimenti.
