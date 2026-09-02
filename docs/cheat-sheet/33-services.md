# Yano Services — servizi esterni supervisionati

```bash
# Registra un servizio esterno (health-check + comando di restart)
yano services add --name llmproxy \
  --healthcheck-http http://127.0.0.1:7045/api/providers --restart-pm2 llmproxy
yano services add --name mqtt-broker \
  --healthcheck-command "docker inspect -f {{.State.Running}} yano-mqtt-broker | grep -q true" \
  --restart-docker yano-mqtt-broker

# Nome riservato "herdr": se registrato, yano watcher supervise lo
# riavvia (con il comando dichiarato dall'operatore) PRIMA di tentare lo
# snapshot Herdr di ogni passata — Yano non indovina come avviare Herdr
# sulla tua macchina, lo dichiari tu una volta sola.
yano services add --name herdr \
  --healthcheck-command "herdr api snapshot >/dev/null 2>&1" \
  --restart-command "<comando reale di avvio di Herdr>"

# Il daemon Docker ha invece un comando noto per sistema operativo — yano
# init/doctor lo tenta già da solo una volta (ticket #120); registrarlo qui
# lo fa ricontrollare e riavviare a ogni passata del cron.
yano services add --name docker \
  --healthcheck-command "docker info" \
  --restart-command "systemctl start docker || service docker start"  # macOS: open -a Docker

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

## Prerequisiti Docker integrati

Quando Docker Desktop/Engine è raggiungibile, ogni passata del supervisore
scopre automaticamente e controlla:

- `llmproxy-production` (override: `YANO_LLMPROXY_CONTAINER`);
- `pi-orchestrator-mqtt-dev` (override: `YANO_MQTT_CONTAINER`).

Per ciascuno verifica lo stato `Running` e, se necessario, esegue un solo
`docker restart` rispettando il backoff. Sono visibili senza aggiungerli:

```bash
yano services list --json
yano services check --json        # sola lettura
yano watcher supervise --json    # controllo + eventuale recovery
```

Su macchine che non usano questi container si può disattivare la scoperta con
`YANO_DISABLE_BUILTIN_DEPENDENCY_SUPERVISION=1`. Il daemon Docker non viene
avviato alla cieca: se Docker non risponde, Yano lo segnala; per riavviarlo va
registrato un servizio `docker` con il comando corretto per il sistema operativo.

I servizi globali Yano pubblicano anche un heartbeat applicativo su disco,
oltre al controllo di processo/Herdr: un processo vivo ma senza heartbeat
aggiornato non è considerato sano dopo la fase iniziale di avvio.
