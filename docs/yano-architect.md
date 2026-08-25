# Yano Architect

`yano-architect` è l'agente globale che crea playbook e ruoli specialistici
quando il catalogo corrente non copre bene l'intento del planner. Vive nel
workspace Herdr `yano-architect`, allo stesso livello globale di
`yano-watcher`, `yano-debugger`, `yano-auto-improver` e `yano-suggester`.

L'architect non modifica mai il progetto osservato. Scrive soltanto sotto la
directory dati globale di Yano (`temp/`, o `YANO_DATA_DIR`) e nel catalogo
globale dopo una promozione esplicita.

## Lifecycle

```text
assess → propose (ephemeral) → capability gate → watcher validation
       → planner/user feedback → revise oppure promote (persistent)
```

Una proposta ephemeral non è operativa finché tutte le skill, CLI e MCP
dichiarate non risultano `ready`. Un server MCP solo dichiarato in `.mcp.json`
è `pending`: l'architect deve eseguire il vero handshake (`initialize` e
`tools/list`, senza salvare token) e registrare una prova sintetica con
`capability`. Anche un singolo requisito mancante blocca l'avvio.

## Comandi principali

```bash
# Capire quale copertura e quali capability servono
yano architect assess \
  --project-root /path/progetto \
  --task "crea un'importazione CSV con validazione e test"

# Creare il playbook e il ruolo in staging ephemeral
yano architect propose \
  --project-root /path/progetto \
  --task "crea un'importazione CSV con validazione e test" \
  --json

# Verificare il gate senza aprire Herdr (utile per test e CI)
yano architect provision --proposal-id <PROP-ID> --once --json

# Dopo un handshake MCP reale eseguito dall'architect, registrare solo
# evidenza non sensibile; poi ripetere verify/provision.
yano architect capability \
  --proposal-id <PROP-ID> --kind mcp --name github \
  --status ready \
  --evidence "initialize/tools-list riusciti nel progetto focusboard"

# Preparare l'agente watcher e il worker architect nei workspace Herdr globali
yano architect provision --proposal-id <PROP-ID> --install

# Consultare lo stato completo
yano architect status --proposal-id <PROP-ID> --json

# Registrare l'esito del round di validazione e l'intervista dell'utente
yano architect validation --proposal-id <PROP-ID> --run-id <RUN-ID> \
  --result passed --details "round watcher sano"
yano architect feedback --proposal-id <PROP-ID> --status positive \
  --text "Il playbook ha prodotto l'esperienza attesa" --actor planner

# Promuovere solo dopo readiness, validation passed e feedback positivo
yano architect promote --proposal-id <PROP-ID> --yes

# Se l'utente chiede cambiamenti, creare una nuova versione ephemeral
yano architect revise --proposal-id <PROP-ID> \
  --task "stessa importazione CSV ma con preview e rollback"
```

`--once` esegue il controllo bounded e non apre workspace o tab. `--dry-run`
compone le azioni Herdr senza eseguirle. `--install` non esegue comandi
arbitrari provenienti dal task: crea/riusa i workspace globali
`yano-architect` e `yano-watcher` e avvia entrambi come agenti Pi reali tramite
`herdr agent start`. Il watcher usa il ruolo `watcher`, esegue una scansione
`yano watch --once` e riferisce l'esito al planner; non è sufficiente creare il
solo pannello Herdr. Le tab sono nominate `architect-<project-name>` e
`watcher-<project-name>`; se viene incontrata una tab legacy con il solo nome
del progetto, viene rinominata e riusata invece di crearne una duplicata.

## Catalogo globale

```bash
yano playbook list
yano playbook show <id>
yano playbook check /path/playbook.yaml
yano agent list
yano agent show <role-id>
```

Le versioni promosse sono immutabili in `temp/catalog/playbooks/` e
`temp/catalog/agents/`. Il launcher risolve un ruolo promosso creando un
`roles.yaml` runtime unito alla configurazione del progetto e allegando le
skill dichiarate dal manifest; non copia il catalogo nel repository applicativo.

## Regole di sicurezza

- il watcher valida il round ma non promuove;
- il planner conduce l'intervista e decide se chiedere revisione o promozione;
- `promote` richiede sempre `--yes`, capability complete, almeno una validation
  riuscita e feedback positivo;
- nessun playbook generated ha effetti di produzione impliciti;
- manifest, checksum, evidenze e feedback restano nel database globale per
  audit e rollback logico della versione catalogata.
