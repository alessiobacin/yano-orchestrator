# yano resume

Riprende un run da snapshot e riapre gli agenti mancanti.

~~~bash
yano resume --run RUN_ID --project sales-companion --dry-run
yano resume --run RUN_ID --project sales-companion --yes
yano resume --run RUN_ID --all --yes
~~~

Controllare prima il piano con --dry-run, soprattutto dopo un aggiornamento.
