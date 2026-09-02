# Yano Architect: playbook e agenti on-the-fly

Usa questa procedura quando il planner capisce che il catalogo non contiene un
playbook adeguato o serve un ruolo specialistico nuovo.

## 1. Controllare il catalogo prima di creare

```bash
cd /path/progetto
yano architect assess --project-root "$PWD" \
  --task "documenti strategici di vendita, ricerca, SEO e sito" --json
```

Se il risultato contiene `catalog.action: reuse`, il Planner usa il playbook
indicato e sceglie una variante adatta. Per `knowledge-authoring` le varianti
sono `single-author`, `research-and-author` e `full-team`.

## 2. Creare una nuova competenza riutilizzabile

```bash
yano architect propose --project-root "$PWD" \
  --task "Crea un playbook per una competenza specialistica" \
  --new-playbook --json
```

La proposta resta `awaiting_user_input`. L'Architect deve intervistare l'utente
su ambito globale, agente singolo/team multi-agente e priorità velocità/
profondità:

```bash
yano architect answer --proposal-id <PROP-ID> --status approved \
  --text "Globale e riutilizzabile; team multi-agente; priorità balanced" --json
yano architect team --proposal-id <PROP-ID> --variant full-team --json
yano architect provision --proposal-id <PROP-ID> --once --json
```

Solo dopo readiness completa il Planner avvia i ruoli della variante con lo
stesso `--proposal-id`. Gli artefatti restano globali sotto
`<YANO_DATA_DIR>/architect/`
e non vengono copiati nel progetto osservato.

```bash
cd /path/progetto
yano architect assess --project-root "$PWD" --task "<obiettivo>" --json
yano architect propose --project-root "$PWD" --task "<obiettivo>" --json
```

Copia il `proposal_id` restituito, quindi esegui il gate senza aprire Herdr:

```bash
yano architect provision --proposal-id <PROP-ID> --once --json
```

Se l'output contiene `pending` per un MCP, l'architect deve completare il
handshake e registrare un'evidenza non sensibile:

```bash
yano architect capability --proposal-id <PROP-ID> \
  --kind mcp --name <server> --status ready \
  --evidence "initialize/tools-list riusciti"
yano architect verify --proposal-id <PROP-ID> --json
```

Quando tutte le capability sono `ready`, prepara i due workspace Herdr:

```bash
yano architect provision --proposal-id <PROP-ID> --install
```

Le tab create nei workspace globali hanno nomi stabili per progetto:
`architect-<project-name>` nel workspace `yano-architect` e
`watcher-<project-name>` nel workspace `yano-watcher`.

Se Herdr mostra ancora `architect-prop-*` o `yano-watcher-*` attivi, non
lanciare un secondo provisioning: esegui il riallineamento controllato, che
conserva codice, trace e database e chiude le vecchie tab dopo il riavvio:

```bash
yano repair --dry-run
yano repair --yes
```

Il watcher `yano-watcher` controlla il round. Dopo il suo esito, il planner
chiede il feedback all'utente:

```bash
yano architect validation --proposal-id <PROP-ID> --run-id <RUN-ID> \
  --result passed --details "round sano"
yano architect feedback --proposal-id <PROP-ID> --status positive \
  --text "esperienza positiva" --actor planner
yano architect promote --proposal-id <PROP-ID> --yes
```

Per una revisione non promuovere la proposta: usa `revise`, ripeti il gate e
fai un nuovo round di validazione.

Per consultare ciò che è disponibile:

```bash
yano playbook list
yano agent list
yano agent show <role-id>
```

Per vedere più alternative per lo stesso task e la raccomandazione di Yano:

```bash
yano playbook candidates --task "<obiettivo>" --project-root "$PWD" --json
```

Se sono presenti più alternative, il Planner deve mostrarle e attendere la
scelta dell'utente. I requisiti mancanti includono sempre il comando esatto
per configurarli, ad esempio `yano config set SERVICE_API_KEY --stdin`.

## Bundle, importazione e rimozione

```bash
yano playbook export knowledge-authoring --out ./knowledge-authoring.yano-playbook.json
yano playbook import ./knowledge-authoring.yano-playbook.json
yano playbook remove personal-playbook --yes
yano playbook purge personal-playbook --yes
```

L'importazione crea una proposta globale e avvia sempre Architect nel workspace
`yano-architect`, che controlla conflitti, CLI/MCP/skill e credenziali. Non
promuove automaticamente il bundle. `remove` è reversibile e conserva le
versioni; `purge` è definitivo e richiede che il playbook sia già stato rimosso.
Le dipendenze tra playbook non sono supportate in questa versione.
