# yano agent

Consulta il catalogo degli agenti e il dettaglio delle loro capacità.

~~~bash
yano agent list
yano agent list --json
yano agent show planner --json
yano agent show watcher --json
~~~

Per lo stato live nel progetto usare yano fleet; per i worker esterni usare
anche i comandi ruolo-specifici, come yano watcher projects.
