# Deployment di un progetto con Yano

Il deploy viene eseguito dal ruolo `deployment-agent`, assegnato dal planner
con il Playbook `deployment-delivery`. Gli specialisti `dockerizer`,
`k8s-orchestrator` e `cicd-architect` restano supporti: non autorizzano da soli
la promozione in produzione.

## Contratto degli ambienti

- development: codice sorgente nella checkout canonica
  `~/projects/<project-name>`, avviato localmente;
- staging: sempre Docker/Compose;
- production: sempre Docker/Compose.

Si sceglie una base backend `B` tra `3000` e `3999`; la stessa base identifica
il progetto in tutti gli ambienti:

| Servizio | development | staging | production |
| --- | ---: | ---: | ---: |
| Backend | `B` | `B+1000` | `B+2000` |
| Frontend | `B+3000` | `B+4000` | `B+5000` |

Con `B=3055`, per esempio, le porte sono backend `3055/4055/5055` e frontend
`6055/7055/8055`. Tutte e sei devono essere controllate prima del deploy e la
matrice deve essere registrata nel manifest del progetto e nel report.

## Flusso obbligatorio

1. Preflight di repository, stack, accessi, Docker/Compose, curl, porte e
   segreti.
2. Verifica dell'avvio development, test e healthcheck.
3. Build staging con Dockerfile multi-stage, runtime non-root, `.dockerignore`,
   healthcheck e immagine immutabile.
4. Avvio e validazione staging con healthcheck, smoke/integration/E2E test,
   log, porte e digest.
5. Attesa dell'accettazione fisica di staging da parte dell'utente o
   superadmin.
6. Salvataggio del rollback checkpoint e promozione in production dello stesso
   digest usato in staging.
7. Healthcheck e smoke test production; in caso di errore rollback al digest
   precedente e conservazione delle prove.

Production non deve usare `latest`, ricostruire l'immagine rispetto a staging,
ricevere secrets nel repository/layer Docker o eseguire migrazioni irreversibili
senza backup e approval espliciti.

## Capability e responsabilità

Il ruolo ha le CLI `git`, `npm`, `npx`, `docker`, `docker compose` e `curl`.
Nessun MCP remoto è obbligatorio per il deploy locale Docker/Compose; se serve
leggere CI/release GitHub, il planner può aggiungere `gh`/MCP GitHub come
capability esplicita. L'accesso cloud/Kubernetes non è implicito: se serve, il
planner deve assegnare il relativo specialista e verificare le capability.

La skill `yano-deployment` contiene il contratto operativo completo e viene
caricata automaticamente solo per `deployment-agent`. Il report deve contenere
preflight, port matrix, verifica development, build/validazione staging,
approval/promozione production, rollback checkpoint, test e verdetto.

Per inizializzare il worker globale del feedback applicativo usare invece
`yano feedback`; il feedback e il deployment agent sono ruoli distinti: il
primo corregge bug, il secondo rilascia una versione approvata.
