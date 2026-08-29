# yano recovery

Ispeziona gli snapshot disponibili e lo stato dei ripristini.

~~~bash
yano recovery list
yano recovery list --project sales-companion
yano recovery status
yano recovery status --project sales-companion
~~~

Non elimina snapshot: per la cancellazione esplicita usare yano data o yano
trace clear secondo l’ambito desiderato.
