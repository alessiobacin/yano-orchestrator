# Job ricorrenti e Yano Scheduler (script-first)

`yano-local-pc` è il runtime globale supervisionato: il cron Yano lo controlla
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

- `--mode self|planner:<progetto>|yano-local-pc` — dichiara il routing:
  - `self` — lo script gira da solo, nessun LLM;
  - `planner:<progetto>` — lo script (o il job) sveglia il planner del
    progetto target con il task, via `yano invoke --role planner:<progetto>`;
  - `yano-local-pc` — lo script delega a yano-local-pc (promemoria,
    calendario, note, contatti, mappe, posta, messaggi, memo vocali);
- `--once` — one-shot: il job si auto-disabilita dopo la prima esecuzione;
- `--timeout-ms N` — timeout massimo di esecuzione dello script
  (default 120000 ms);
- `--expected-consequence <testo>` — conseguenza attesa documentata nel job.

La sintassi storica in linguaggio naturale resta disponibile per i job legacy:
`yano cron --add "ogni giorno alle 14 e alle 21 esegui ..." --project-root "$PWD"`
(dispatch planner col testo, come in passato — non a script).

## Job di default: digest giornaliero

Oltre ai job creati manualmente, Yano installa da sé — idempotentemente, ad
ogni passata del supervisore — un job di sistema: `yano-daily-digest`,
`mode: self`, `0 6 * * *` nel fuso `Europe/Rome` esplicito (i job creati con
`--cron` restano invece nel fuso del server, comportamento invariato). Invia
sul canale di notifica globale un riepilogo cross-progetto: run non
completati, `decision_hold` aperti con il testo della domanda, recovery
recenti, streak di Herdr non raggiungibile e progetti oltre la soglia di log.
Vedi `docs/quick-guides/10-watcher-falle-yano.md#digest-giornaliero-0600-europerome`
per il dettaglio; `yano schedule disable --id yano-daily-digest` lo disattiva
in modo durevole (il bootstrap non lo riabilita mai da solo).

## Testare e gestire

```bash
yano schedule run --id <job-id> --dry-run --json # valida senza eseguire
yano schedule run --id <job-id>        # esegue subito SOLO su richiesta esplicita
yano schedule list --json         # job con script_path, mode, expected_consequence, stato
yano schedule disable --id <job-id>
yano schedule enable --id <job-id>
yano schedule remove --id <job-id>

# Cronologia e retry delle esecuzioni
yano schedule instances --id <job-id> --limit 20 --json
yano schedule retry --id <instance-id> --json
```

Regola d'oro: **prima di rendere ricorrente uno script, validalo con
`yano schedule run --id <id> --dry-run --json`**. Se lo script manca o fallisce,
il dispatch registra `failed` e disabilita il job (`enabled:false`) con un
fallback loggato — mai testo libero verso un planner dal cron.

## Bridge invocabile dagli script: `yano invoke`

Dentro uno script si sveglia il planner di progetto o yano-local-pc con un
comando deterministico (nessuna shell, nessun broker da gestire a mano):

```bash
yano invoke --role planner:<progetto> --prompt "riepiloga lo stato del progetto" --project-root "$PWD"
yano invoke --role yano-local-pc --prompt "promemoria tra 10 minuti: pausa caffè"
```

`--role planner[:<scope>]` compone il lancio `yano start --herdr --role
planner --project <scope> --print-only` dal root target; `yano-local-pc`
delega all'esistente `yano local-pc ask` (broker-aware, timeout, mai hang).

## Supervisore e cron di sistema

Il supervisore globale gira ogni minuto: ricrea la tab `scheduler-service` nel
workspace persistente `yano-scheduler` se manca. Il runtime `yano-local-pc`
contiene invece il solo `planner-01` persistente del control plane (evitando l'errore Herdr
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
## Standby e perdita di connessione

Il cron globale esegue la supervisione ogni minuto. Controlla DNS Google
(`8.8.8.8`/`8.8.4.4`), broker MQTT, Herdr e l'esecuzione della passata cron.
Se la macchina perde la connettività, salva checkpoint e mette in pausa i run
attivi dei progetti; quando tutti i segnali tornano disponibili riprende solo i
progetti messi in pausa automaticamente. Il registro dettagliato è
`<YANO_DATA_DIR>/logs/scheduler-connectivity-YYYY-MM-DD.jsonl` (un file per
giorno solare, cosicché la retention esistente possa raggiungerlo una volta
concluso — un file in append continuo ha sempre `mtime: ora`).
