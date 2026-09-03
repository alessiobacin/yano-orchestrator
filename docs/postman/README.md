# Postman collections

Questo folder contiene le collection JSON importabili per gli endpoint HTTP
del control plane Yano. Le collection devono restare allineate a
`scripts/yano-feedback.mjs` e vanno aggiornate da `docs-sync` quando cambiano
contratto, payload o stati.

- `yano-feedback.postman_collection.json`: bug e suggestion sulla porta 20002.
- `yano-feedback.postman_environment.json`: environment locale senza segreti.

I valori sensibili non devono essere salvati nelle collection: configurarli
tramite `yano config set` o variabili d'ambiente.
