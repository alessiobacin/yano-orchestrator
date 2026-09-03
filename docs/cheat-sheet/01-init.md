# yano init

Inizializza l’infrastruttura Yano nella directory corrente o in un target
esistente. Non sovrascrive file applicativi.

~~~bash
yano init --name "Mio Progetto"
yano init --name "Mio Progetto" --dev-pc
yano init --name "Mio Progetto" --herdr
yano init --target /percorso/progetto --name "Mio Progetto" --force
~~~

--dev-pc abilita esplicitamente l'agente globale `yano-local-pc` per il PC
dello sviluppatore. Senza il flag non viene creato. --herdr apre il workspace e il planner; --force serve solo quando il target
contiene già l’infrastruttura da aggiornare. `cm` (Code Mem) è obbligatorio:
prima dello scaffold `yano init` esegue `cm init pi`, creando `memory/`, la
skill Pi locale e il relativo hook non bloccante.
