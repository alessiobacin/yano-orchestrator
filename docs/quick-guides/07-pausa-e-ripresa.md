# Mettere in pausa e riprendere un task

Usa pause quando vuoi fermare il lavoro senza chiudere il run.

## Anteprima

~~~
yano pause --all
~~~

L'anteprima salva lo snapshot ma non ferma gli agenti.

## Pausa effettiva

~~~
yano pause --all --reason "pausa manuale prima della chiusura del laptop" --yes
yano recovery status
~~~

Per un solo run:

~~~
yano pause --run <run-id> --reason "attendo indicazioni sul requisito" --yes
~~~

La pausa conserva stato SQLite, ticket, worktree, branch, trace e presenza
osservata. Non chiude il run e non cancella file.
La motivazione è obbligatoria per ogni pausa, inclusa una pausa richiesta dal
planner o dal cron; le pause automatiche registrano una motivazione
diagnostica generata dal sistema.

## Riprendere il lavoro

Prima controlla cosa verrebbe rilanciato:

~~~
yano resume --all --dry-run
~~~

Poi avvia il ripristino nelle tab Herdr:

~~~
yano resume --all --yes
~~~

Yano riapre solo gli agenti mancanti e non duplica quelli già online. Il
planner viene avviato con '--continue' e ricostruisce il contesto da database,
ticket, worktree, report e trace.

## Differenza tra pausa e chiusura

~~~
yano end --list
yano end --run <run-id> --yes
~~~

'yano end' chiude il run a livello orchestratore. Non usarlo per sospendere un
task che vuoi continuare più tardi.
