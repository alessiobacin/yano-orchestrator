# yano init

Inizializza l’infrastruttura Yano nella directory corrente o in un target
esistente. Non sovrascrive file applicativi.

~~~bash
yano init --name "Mio Progetto"
yano init --name "Mio Progetto" --herdr
yano init --target /percorso/progetto --name "Mio Progetto" --force
~~~

--herdr apre il workspace e il planner; --force serve solo quando il target
contiene già l’infrastruttura da aggiornare. `cm` (Code Mem) è obbligatorio:
prima dello scaffold `yano init` esegue `cm init pi`, creando `memory/`, la
skill Pi locale e il relativo hook non bloccante.
