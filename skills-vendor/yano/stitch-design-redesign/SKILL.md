---
name: stitch-design-redesign
description: Usa Google Stitch come motore di design, redesign, UX review e prototipazione mantenendo sincronizzati requisiti, codice, applicazione, Stitch, workspace .stitch e prototipo.
compatibility: "Richiede il MCP server Stitch già registrato negli MCP di Yano e, per le API operative Stitch, credenziali OAuth2; non autorizza API key come sostituto di un principal."
---

# Custom Stitch Design & Redesign

## Missione e priorità

Il risultato non è una schermata bella isolata. È un design visivamente
coerente, funzionalmente completo, tracciabile al comportamento, sincronizzato
con Stitch e con il codice, e utilizzabile come specifica d'implementazione.

Priorità: per un'app esistente `FUNCTIONAL COMPLETENESS > VISUAL NOVELTY`; per
un progetto Stitch esistente `PRESERVE USER WORK > REGENERATE`; per
l'implementazione `CURRENT STITCH STATE > STALE LOCAL DESIGN FILES`.

Il ciclo canonico è `DISCOVER → FETCH → RECONCILE → ANALYZE → COMPARE → IMPROVE → WRITE-BACK → VALIDATE`.

## Protocollo planner ↔ specialista ↔ utente

Il planner è l'unica interfaccia conversazionale con l'utente. Deve
classificare subito la richiesta, proporre `design-redesign-specialist` quando
è il ruolo adatto e chiedere la conferma necessaria prima dell'avvio.

Lo specialista non deve iniziare con domande generiche. Dopo l'avvio deve prima
fare discovery su repository, app corrente, Stitch remoto e `.stitch` locale,
poi classificare la modalità e raccogliere le evidenze. Deve porre domande solo
quando resta una decisione che non può essere risolta dai dati disponibili:
modalità ambigua, divergenza intenzionale, rimozione di funzionalità, scelta tra
candidate o approvazione di una modifica UX.

Quando serve una decisione, lo specialista invia al planner una domanda
strutturata con contesto, opzioni, raccomandazione e conseguenza. Il planner la
traduce in una domanda breve per l'utente, registra la risposta e la inoltra
allo specialista. Non duplicare domande già risolte e non chiedere all'utente di
conoscere dettagli tecnici di Stitch o del repository.

Se la domanda sospende un run già creato, il planner apre prima un
`decision_hold`; lo specialista continua solo sulle attività indipendenti e non
simula una decisione. L'utente approva il risultato visuale attraverso il
planner, mentre lo specialista esegue discovery, audit, progettazione,
sincronizzazione e handoff.

## Contratto di parità strutturale

Per un'applicazione esistente, il redesign è visuale per default: la struttura
funzionale della pagina Ionic è il contratto da preservare. Prima di generare
qualsiasi schermata Stitch estrai e registra elementi, ordine, gerarchie, dati,
azioni, stati e navigazione. Una Dashboard Stitch priva di elementi presenti
nella Dashboard Ionic è quindi un redesign incompleto.

La stessa regola vale quando Stitch non esiste ancora: la struttura Ionic viene
analizzata prima e inclusa nel prompt inviato a Stitch. Cambiamenti strutturali
o rimozioni richiedono una deroga esplicita registrata in `DECISIONS.md`.

## Modalità operative

Determina automaticamente la modalità:

- **A — Nuova applicazione**: definisci information architecture, shell,
  pagine, componenti, workflow, interazioni e responsive behavior; crea
  progetto Stitch e workspace `.stitch/`.
- **B — Redesign di applicazione esistente**: ispeziona codice e UI prima di
  ogni prompt Stitch. Preserva route, pagine, shell, menu, permessi, azioni,
  stati, workflow e business logic.
- **C — Review di Stitch esistente**: trova il progetto via MCP, recupera le
  schermate, non crearne uno sostitutivo, modifica incrementalmente e preserva
  il lavoro dell'utente.
- **D — Prodotto esistente + nuova feature**: audita codice e Stitch, trova il
  punto corretto, preserva shell/design system, aggiorna Stitch, `.stitch/` e
  prototipo, poi implementa.

## MCP Stitch

Usa il server `stitch` già registrato negli MCP di Yano/progetto. Non creare un
secondo server se quello esistente è disponibile. Prima dell'uso ispeziona i
tool e lo schema effettivi: non assumere namespace, nomi, ID o parametri.
Tool comuni ma non garantiti sono `create_project`, `list_projects`,
`get_project`, `list_screens`, `get_screen`, `generate_screen_from_text`,
`edit_screens` e `generate_variants`.

Se il server si connette ma una chiamata rifiuta la API key, il discovery può
essere valido mentre l'API di gestione richiede OAuth2. Segnala il prerequisito
e usa un bearer token da credenziali Google valide; non stampare, committare o
inserire segreti nei report.

