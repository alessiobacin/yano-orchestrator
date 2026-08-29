# yano config

Gestisce la configurazione globale e i segreti necessari ai comandi.

~~~bash
yano config path
yano config list --all
yano config get KEY
printf '%s' "$SECRET" | yano config set KEY --stdin
yano config set KEY VALUE
yano config unset KEY
~~~

I valori sensibili sono mascherati. YANO_DATA_DIR è opzionale e usa un percorso
predefinito conforme alla piattaforma.
