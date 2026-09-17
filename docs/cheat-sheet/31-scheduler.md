# Yano Scheduler — job ricorrenti a script (script-first)

```bash
# Registra uno schedule che esegue LO SCRIPT registrato (mode self|planner:<progetto>|yano-local-pc)
yano schedule add --name <nome> --project-root "$PWD" --script <path> --mode self --cron '0 14,21 * * *' --expected-consequence "riepilogo inviato"
yano schedule add --name backuppone-shot --project-root "$PWD" --script <path> --mode self --cron '0 0 * * *' --once

# Test PRIMA di renderlo ricorrente — esegue lo script subito
yano schedule run <job-id>

# Gestione
yano schedule list                   # inventario compatto con ID, nome, cron, stato, modalità
yano schedule list --json --pretty   # inventario JSON indentato per lettura manuale
yano schedule instances --id <job-id> --limit 20 --json  # ultime istanze e status
yano schedule retry --id <instance-id> --json             # retry manuale dell'istanza
yano schedule disable --id <job-id>
yano schedule enable --id <job-id>
yano schedule remove --id <job-id>

# Bridge deterministico chiamabile DENTRO gli script
yano invoke --role planner:<progetto> --prompt "riepiloga lo stato" --project-root "$PWD"
yano invoke --role yano-local-pc --prompt "promemoria tra 10 minuti: pausa caffè"
yano invoke --role scheduler --prompt "ogni giorno alle 8 riepilogami la posta"  # return-hop ESECUTORE (max 1 hop, YANO_DELEGATION_HOPS/ORIGIN: il secondo rimbalzo è rifiutato)

# Regole persistenti scheduler (sopravvivono al reset chat; solo Cestino, mai definitiva)
yano schedule-rules seed                                    # installa le regole email iniziali (idempotente)
yano schedule-rules query "quali regole cancellazione sono attive?"  # ricerca semantica
yano schedule-rules add --pattern "promo@" --kind unsubscribe --action unsubscribe_then_trash
yano schedule-rules update --id <id> --disable | --enable  # modifica semantica
yano schedule-rules remove --id <id>                        # cancellazione singola regola

# Triage posta scheduler (mode self; primo giro sempre dry-run + gate di conferma)
yano mail-triage --dry-run    # classifica soltanto, nessuna delete
YANO_MAIL_DRY_RUN=1 yano mail-triage   # idem via env
yano mail-triage --confirm    # registra la conferma: i prossimi giri eseguono davvero (solo Cestino)

# Sintassi storica in linguaggio naturale (job legacy, dispatch planner col testo)
yano cron --add "ogni giorno alle 14 e alle 21 esegui la pulizia del progetto" --project-root "$PWD"
yano cron --list --json
yano cron --disable <job-id> | --enable <job-id> | --run <job-id> | --remove <job-id>

# Supervisore persistente: cron di sistema + garanzia planner-01 di yano-local-pc
yano schedule cron status|install|remove
```

Al trigger si esegue lo SCRIPT registrato (mai shell; runtime Node, file
validato nel folder persistente `<data>/scheduler/scripts/`). Se lo script
manca o fallisce: `enabled:false` + fallback loggato, mai testo libero a un
planner. Token/credenziali solo da `.env` dentro lo script, mai incorporati.
Azioni distruttive o che modificano il progetto: sempre planner + gate umani.
Il supervisore gira ogni minuto dal cron di sistema e garantisce `planner-01`
nel workspace `yano-local-pc` (unico processo LLM persistente del control
plane); le schedulazioni le esegue il processo cron stesso, i job sopravvivono
a riavvii di Herdr e del computer.

Ad ogni passata controlla DNS Google (`8.8.8.8`/`8.8.4.4`), MQTT, Herdr e
registra l'esecuzione del cron in `checks.cron`.
Se la connettività passa offline mette in pausa con checkpoint i progetti
attivi; quando torna online riprende solo quelli messi in pausa
automaticamente. Dettagli e transizioni: log giornaliero
`<YANO_DATA_DIR>/logs/scheduler-connectivity-YYYY-MM-DD.jsonl`.

Un job `self` che esce con `status 0` è considerato immediatamente
`completed` — mai "ancora in dispatch": è il fix dell'incidente 2026-09 (39
rilanci in 2 ore per un JSON di successo non-standard letto come bloccato).
Un dispatch asincrono davvero bloccato (`planner:`/`yano-local-pc`) viene
ritentato fino a `MAX_STALE_RECOVERIES` (default 3), poi marcato
`dispatch_failed_permanently` con una notifica singola — mai un rilancio
infinito. Dettaglio: `docs/diagram/13-scheduler-dispatch-dedup.mmd`.

Un job di sistema, `yano-daily-digest` (`0 6 * * *`, fuso `Europe/Rome`
esplicito), viene installato da solo ad ogni passata se manca — riepilogo
cross-progetto sul canale globale ogni mattina. Vedi
`docs/quick-guides/22-job-ricorrenti.md#job-di-default-digest-giornaliero`.

Il triage della posta schedulata gira in `mode: self` (motore
`scripts/yano-mail-triage.mjs`: MCP apple-mail via stdio + llmProxy via
HTTP, solo Cestino, cap 200/run) — yano-local-pc resta per i soli one-off
interattivi non schedulati. Migrazione post-merge:
`docs/quick-guides/28-migrazione-posta-self.md`.

Lo scheduler-service è ESECUTORE: imposta ED esegue. Quando l'utente chiede
uno schedule, lo esegue SUBITO in chat come primo giro (posta: sempre
dry-run + `yano mail-triage --confirm` prima dei giri reali), poi salva lo
script e registra lo schedule; al tick esegue lui stesso lo script.
Le regole utente vivono in `<data>/scheduler/scheduler-rules.json`
(CRUD semantico `yano schedule-rules add|list|query|update|remove|seed`);
regole email: (a) `support@mail.xtb.com` → sempre Cestino (senza LLM),
(b) pubblicità con unsubscribe → tentativo disiscrizione (GET diretto, poi
browser se serve), altrimenti Cestino. Solo Cestino via `delete_message`,
mai definitiva; report per-run in `<data>/scheduler/mail-triage-reports/`.
Delega bidirezionale scheduler↔local-pc max 1 hop
(`YANO_DELEGATION_HOPS`/`YANO_DELEGATION_ORIGIN`): i local-pc generici non
creano MAI schedule — delegano allo scheduler in un hop e si fermano.

## Contratto essenziale (2026-09-15)

`yano status --all --explain --json` espone decisioni watcher e fingerprint;
`yano feedback-api start` conserva API e dati senza GUI Kanban (`dash` è alias).
Il Gantt mostra fasi previste, dipendenze e round osservati con modelli/provider.
`yano frontend-review browser --url URL` abilita annotazioni DOM senza React.
Watcher/scheduler sono deterministici; Local PC resta il servizio LLM persistente.
Nuovi piani: `plan_set` richiede `scoping.status` e `scoping.rationale`.
Dettagli, compatibilità e limiti: [Yano essenziale](../quick-guides/yano-essential.md).
