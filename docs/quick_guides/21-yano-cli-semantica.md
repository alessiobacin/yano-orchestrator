# CLI semantica per gli agenti Pi

Ogni agente avviato con `yano start` riceve la skill condivisa
`yano-cli`. In questo modo può tradurre richieste naturali in comandi
Yano verificabili, mantenendo però i limiti del proprio ruolo. La skill è
inclusa nel pacchetto globale, quindi non richiede una copia nel progetto
gestito.

## Skill globale negli harness

Durante un'installazione globale (`npm install -g`) Yano esegue
automaticamente l'installer deterministico. Puoi controllare o ripeterlo con:

```bash
yano skills status --json
yano skills install --dry-run --json
yano skills install
```

La strategia è una copia per catalogo indipendente: `~/.claude/skills/yano-cli`
per Claude Code, `~/.codex/skills/yano-cli` per Codex e `~/.pi/agent/skills/yano-cli`
solo se Pi non scopre già uno dei cataloghi precedenti dal proprio
`settings.json`. Le copie identiche duplicate che Pi potrebbe caricare vengono
spostate nel backup del data-root Yano; copie modificate o non riconosciute
restano intatte e vengono segnalate come conflitti.

## Esempi di richieste

Da un agente si può chiedere, per esempio:

- «Il watcher è attivo su questo progetto?»
- «Su quali progetti è attivo watcher?»
- «Controlla se architect è attivo e mostrami la proposta collegata.»
- «Questa repository esistente è inizializzata per Yano? Se manca, prepara
  l'infrastruttura senza toccare il codice.»
- «Analizza il fallimento dell'ultimo round usando solo il trace rilevante.»
- «Quale playbook è consigliato e quali requisiti mancano?»
- «Quanti progetti Yano sono attivi adesso?»

L'agente deve prima esplicitare l'intento, il progetto e il carattere
read-only o mutante dell'operazione. Per le richieste informative usa
normalmente:

```text
yano projects --json
yano fleet --project-root "$PWD" --json
yano watcher projects --project-root "$PWD" --json
yano architect projects --project-root "$PWD" --all --json
yano trace status
yano trace events --project "<nome>" --since "<ISO>" --limit 50 --json
```

Per sapere quanti progetti Yano sono realmente attivi in questo momento,
usare `yano projects --json`: `project_count` conta le root di progetto
distinte che hanno almeno un agente Pi/Yano live in Herdr e `projects` mostra
agenti e percorsi. Il comando include planner, coder, reviewer e worker
esterni; esclude pane stale/offline, card MQTT retained e terminali Codex
aperti senza un agente Pi. Se `herdr_reachable` è `false`, il numero è ignoto,
non zero.

I comandi `yano watcher projects`, `yano architect projects` e gli altri
`*_projects` hanno invece uno scopo più ristretto: elencano i progetti coperti
da quello specifico worker esterno. `yano repair --all-projects` è una
previsione di riparazione e non sostituisce l'inventario live.

`active_projects` è l'elenco dei worker osservati live da Herdr. Una voce in
`registered_projects` può essere offline, pausata o solo collegata a una
proposta: non dimostra da sola che il processo sia attivo. `status: idle`
indica un processo live senza lavoro LLM in corso; per watcher il polling
zero-token può continuare normalmente.

## Inizializzare e avviare una repository

Per una repository già esistente, dalla sua root:

```text
yano init --name "nome-progetto"
yano doctor --network
yano trace enable --mode full
yano start --instance planner-01 --role planner
```

Per aprire automaticamente il workspace Herdr e il planner:

```text
yano init --name "nome-progetto" --herdr
```

L'inizializzazione in-place è non distruttiva: preserva codice, `package.json`,
configurazione e `.env.example`, aggiungendo solo l'infrastruttura Yano
mancante. `--force` serve per una directory `--target` già esistente e non
vuota.

## Controllare il watcher

Il watcher ha due tempi distinti:

- `--lookback-ms` stabilisce quanto indietro cercare nel trace e nello stato;
- `--interval-ms` stabilisce ogni quanto ripetere la scansione;
- `--once` esegue una sola scansione e termina.

Test bounded:

```text
yano watch --project-root "/path/progetto" --lookback-ms 3600000 --once
yano trace events --project "nome-progetto" --instance yano-watcher --type yano_watcher_scan --limit 20 --json
```

Lo scan include `started_at`, `completed_at`, `duration_ms`, `status`,
`findings`, `stalls`, `live_agents` e `interval_ms`. Per un watcher ricorrente:

```text
yano watch --project-root "/path/progetto" \
  --lookback-ms 3600000 --interval-ms 600000 --away
```

## Errori e operazioni che cambiano stato

Quando manca una credenziale, Yano indica la variabile e il comando da usare:

```text
yano config list --all
yano config path
printf '%s' "$TOKEN" | yano config set TELEGRAM_BOT_TOKEN --stdin
```

Prima di riparare o riavviare, raccogli evidenze e mostra il piano:

```text
yano fleet --project-root "/path/progetto" --json
yano repair --project-root "/path/progetto" --dry-run
yano repair --project-root "/path/progetto" --yes
```

Per aggiornare istanze già aperte:

```text
yano update --reload --dry-run
yano update --reload --yes
```

Per una pausa recuperabile:

```text
yano pause --project "nome-progetto" --run "<run-id>" --yes
yano recovery status --project "nome-progetto"
yano resume --project "nome-progetto" --run "<run-id>" --yes
```

`yano end` chiude il run e non è un sostituto di `pause`. La cancellazione di
trace, `purge` di un playbook e `uninstall` richiedono sempre una conferma
esplicita.

## Playbook e trace

```text
yano playbook list --json
yano playbook candidates --task "<task utente>" --project-root "/path/progetto" --json
yano playbook show "<id>" --json
yano agent show "<ruolo>" --json
yano trace search --project "nome-progetto" --query "<problema>" --mode hybrid --limit 10 --explain --json
```

Se l'indice semantico non esiste o è vecchio, l'agente usa `yano trace index`
prima della ricerca. `credential_checks` e `warnings` devono essere riportati
all'utente senza rivelare i valori segreti. Un playbook non è operativo finché
Architect non conclude il readiness gate.

Per l'elenco completo e l'uso meno frequente dei comandi, leggere
[`skills-vendor/yano/yano-cli/references/command-reference.md`](../../skills-vendor/yano/yano-cli/references/command-reference.md)
e poi verificare sempre la versione installata con `yano --help`.
