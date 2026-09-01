# Yano Scheduler — job ricorrenti

```bash
# Crea un job dalla root del progetto: restituisce l'id persistente
yano cron --add "ogni giorno alle 14 e alle 21 esegui la pulizia del progetto" --project-root "$PWD"
yano cron --add "ogni settimana di lunedì alle 13:00 fai partire un resoconto delle risorse del server via Telegram" --project-root "$PWD"

# CRUD e avvio manuale
yano cron --list --json
yano cron --disable <job-id>
yano cron --enable <job-id>
yano cron --run <job-id>
yano cron --remove <job-id>

# Supervisore persistente: controlla cron e tab Herdr yano-scheduler
yano cron --status --json
yano cron --supervise --json
yano cron --install
yano cron --uninstall
```

Il supervisore cron gira ogni minuto e ricrea `yano-scheduler` se manca. I job
sono nel data-root globale e sopravvivono al riavvio. Un job avvia un planner
nel progetto scelto, senza aggirare i gate del playbook o le approvazioni.
