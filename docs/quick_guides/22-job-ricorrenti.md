# Job ricorrenti e Yano Scheduler

`yano-scheduler` è un agente globale supervisionato: il cron Yano lo controlla
ogni minuto, ricrea la sua tab Herdr se manca e legge il registro persistente
nel data-root globale. I job restano disponibili dopo logout, riavvio di Herdr
o riavvio del computer.

## Creare un job in linguaggio naturale

Dalla root del progetto interessato:

```bash
yano cron --add "ogni giorno alle 14 e alle 21 voglio che esegui la pulizia del progetto" --project-root "$PWD"
```

Yano restituisce l'ID del job e traduce la frequenza in `0 14,21 * * *`. Sono
supportati anche appuntamenti settimanali, ad esempio:

```bash
yano cron --add "ogni settimana di lunedì alle 13:00 fai partire un resoconto delle risorse del server via Telegram" --project-root "$PWD"
```

Il job avvia un planner nel workspace del progetto con il task salvato. Non
esegue shell arbitraria e non bypassa i gate: `clean-repo`, per esempio,
continua a richiedere il piano e l'approvazione prima di eliminare file.

## Gestione e ripristino

```bash
yano cron --list --json
yano cron --disable <job-id>
yano cron --enable <job-id>
yano cron --run <job-id>
yano cron --remove <job-id>
yano cron --supervise --json
```

L'installazione globale di Yano aggiunge una sola riga cron marcata. Controlla
lo stato con `yano cron --status`; `yano cron --uninstall` rimuove solo quella
riga. `yano uninstall` pulisce automaticamente i cron posseduti da Yano.
Il supervisore del scheduler, dopo un riavvio di Herdr o del computer, ricrea
la tab `scheduler-service` nel workspace `yano-scheduler` e avvia Pi
direttamente nella pane posseduta. Questo evita l'errore Herdr
`agent_kind_mismatch` causato da `herdr agent start`.
