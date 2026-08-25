# Yano Architect: playbook e agenti on-the-fly

Usa questa procedura quando il planner capisce che il catalogo non contiene un
playbook adeguato o serve un ruolo specialistico nuovo.

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

