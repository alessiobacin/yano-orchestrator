# Yano Debugger: guida rapida

## Avviare il debugger per un progetto

```bash
cd /path/del/progetto
yano debugger init --base-port 3055
yano debugger start
```

Per una verifica locale senza aprire Herdr:

```bash
yano debugger start --foreground
```

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

Il debugger deve avanzare il bug nell'ordine `triaged`, `reproducing`, `fixing`,
`testing`, `staging`, `awaiting_validation`. La produzione richiede sempre una
decisione esplicita:

```bash
yano debugger promote --bug-id BUG-... \
  --deployment-id staging-deploy-42 --actor superadmin --yes
```

Per analizzare l'origine del problema, usare il trace del progetto:

```bash
yano trace context --json
yano trace search --query "BUG-..." --json
```

Per l'implementazione completa e i confini di sicurezza, vedere
[Yano Debugger](../yano-debugger.md).
