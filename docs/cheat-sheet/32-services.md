# Yano Services — servizi esterni supervisionati

```bash
# Registra un servizio esterno (health-check + comando di restart)
yano services add --name llmproxy \
  --healthcheck-http http://127.0.0.1:7045/api/providers --restart-pm2 llmproxy
yano services add --name mqtt-broker \
  --healthcheck-command "docker inspect -f {{.State.Running}} yano-mqtt-broker | grep -q true" \
  --restart-docker yano-mqtt-broker

# CRUD
yano services list --json
yano services enable --name llmproxy
yano services disable --name llmproxy
yano services remove --name llmproxy

# Sola lettura (nessun restart) vs. ciclo reale con restart e backoff
yano services check --json
yano services supervise --json
```

`yano watcher supervise` (cron ogni minuto) chiama già `yano services
supervise` a ogni passata: registrare qui un servizio basta perché venga
controllato e riavviato automaticamente dopo un riavvio del computer o un
crash del container/processo, senza intervento manuale. Il backoff
esponenziale (`--backoff-base-ms`/`--backoff-max-ms`/`--max-attempts`,
default 5s/5min/6) evita di martellare un target che non può tornare su da
solo: dopo i tentativi esauriti lo stato diventa `giving_up` e il servizio
resta solo osservato, non più riavviato, finché non torna sano da solo o
viene corretto manualmente.