## Audit e inventario

Per MODE B/D crea `.stitch/CURRENT-UI.md` prima di generare prompt. Registra
nome, scopo, posizione, comportamento, destinazione/azione, visibilità, route,
componente e file sorgente di header, footer, sidebar, logo, menu, dropdown,
breadcrumbs, tab, bottoni, link, form, tabelle, filtri, dialog, drawer,
ricerca, permessi, responsive behavior, stati e workflow.

Includi per ogni pagina una `STRUCTURE CONTRACT` completa e salva il confronto
Ionic↔Stitch in `.stitch/STRUCTURE-MATRIX.md`.

Per MODE C crea `.stitch/CURRENT-STITCH.md` con nome/ID Stitch, pagina logica,
route, shell, struttura, menu, azioni, dialog, stati, problemi UX,
incoerenze e funzionalità mancanti. Non dedurre comportamento dalle immagini
quando il codice è disponibile.

Per uno Stitch esistente, il fetch remoto è obbligatorio e precede ogni
decisione: importa nello schema locale le modifiche online prima di generare
nuove schermate o proporre il redesign.

Crea `.stitch/APP-INVENTORY.md` come inventario funzionale canonico. Ogni
interazione significativa riceve un ID stabile (`NAV-001`, `BTN-014`,
`DD-003`, ecc.) che sopravvive al redesign.

## Preservation e shell

Crea `.stitch/FEATURE-MATRIX.md` confrontando app e design selezionato. Usa
`OK`, `MISSING`, `CHANGED`, `IMPROVED`, `NEEDS_REVIEW`, `REMOVAL_APPROVED`.
Calcola `required features rappresentate / required features totali × 100` e
registra il Design Coverage Score in matrix e `SYNC.md`. È diagnostico: una
feature `CRITICAL` mancante blocca anche con coverage alta.

Per ogni schermata crea `.stitch/contracts/<screen>.md` con MUST EXIST,
MAY CHANGE VISUALLY e MUST NOT CHANGE WITHOUT APPROVAL. Senza approvazione
esplicita tutto resta funzionalmente disponibile.

Crea `.stitch/SHELL.md` con header, logo, navigazione, sidebar, footer,
account menu, notifiche, breadcrumbs, ricerca, container, dimensioni,
tipografia, spacing, colori e breakpoint. Distingui sempre cambiamento
visuale, redesign strutturale e rimozione funzionale; la rimozione richiede
approvazione.

## UX e candidate

Controlla gerarchia, click eccessivi, posizione delle azioni, discoverability,
navigazione, grouping, empty/error states, feedback, responsive behavior e
funzionalità mal esposte. Non alterare requisiti business per eleganza.

Correggi direttamente problemi oggettivi. Genera esattamente due design solo
quando esistono due strategie UX genuinamente valide, per esempio sidebar vs
command-center o wizard vs form singolo; non creare varianti cosmetiche.

Le schermate hanno ruolo `CANONICAL` o `CANDIDATE`. Usa nomi espliciti come
`Dashboard` e `Proposta Dashboard`, mai `Dashboard 2`, `Copy` o `Variant`.
Raggruppa candidate per pagina logica in `.stitch/CANDIDATES.md`.

Se più candidate attive rappresentano la stessa pagina, l'implementazione è
bloccata. Chiedi la scelta usando i nomi reali Stitch. Se l'utente elimina la
concorrente, al successivo sync l'unica rimasta diventa effettiva. Se sceglie
esplicitamente una schermata lasciando le altre, registra la decisione. Una
schermata cancellata da Stitch diventa `DELETED_IN_STITCH` e non va resuscitata.

## Ordine spaziale del workspace Stitch

Il canvas di Stitch è un artefatto di orientamento mentale, non un deposito
casuale di schermate. Dopo ogni generazione o modifica organizza le schermate
per flusso: usa l'entry point come ancora centrale (per esempio `Login`), metti
accanto la destinazione principale (`Dashboard`), poi disponi intorno le
schermate raggiungibili direttamente e più esternamente i livelli successivi.
Mantieni righe/colonne coerenti, distanze uniformi, nessuna sovrapposizione e
nessuna lunga colonna verticale di schermate.

Quando una schermata esiste in versione light e dark, le due varianti devono
restare sempre affiancate orizzontalmente, con lo stesso allineamento e la
stessa scala. Trattale come una coppia visiva della medesima pagina, non come
due nodi distinti da distribuire in livelli diversi del canvas.

Prima della consegna crea `.stitch/CANVAS-MAP.md` con coordinate relative,
gruppi, livelli di distanza dall'entry point e relazioni `A --azione--> B`.
Aggiornalo dopo ogni creazione, cancellazione o rinomina e verifica che ogni
schermata abbia una posizione assegnata.

