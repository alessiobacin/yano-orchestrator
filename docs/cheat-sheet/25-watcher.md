# yano watcher

Controlla periodicamente il flusso degli agenti senza modificare il progetto
applicativo.

~~~bash
yano watcher init --project-root "$PWD" --interval-ms 60000 --lookback-ms 3600000
yano watcher start --project-root "$PWD"          # apre/riusa la tab Herdr yano-watcher
yano watcher status --json                        # stato registrato + self-heal di un pane morto
yano watcher pause --project-root "$PWD"
yano watcher resume --project-root "$PWD"
yano watcher projects --all --json                # presenza Herdr/Pi effettiva (Architect/registro)
yano watcher resume --project-root "$PWD"        # riattiva esplicitamente un progetto idle
yano watch --project-root "$PWD" --once
~~~

`yano watcher start`/`resume` registrano il progetto in un piccolo registro
SQLite e lanciano/riusano `yano watch --interval-ms ... --away` (zero-token,
nessun LLM) in una tab Herdr supervisionata del workspace `yano-watcher`. A
differenza di un `yano watch --away` lanciato a mano in un terminale, il
registro sopravvive a un riavvio: `yano watcher status` confronta lo stato
registrato con quello reale e, salvo `--no-heal`, rilancia da solo un pane
morto (Mac in sleep, terminale chiuso, Herdr riavviato) — è il comando da
rilanciare periodicamente (o dopo ogni risveglio del Mac) per essere certi
che il polling sia ancora vivo. Gli eventi di scansione finiscono nel trace
del progetto osservato; vedi `docs/quick-guides/10-watcher-falle-yano.md`.

Il recovery identifica il workspace dal percorso della repository, non dalla
sola etichetta: `llmproxy` e `llmProxy` sono quindi trattati come lo stesso
progetto. Un planner già vivo viene riusato e non viene mai lanciato un
secondo `planner-01`.

Ogni passata chiude anche le tab degli agenti che hanno concluso il lavoro
(incluse quelle il cui processo è terminato del tutto e non appare più in
Herdr) — anche per un progetto in pausa. La tab del planner e quella
`human` non vengono mai toccate. Dettaglio: `docs/quick-guides/10-watcher-falle-yano.md`,
`docs/diagram/12-pulizia-tab-agenti.mmd`.
