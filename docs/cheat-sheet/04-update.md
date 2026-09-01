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

Con installazione di sviluppo `npm link`, `yano update` aggiorna il checkout
Git solo se è pulito; non prova a reinstallare sopra il symlink.
