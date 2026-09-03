# Yano Scheduler — job ricorrenti a script (script-first)

```bash
# Registra uno schedule che esegue LO SCRIPT registrato (mode self|planner:<progetto>|yano-local-pc)
yano schedule add --name <nome> --project-root "$PWD" --script <path> --mode self --cron '0 14,21 * * *' --expected-consequence "riepilogo inviato"
yano schedule add --name backuppone-shot --project-root "$PWD" --script <path> --mode self --cron '0 0 * * *' --once

# Test PRIMA di renderlo ricorrente — esegue lo script subito
yano schedule run <job-id>

# Gestione
yano schedule list --json            # script_path, mode, expected_consequence, stato
yano schedule instances --id <job-id> --limit 20 --json  # ultime istanze e status
yano schedule retry --id <instance-id> --json             # retry manuale dell'istanza
yano schedule disable --id <job-id>
yano schedule enable --id <job-id>
yano schedule remove --id <job-id>

# Bridge deterministico chiamabile DENTRO gli script
yano invoke --role planner:<progetto> --prompt "riepiloga lo stato" --project-root "$PWD"
yano invoke --role yano-local-pc --prompt "promemoria tra 10 minuti: pausa caffè"

# Sintassi storica in linguaggio naturale (job legacy, dispatch planner col testo)
yano cron --add "ogni giorno alle 14 e alle 21 esegui la pulizia del progetto" --project-root "$PWD"
yano cron --list --json
yano cron --disable <job-id> | --enable <job-id> | --run <job-id> | --remove <job-id>

# Supervisore persistente: controlla cron di sistema e tab Herdr yano-local-pc
yano schedule cron status|install|remove
```

Al trigger si esegue lo SCRIPT registrato (mai shell; runtime Node, file
validato nel folder persistente `<data>/scheduler/scripts/`). Se lo script
manca o fallisce: `enabled:false` + fallback loggato, mai testo libero a un
planner. Token/credenziali solo da `.env` dentro lo script, mai incorporati.
Azioni distruttive o che modificano il progetto: sempre planner + gate umani.
Il supervisore gira ogni minuto e ricrea `yano-local-pc` se manca; i job
sopravvivono a riavvii di Herdr e del computer.

Ad ogni passata controlla DNS Google (`8.8.8.8`/`8.8.4.4`), MQTT, Herdr e
registra l'esecuzione del cron in `checks.cron`.
Se la connettività passa offline mette in pausa con checkpoint i progetti
attivi; quando torna online riprende solo quelli messi in pausa
automaticamente. Dettagli e transizioni: `<YANO_DATA_DIR>/logs/scheduler-connectivity.jsonl`.
