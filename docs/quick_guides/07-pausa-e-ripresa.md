# Mettere in pausa e riprendere un task

Usa pause quando vuoi fermare il lavoro senza chiudere il run.

## Anteprima

~~~
yano pause --all
~~~

L'anteprima salva lo snapshot ma non ferma gli agenti.

## Pausa effettiva

~~~
yano pause --all --yes
yano recovery status
~~~

Per un solo run:

~~~
yano pause --run <run-id> --yes
~~~

La pausa conserva stato SQLite, ticket, worktree, branch, trace e presenza
osservata. Non chiude il run e non cancella file.

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
