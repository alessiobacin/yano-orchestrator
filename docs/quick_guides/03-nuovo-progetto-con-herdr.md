# Nuovo progetto: Herdr e planner automatici

Usa questa procedura quando vuoi che Yano crei o riusi il workspace Herdr,
porti il workspace in primo piano e avvii subito planner-01 nella tab root.

## Creare e avviare tutto in un comando

~~~
mkdir mio-progetto
cd mio-progetto
yano init --name "Mio Progetto" --herdr
~~~

Il comando:

1. verifica i prerequisiti;
2. crea il workspace Herdr con il nome della cartella;
3. esegue 'yano init' nella root del workspace;
4. esegue 'yano start --instance planner-01 --role planner' nella stessa tab;
5. apre o aggancia il client Herdr se il comando è stato lanciato da una shell
   normale.

Non eseguire nuovamente 'yano start' nella stessa tab: rischieresti di aprire
un secondo planner.

## Se il progetto esiste già

Vai nella root dell'applicazione e usa:

~~~
cd /percorso/mio-progetto
yano init --name "Mio Progetto" --herdr
~~~

La modalità '--herdr' lavora in-place e non usa '--target'. I file applicativi
esistenti, package.json e .env.example vengono preservati.

## Controllare che il planner sia online

Da un'altra tab Herdr o da un terminale:

~~~
yano fleet
yano status
yano trace status
~~~

Se il planner non compare, verifica che il broker sia attivo e che il comando
'yano start' abbia usato la root corretta del progetto.
