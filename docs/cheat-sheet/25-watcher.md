# yano watcher

Controlla periodicamente il flusso degli agenti senza modificare il progetto
applicativo.

~~~bash
yano watcher init --project-root "$PWD" --interval-ms 300000 --lookback-ms 3600000
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