Il MCP Stitch espone creazione, lettura, modifica e generazione delle
schermate, ma non un'operazione per impostare coordinate o spostare una screen
instance nel canvas. Non fingere di aver riordinato il workspace tramite MCP:
se la UI Stitch consente il drag e un browser abilitato è disponibile, applica
la `CANVAS-MAP`; altrimenti consegna la mappa operativa e segnala chiaramente
che il riordino finale richiede il drag nella UI Stitch.

## Prompt e sincronizzazione a tre vie

Non inviare prompt vaghi. Compila sempre `PRESERVE`, `REDESIGN`, `IMPROVE`,
`ADD`, `REMOVE`, shell, contenuti, interazioni, responsive, design system,
stati e traceability.

Il prompt deve includere integralmente la `STRUCTURE CONTRACT` della pagina
Ionic/applicativa, non soltanto colori, screenshot o una descrizione generica.
Salva il testo effettivamente inviato, con timestamp, screen ID e input, in
`.stitch/PROMPTS.md`.

Mantieni esplicitamente:

```text
STITCH ↔ .stitch ↔ CODE
```

Classifica ogni pagina in `SYNC.md` come `IN_SYNC`, `STITCH_CHANGED`,
`CODE_CHANGED`, `LOCAL_CHANGED`, `STITCH_AND_CODE_CHANGED`, `CONFLICT`,
`NOT_IMPLEMENTED` o `DELETED_IN_STITCH`.

Immediatamente prima dell'implementazione: re-fetch Stitch, confronta file
locali e codice, rileva cancellazioni/candidate/scelte, aggiorna metadata,
Design, matrix, coverage, prototipo e acceptance gate. Ogni ciclo ripreso
ricomincia da Stitch.

Dopo la revisione devi scrivere indietro nel progetto Stitch tutte le schermate
revisionate, non solo aggiornare HTML o `.stitch/`. Registra per ciascuna l'ID
remoto, l'operazione MCP e l'esito del write-back. Se il MCP non espone una
write operation compatibile, blocca il handoff e segnala il limite.

## Artefatti e prototipo

Mantieni `.stitch/` con `CURRENT-UI.md`, `CURRENT-STITCH.md`,
`APP-INVENTORY.md`, `STRUCTURE-MATRIX.md`, `FEATURE-MATRIX.md`, `SHELL.md`,
`CANDIDATES.md`, `DECISIONS.md`, `SYNC.md`, `DESIGN.md`, `PROTOTYPE-MAP.md`,
`PROMPTS.md`, `metadata.json`,
`contracts/`, `designs/` e `prototype/`.

`metadata.json` collega project ID, screen ID, pagina logica, candidate group,
stato, dimensioni, HTML/screenshot locali e route.

`DESIGN.md` mappa per schermata Stitch, pagina logica, route, source page,
componenti, handler e interazioni. Usa Design ID e la traccia
`STITCH ELEMENT → FEATURE ID → ROUTE/ACTION → SOURCE COMPONENT`.

Il prototipo deve partire dall'entry point e seguire il flusso reale tramite
link, menu, tab, dropdown, dialog, drawer, sidebar, breadcrumb, form mockati,
filtri, paginazione, stati e destinazioni coerenti. Evita `href="#"` salvo
mock gestito intenzionalmente. Documenta tutto in `PROTOTYPE-MAP.md`.

Valuta default, populated, empty, loading, error, validation error, disabled,
unauthorized, menu/dialog open e viewport desktop/tablet/mobile. Riusa pattern
approvati e registra cambi strutturali intenzionali in `DECISIONS.md`.

## Acceptance gate

Una schermata è `READY_FOR_IMPLEMENTATION` solo se passano: un design effettivo
o scelta esplicita; funzionalità richieste; feature critiche; coverage;
shell; UX; mapping design/codice; prototipo navigabile; sincronizzazione
Stitch/`.stitch`/codice.

## Implementazione e verifica

Stitch è specifica visuale, non business logic. Integra il target nei
componenti, route, stato, form, API, autenticazione, permessi e handler
esistenti; non sostituire comportamento funzionante con HTML statico.

Dopo l'implementazione verifica `STITCH → CODE` e
`ORIGINAL FUNCTIONALITY → NEW IMPLEMENTATION`: navigazione, dialog, form,
filtri, dropdown, loading/error/empty, disabled/unauthorized, responsive,
hover/focus e browser screenshot/console/network quando disponibili.

## Divieti

Non ridisegnare prima dell'audit; non creare un nuovo progetto se quello
richiesto esiste; non sovrascrivere lavoro utente con dati obsoleti; non
implementare design non sincronizzati; non rimuovere funzionalità in silenzio;
non scegliere candidate ambiguamente; non resuscitare schermate cancellate;
non inventare tool/parametri MCP; non lasciare prototipi non navigabili; non
modificare codice prima del sync obbligatorio.

Checklist e template: `references/operational-checklists.md`.
