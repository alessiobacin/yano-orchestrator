# Catalogo playbook: requisiti, bundle e rimozione

## Scegliere tra più playbook

```bash
yano playbook candidates \
  --project-root "$PWD" \
  --task "Scrivi documenti strategici di vendita, SEO e sito" \
  --json
```

Il risultato contiene `recommended`, le alternative e
`user_choice_required`. Se il primo candidato domina nettamente o
`user_choice_required` è `false`, il Planner dichiara la scelta con una riga
di motivo e procede. Se invece `user_choice_required` è `true` con candidati
vicini per punteggio, il Planner non si limita a mostrare la lista grezza:
fa prima una o due domande mirate sul task per capire quale candidato copre
davvero la richiesta, poi presenta la raccomandazione informata e le
alternative residue e attende conferma — non seleziona mai in silenzio un
playbook concorrente. Se nessun candidato risulta adatto nemmeno dopo le
domande, il Planner tratta il caso come `catalog.action: create` e chiede ad
Architect una nuova proposta invece di forzare il task in un playbook che non
calza.

## Controllare requisiti e credenziali

```bash
yano playbook show <playbook-id> --json
yano playbook check /path/to/playbook.yaml --json
```

Se un requisito è mancante, l'output riporta il comando di configurazione. Per
una chiave segreta:

```bash
printf '%s' "$SERVICE_API_KEY" | yano config set SERVICE_API_KEY --stdin
```

Per un valore non segreto:

```bash
yano config set SERVICE_REGION eu-west-1
```

I valori finiscono nella configurazione globale (`yano config path`), non nel
progetto osservato. Dopo averli aggiunti, ripetere il check o il capability
gate di Architect.

## Esportare e importare

```bash
yano playbook export knowledge-authoring --out ./knowledge-authoring.yano-playbook.json
yano playbook import ./knowledge-authoring.yano-playbook.json
```

Il bundle contiene il manifesto del playbook e i ruoli associati. L'import crea
una proposta globale ephemeral e avvia Architect nel workspace `yano-architect`
(salvo `--dry-run`/`--once`, riservati a anteprima e test);
Architect verifica conflitti, skill, CLI, MCP e credenziali. L'import non
modifica il progetto applicativo e non promuove automaticamente il playbook.

## Disattivare o cancellare

```bash
yano playbook remove my-playbook --yes
yano playbook purge my-playbook --yes
```

`remove` è reversibile: marca il playbook come rimosso e conserva le versioni
per la forensic history. `purge` è definitivo e funziona solo dopo `remove`.
I playbook built-in non possono essere rimossi o cancellati.

Le dipendenze tra playbook non sono supportate in questa versione: ogni bundle
deve dichiarare un contratto autonomo.
