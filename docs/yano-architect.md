# Yano Architect

`yano-architect` è l'agente globale che crea playbook e ruoli specialistici
quando il catalogo corrente non copre bene l'intento del planner. Vive nel
workspace Herdr `yano-architect`, allo stesso livello globale di
`yano-watcher`, `yano-debugger`, `yano-auto-improver` e `yano-suggester`.

L'architect non modifica mai il progetto osservato. Scrive soltanto sotto la
directory dati globale di Yano (`<YANO_DATA_DIR>`, scelta automaticamente per
piattaforma) e nel catalogo
globale dopo una promozione esplicita.

## Catalog-first e lifecycle

Architect non crea automaticamente un playbook per ogni richiesta. Prima
confronta l'intento con il catalogo globale:

```text
assess → catalog match?
       ├─ sì → riuso del playbook + scelta Planner della variante
       └─ no → propose globale → intervista utente → capability gate
                                      → watcher validation → feedback
                                      → revise oppure promote
```

Un playbook creato per un progetto non è un playbook del progetto: il primo
progetto fornisce soltanto il caso d'uso iniziale. Il nome, gli intenti, i
parametri e i ruoli devono restare riutilizzabili in altri repository.

Per le competenze ampie Architect definisce un team con varianti, non un
agente monolitico. `single-author`, `research-and-author` e `full-team` sono
esempi: Architect dichiara ruoli, capability, output, ordine operativo e gruppi
paralleli; il Planner sceglie la variante e il numero di istanze in base al
task reale. Non si avviano tutti gli agenti solo perché sono presenti nel
playbook.

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

# Creare una nuova competenza globale quando il catalogo non basta
yano architect propose \
  --project-root /path/progetto \
  --task "crea un playbook per una competenza specialistica" \
  --new-playbook \
  --json

# Rispondere all'intervista diretta dell'Architect
yano architect answer --proposal-id <PROP-ID> --status approved \
  --text "Globale, team multi-agente, priorità balanced" --json

# Selezionare la variante concreta da usare nel task
yano architect team --proposal-id <PROP-ID> --variant full-team --json

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
Le istanze delle versioni precedenti (`architect-prop-*` e
`yano-watcher-*`) non vengono duplicate: se sono ancora attive il provisioning
si ferma e indica `yano repair --yes`, che salva lo snapshot e le riavvia in
modo controllato; se invece sono già inattive, la loro tab viene chiusa subito
dopo che la nuova istanza è risultata attiva. Il risultato finale è
`architect-<project-name>` e `watcher-<project-name>`.

## Catalogo globale

```bash
yano playbook list
yano playbook show <id>
yano playbook check /path/playbook.yaml
yano agent list
yano agent show <role-id>
```

Le versioni promosse sono immutabili in `<YANO_DATA_DIR>/catalog/playbooks/` e
`<YANO_DATA_DIR>/catalog/agents/`. Il launcher risolve un ruolo promosso creando un
`roles.yaml` runtime unito alla configurazione del progetto e allegando le
skill dichiarate dal manifest; non copia il catalogo nel repository applicativo.

Per il trasporto usa `yano playbook export/import`; per la gestione usa
`remove` (soft disable) e `purge` (cancellazione confermata). I playbook non
incorporano né dipendono da altri playbook in questa versione.

## Regole di sicurezza

- il watcher valida il round ma non promuove;
- il planner conduce l'intervista e decide se chiedere revisione o promozione;
- `promote` richiede sempre `--yes`, capability complete, almeno una validation
  riuscita e feedback positivo;
- nessun playbook generated ha effetti di produzione impliciti;
- manifest, checksum, evidenze e feedback restano nel database globale per
  audit e rollback logico della versione catalogata.
