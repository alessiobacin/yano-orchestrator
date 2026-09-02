# Sales Companion: riprendere il task dei 17 documenti

Questa procedura presuppone:

```text
/Users/alessiobacin/Development/testCode/sales-companion
```

## 1. Controllare e riparare lo stato

```bash
export PROJECT_ROOT="/Users/alessiobacin/Development/testCode/sales-companion"
cd "$PROJECT_ROOT"
yano repair --project-root "$PROJECT_ROOT" --dry-run
yano repair --project-root "$PROJECT_ROOT" --yes --init-db
yano fleet --project-root "$PROJECT_ROOT" --json
yano watcher projects --project-root "$PROJECT_ROOT" --all --json
yano architect projects --project-root "$PROJECT_ROOT" --all --json
```

Devono risultare un solo `planner-01` live nel workspace `sales-companion` e,
se il controllo è attivo, un solo `watcher-sales-companion` nel workspace
`yano-watcher`. Architect può risultare offline dopo il provisioning: è
normale se la proposta è già `ready_ephemeral`.

## 2. Verificare il playbook e le capability

```bash
yano architect status --proposal-id <PROP-ID> --json
yano architect verify --proposal-id <PROP-ID> --json
```

Il playbook deve essere `knowledge-authoring`, il ruolo
`business-docs-author`, tutte le capability `ready` e nessun requisito
frontend/MCP non richiesto.

## 3. Tenere attivo il controllo Watcher

Il Watcher della proposta esegue una validazione bounded e poi mantiene il
polling zero-token ogni 10 minuti. Se il processo è stato chiuso, rilancialo
dal catalogo/proposta:

```bash
yano architect provision --proposal-id <PROP-ID> --install --json
```

Per una verifica manuale immediata, senza aprire un nuovo agente:

```bash
yano watch --project-root "$PROJECT_ROOT" --project sales-companion \
  --lookback-ms 3600000 --once
```

Con Planner live, anomalie e ticket stalled sono inviati via MQTT al Planner;
senza Planner live, i finding vengono inviati a Telegram se la configurazione
globale è completa. Una passata senza anomalie non invia un allarme Telegram.

## 4. Prompt da inviare al Planner

Nella tab `planner-01` invia:

```text
Riprendi il task di Sales Companion per la creazione dei 17 documenti strategici.
Prima leggi lo stato della proposta Architect e verifica che il playbook globale
knowledge-authoring e il ruolo business-docs-author siano ready_ephemeral e che
il Watcher sia live. Non scrivere manualmente i documenti e non usare un fallback:
se manca l'agente ephemeral, fermati e segnala il blocco. Se la proposta è pronta,
mostrami il team della variante scelta (ricerca mercato, SEO, strategia sito,
authoring/revisione) e le dipendenze; poi attendi la mia conferma. Dopo la conferma
crea/riusa il run, la spec e i ticket verticali con /to-tickets, avvia gli agenti
del playbook con il proposal_id e assegna il lavoro. Ogni agente deve lavorare
solo nel proprio worktree e riportare evidenze. Il Watcher deve controllare il
flusso durante il lavoro; se segnala finding o blocked, sospendi la dichiarazione
di successo, leggi il trace mirato e chiedimi come procedere. Alla fine mostrami
i documenti prodotti, la verifica del Watcher e il feedback richiesto per decidere
se mantenere il playbook ephemeral o proporne la promozione.
```

## 5. Controllare il round

```bash
yano status --project-root "$PROJECT_ROOT"
yano logs --project-root "$PROJECT_ROOT"
yano trace status
yano trace search --project sales-companion --query "workflow watcher planner" --json
```

Non usare `yano architect promote` senza validation positiva del Watcher e
feedback positivo dell'utente. Il Planner rimane responsabile della scelta e
della promozione.
