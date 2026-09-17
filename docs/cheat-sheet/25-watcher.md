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

La scansione rileva anche due timeout `agent_await` consecutivi sullo stesso
assignment (`agent_await_stalled`), indipendentemente dallo stato del ticket.
L'evento diagnostico è `yano_watcher_await_check`.

La pulizia confronta anche l'identificativo della sessione Pi: se più pane
vive puntano alla stessa sessione persistita, conserva una sola superficie e
chiude le copie duplicate (`duplicate_pi_session`).

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

Se una nuova sessione viene rilanciata dopo un ticket terminale precedente, il
watcher la riconosce come sostituzione e non la chiude. Se un ticket pronto
resta non assegnato, invia inoltre al planner vivo il comando deduplicato
`watcher_ready_queue_retry` per ritentare l'apertura del worker.

Quando il progetto attende l'utente, la scansione non sveglia nessuno:
`waiting_for_user` con `llm_wakeups: 0`, senza comandi MQTT né recovery. Lo
stato è deterministico (domanda esplicita persistita oppure tutti i run
attivi con hold aperti) e si rilascia da solo alla risposta. `yano status`
espone `user_wait` e i ticket assegnati ad agenti assenti riportano azione
`wait`.

Se la root registrata non esiste più, il watcher non recupera nel percorso
morto: restituisce `project_relocated` (stesso progetto trovato altrove →
proposta via hold, mai rewrite automatico; re-add con
`yano watcher init --project-root <nuovo>`) oppure `project_root_missing`
(stop esplicito, mai cancellazione silenziosa). Ogni passata chiude anche le
tab di manutenzione orfane (workspace `yano-auto-improver`/`yano-architect`
senza agenti live né processo `pi`; label `human*`/`planner` mai toccate) e
conta `orphan_maintenance_tabs_removed`. I run con hold aperti sono esclusi
da orfani/ready/stalled. Dettaglio:
`docs/quick-guides/10-watcher-falle-yano.md`.
