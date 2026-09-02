# Job ricorrenti e Yano Scheduler (script-first)

`yano-scheduler` è un agente globale supervisionato: il cron Yano lo controlla
ogni minuto, ricrea la sua tab Herdr se manca e legge il registro persistente
nel data-root globale (`<data>/scheduler/jobs.json`). I job restano
disponibili dopo logout, riavvio di Herdr o riavvio del computer.

Dal modello storico ("il cron passa il testo del task a un planner") lo
scheduler è passato a un modello **script-first**: al trigger si esegue **lo
script registrato**; l'LLM entra solo se lo script lo decide (routing).

## Che cosa fa lo scheduler

- È un agente **minimale**: scrive script deterministici e li registra come
  schedule. Non coordina altri agenti e non fa handoff broadcast: risponde
  solo al chiamante (utente nella chat dello scheduler, o un planner che chiede
  "schedula X una volta / in modo ricorrente").
- **Audit locale alla creazione**: ogni script è scritto e validato prima di
  essere registrato, e l'agente lo testa con `yano schedule run <id>` prima di
  renderlo ricorrente.
- È **read-only di default**: non modifica il progetto né committa; scrive
  solo nel folder script persistente. Azioni distruttive o che modificano il
  progetto passano sempre dal planner di progetto con gate umani.

## Creare un job (script-first)

L'agente scheduler scrive lo script nel folder persistente utente
(`<data>/scheduler/scripts/` — mai dentro il pacchetto, un upgrade non lo
cancella) e registra lo schedule:

```bash
yano schedule add --name <nome> --project-root "$PWD" \
  --script /percorso/assoluto/dello/script.mjs \
  --mode self \
  --cron '0 14,21 * * *' \
  --expected-consequence "riepilogo inviato"
```

Flag chiave:

- `--mode self|planner:<progetto>|computer-locale` — dichiara il routing:
  - `self` — lo script gira da solo, nessun LLM;
  - `planner:<progetto>` — lo script (o il job) sveglia il planner del
    progetto target con il task, via `yano invoke --role planner:<progetto>`;
  - `computer-locale` — lo script delega a computer-locale (promemoria,
    calendario, note, contatti, mappe, posta, messaggi, memo vocali);
- `--once` — one-shot: il job si auto-disabilita dopo la prima esecuzione;
- `--timeout-ms N` — timeout massimo di esecuzione dello script
  (default 120000 ms);
- `--expected-consequence <testo>` — conseguenza attesa documentata nel job.

La sintassi storica in linguaggio naturale resta disponibile per i job legacy:
`yano cron --add "ogni giorno alle 14 e alle 21 esegui ..." --project-root "$PWD"`
(dispatch planner col testo, come in passato — non a script).

## Testare e gestire

```bash
yano schedule run <job-id>        # esegue LO SCRIPT registrato subito (test!)
yano schedule list --json         # job con script_path, mode, expected_consequence, stato
yano schedule disable --id <job-id>
yano schedule enable --id <job-id>
yano schedule remove --id <job-id>
```

Regola d'oro: **prima di rendere ricorrente uno script, eseguilo con
`yano schedule run <id>`** e verifica l'esito. Se lo script manca o fallisce,
il dispatch registra `failed` e disabilita il job (`enabled:false`) con un
fallback loggato — mai testo libero verso un planner dal cron.

## Bridge invocabile dagli script: `yano invoke`

Dentro uno script si sveglia il planner di progetto o computer-locale con un
comando deterministico (nessuna shell, nessun broker da gestire a mano):

```bash
yano invoke --role planner:<progetto> --prompt "riepiloga lo stato del progetto" --project-root "$PWD"
yano invoke --role computer-locale --prompt "promemoria tra 10 minuti: pausa caffè"
```

`--role planner[:<scope>]` compone il lancio `yano start --herdr --role
planner --project <scope> --print-only` dal root target; `computer-locale`
delega all'esistente `yano computer ask` (broker-aware, timeout, mai hang).

## Supervisore e cron di sistema

Il supervisore globale gira ogni minuto: ricrea la tab `scheduler-service` nel
workspace `yano-scheduler` se manca (evitando l'errore Herdr
`agent_kind_mismatch`) e fa tick dei job in scadenza. Lo stato della riga cron
marcata si controlla con `yano schedule cron status`; `yano schedule cron
install|remove` gestiscono la riga di sistema (su Windows `schtasks`), mentre
`yano uninstall` pulisce automaticamente i cron posseduti da Yano.

## Sicurezza

Niente shell arbitrari, token, pipe, redirezioni o comandi liberi nei job:
l'unico eseguibile è lo script registrato e validato (eseguito dal runtime
Node come file, mai da una shell). Token e credenziali si leggono da `.env`
dentro lo script, mai incorporati. Le modalità che modificano il progetto
passano dal planner con gate umani.