# Auto-improve periodico

Dalla root di Yano o usando il percorso assoluto del progetto osservato:

```sh
yano auto-improve init \
  --project-root /Users/me/projects/my-app \
  --interval 5d \
  --notify auto
yano auto-improve start --project-root /Users/me/projects/my-app
```

Controlla audit e report:

```sh
yano auto-improve status --project-root /Users/me/projects/my-app --json
yano auto-improve reports --project-root /Users/me/projects/my-app
```

Per provare il flusso senza Herdr o scheduler:

```sh
yano auto-improve start \
  --project-root /Users/me/projects/my-app \
  --once --dry-run --json
```

`--once` esegue un solo audit e non avvia lo scheduler detached. `--dry-run`
evita anche l'avvio del worker Herdr, quindi questa è la modalità consigliata
per un test locale non invasivo. Per eseguire davvero un audit singolo usando
il worker, rimuovi `--dry-run`:

```sh
yano auto-improve run --project-root /Users/me/projects/my-app --once
```

Il worker usa il workspace globale `yano-auto-improver` e la tab
`auto-improver-<project-name>`.

Per sospendere, riattivare o fermare la pianificazione:

```sh
yano auto-improve pause --project-root /Users/me/projects/my-app
yano auto-improve resume --project-root /Users/me/projects/my-app
yano auto-improve stop --project-root /Users/me/projects/my-app
```

L'agente è solo osservatore: non modifica mai il progetto. Invia le
raccomandazioni al planner, che decide se aprire ticket di sviluppo.
