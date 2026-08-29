# yano repair

Riconcilia identità progetto, pane Herdr, presenza MQTT, database e worker.

~~~bash
yano repair --dry-run
yano repair --yes
yano repair --all-projects --dry-run
yano repair --all-projects --yes --update
~~~

Usare prima --dry-run. --force può interrompere un processo non cooperativo.
La riparazione salva uno snapshot e non cancella codice, trace o database.
