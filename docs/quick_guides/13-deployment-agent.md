# Deployment agent: guida rapida

Il planner deve assegnare `deployment-agent` con il Playbook
`deployment-delivery` dopo sviluppo, review e documentazione del task.

## Preflight

```bash
yano deps --cli git,npm,npx,docker,docker-compose,curl
git status --short
git rev-parse HEAD
```

Scegli una base `B` tra `3000` e `3999`, controlla tutte le porte e registra:

```text
backend:  B / B+1000 / B+2000
frontend: B+3000 / B+4000 / B+5000
```

Development deve usare `~/projects/<project-name>`; staging e production
devono usare Docker/Compose.

## Staging

```bash
docker compose -f compose.yml -f compose.staging.yml config
docker compose -f compose.yml -f compose.staging.yml build
docker compose -f compose.yml -f compose.staging.yml up -d
curl --fail --retry 20 --retry-delay 2 http://127.0.0.1:<porta-staging>/health
```

Esegui gli smoke/integration/E2E test del progetto e registra commit, immagine,
digest, porte, log e risultati nel report.

## Production

Attendi sempre l'approvazione esplicita dopo il test fisico di staging. Prima
salva immagine/configurazione precedente e comando di rollback; poi promuovi lo
stesso digest, senza `latest` e senza rebuild.

Se healthcheck o smoke test production falliscono, blocca il rilascio o fai
rollback, conserva le evidenze e informa il planner. Non usare Kubernetes o
CLI cloud senza assegnazione esplicita dello specialista e capability verificata.

Vedi [la guida completa](../yano-deployment.md) e la skill
`skills-vendor/yano/yano-deployment/SKILL.md`.
