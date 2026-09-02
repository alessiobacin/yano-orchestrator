# yano update

Aggiorna l’installazione globale e, opzionalmente, ricarica gli agenti attivi
tramite snapshot e riavvio controllato.

~~~bash
yano update --check
yano update
yano update --reload --dry-run --timeout 180
yano update --reload --yes --timeout 180
~~~

Usare --reload quando le istanze devono eseguire il nuovo codice. Il processo
salva prima lo stato e non cancella file applicativi o trace.

Se rileva `npm link`, `yano update` rimuove esclusivamente quel symlink e
installa una copia globale permanente da GitHub. La modalità viene stampata
nell'output; `npm ls -g yano-orchestrator --depth=0` non deve contenere `->`.
Il repository viene clonato e impacchettato in un tarball prima dell’installazione,
così `allow-scripts` globale non blocca l’update.
