# Yano Debugger: guida rapida

## Avviare il debugger per un progetto

```bash
cd /path/del/progetto
yano debugger init --base-port 3055
yano debugger start
```

Per una verifica locale senza aprire Herdr e senza avviare processi persistenti:

```bash
yano debugger start --once --json
```

`--once` esegue una sola preflight read-only su trace, bug e stato del worker,
poi termina. Non modifica il progetto e non apre una tab Herdr.

## Segnalare un bug

```bash
yano debugger report \
  --title "Titolo breve" \
  --description "Cosa succede" \
  --severity medium \
  --source user \
  --expected "comportamento atteso" \
  --actual "comportamento osservato" \
  --steps $'passo 1\npasso 2' \
  --json
```

Salva l'`bug_id` restituito. Le segnalazioni equivalenti vengono deduplicate.

## Controllare, mettere in pausa e riprendere

```bash
yano debugger status --json
yano debugger status --bug-id BUG-...
yano debugger pause
yano debugger resume
```

`pause` non chiude la tab Herdr. `resume` riusa la tab se è ancora presente o
ne crea una nuova nel workspace globale `yano-debugger`.

## Flusso di validazione

Il debugger deve avanzare il bug nell'ordine diagnostico `triaged`,
`reproducing`, `not_reproducible` oppure `blocked`:

```bash
yano debugger claim --bug-id BUG-... --actor debugger-app
yano debugger transition --bug-id BUG-... --to triaged --actor debugger-app
yano debugger transition --bug-id BUG-... --to reproducing --actor debugger-app
yano debugger transition --bug-id BUG-... --to blocked --actor debugger-app
```

Gli stati `fixing`, `testing`, `staging`, `awaiting_validation` e `production`
non appartengono al debugger. Dopo la diagnosi, il planner decide se aprire il
normale task con coder/reviewer e deployment-agent; il debugger non corregge,
non deploya e non promuove codice.

Per analizzare l'origine del problema, usare il trace del progetto:

```bash
yano trace context --json
yano trace search --query "BUG-..." --json
```

Per l'implementazione completa e i confini di sicurezza, vedere
[Yano Debugger](../yano-debugger.md).
