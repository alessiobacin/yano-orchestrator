# Proposta: playbook globale `qa-full-audit` (controllo qualità funzionale completo / self-check)

Data: 2026-08-28
Autore: sessione Claude (Cowork), su richiesta di Alessio
Stato: **bozza di proposta**, non ancora promossa nel catalogo globale Yano

## 1. Obiettivo

Dare al planner (di yano-orchestrator o di qualunque progetto gestito da
Yano) un playbook riusabile che, a fronte di una richiesta come *"Fai un
controllo qualità su questo progetto per vedere se tutto quello che prevede
questo progetto funziona come dovrebbe"*, produca:

1. una **matrice canonica** di tutti i comandi/funzionalità/endpoint
   dichiarati dal progetto, con tutte le opzioni rilevanti e il risultato
   atteso per ciascuna;
2. una **verifica funzionale reale** (non solo lettura del codice) di ogni
   voce, con evidenza riproducibile (comando, exit code, output);
3. un **ciclo di correzione** che passa da coder/reviewer (o
   frontend-developer/frontend-reviewer) come qualunque bug normale, MAI
   dal playbook stesso;
4. una **ri-verifica completa** dopo ogni correzione, non solo delle voci
   corrette, prima di dichiarare il progetto "verde";
5. la possibilità di applicare lo stesso playbook a **Yano stesso**, nello
   stesso confine di sicurezza già usato dal ruolo `debugger` in modalità
   `yano-maintenance` (mai un altro progetto, mai fuori da un worktree).

## 2. Cosa ho verificato oggi (review reale, non solo lettura)

Dal Mac collegato, dentro `yano-orchestrator/`, ho eseguito i controlli
automatici già presenti nel repo che sono sicuri (read-only o comunque privi
di effetti collaterali su MQTT/Herdr/deploy reali):

| Comando | Esito |
|---|---|
| `npm run lint:capabilities` | OK — 16 capability registrate, tutte le dichiarazioni di ruolo risolvono |
| `npm run lint:playbooks` | OK — 14/14 playbook validano (incluso il checksum di ognuno) |
| `npm run check-skill-isolation` | OK — 17/17 controlli passati (isolamento skill mattpocock/awesome-copilot/yano per ruolo) |
| `npm run check-syntax` | OK — `extensions/orchestrator.ts` sintatticamente valido |
| Validazione del mio playbook di bozza con il vero loader (`scripts/playbook-loader.mjs`) | OK — `qa-full-audit` carica e produce un checksum valido, stessa pipeline usata da `lint:playbooks` |

**Limite di questa sessione**: i binari `yano` e `herdr` non risultano sul
PATH della VM Linux isolata usata da questa sessione per operare sul tuo
Mac (verificato con `which`/`bash -lc`); lo stesso vale per `docker`. Questo
NON è necessariamente un problema del progetto: è plausibile che siano
installati nel tuo terminale reale ma non in questa sandbox dedicata. Di
conseguenza non ho potuto eseguire dal vivo `yano --help`, i sottocomandi
reali (`yano architect assess`, `yano playbook candidates`, `yano doctor`,
ecc.) né `npm test` (che richiede un broker MQTT, avviato via Docker se
assente). Questo è esattamente il tipo di comando che il nuovo playbook
dovrebbe eseguire lui stesso, dentro una vera sessione planner sul tuo
Mac — è la prova pratica che serve un ruolo che *esegua* i comandi, non solo
chi legga il codice.

## 3. Cosa esiste già nel catalogo (gap analysis)

Ho letto tutti i playbook (`playbooks/*.yaml`), tutti i ruoli
(`agents/roles.yaml`, `agents/agents.yaml`, `agents/capabilities.yaml`),
tutti i prompt (`prompts/*.md`) e la documentazione del catalogo
(`docs/playbook-catalog.md`, `docs/quick_guides/21-yano-cli-semantica.md`).
Nessun playbook esistente copre esattamente questo bisogno:

- **`qa-hardening`** (ruoli `tdd-agent`, `mutation-tester`) — copre
  follow-up TDD, mutation testing, e2e/a11y/regressione, ma parte sempre da
  una spec di un task specifico, non da un inventario esaustivo di *tutte*
  le funzionalità già esistenti del progetto.
- **`observer-audit`** (usato da `watcher`, `debugger`, `auto-improver`,
  `suggester`) — è **strettamente read-only**: raccoglie evidenze e le
  consegna al planner, ma non ha un ciclo di remediation né una
  ri-verifica finale. È il pattern giusto per "osservare", non per
  "garantire che tutto funzioni".
- **`security-review`**, **`performance-observability`**,
  **`documentation-release`** — coprono una singola dimensione (sicurezza,
  performance, coerenza doc↔codice), non l'intera superficie
  funzionale/comandi del progetto.
- La suite interna di Yano (`scripts/smoke-test-*.mjs`, `npm test`,
  `lint:capabilities`, `lint:playbooks`, `check-skill-isolation`,
  `yano doctor`) è **reale e preziosa**, ma è pensata per gli sviluppatori
  di Yano stesso (CI/manutenzione), non è invocabile da un planner con una
  richiesta in linguaggio naturale su *un progetto qualsiasi*, e non copre
  il drift tra documentazione e comportamento reale (uno smoke test
  verifica ciò che chi l'ha scritto pensava fosse giusto, non ciò che il
  README promette).

**Conclusione**: manca un playbook che (a) parta dalla documentazione/spec
per costruire l'elenco esaustivo di cosa "dovrebbe" fare il progetto, (b)
lo verifichi davvero eseguendo i comandi, (c) instradi le correzioni nel
ciclo normale coder/reviewer, (d) non si dichiari mai concluso con un
finding bloccante aperto, e (e) sia applicabile sia a un progetto
applicativo sia a Yano stesso. Per la stessa logica che userebbe Architect
(`yano architect assess` → `catalog.action`), questo è un caso `create`, non
`reuse`.

## 4. Design proposto

### 4.1 Nuovo playbook globale: `qa-full-audit`

File completo: [`playbook.yaml`](./playbook.yaml) (già validato con il vero
loader di Yano, vedi §2). Stati: `received → preflight → mapping →
verifying → findings → remediation → reverifying → completed/blocked`, con
un arco esplicito `reverifying → findings` se dopo la correzione restano
falle (il gate NON si chiude finché non è pulito). Invarianti chiave:
`matrix_covers_every_documented_capability`,
`no_finding_marked_resolved_without_reverification`,
`reverification_runs_the_full_matrix_not_only_fixed_items`,
`no_completion_with_open_blocking_finding`.

### 4.2 Due nuovi ruoli specialisti (`agents/roles.yaml`)

File: [`roles-additions.yaml`](./roles-additions.yaml).

- **`qa-inventory-analyst`** (reasoning-model) — legge README, guide,
  `--help` reale, command-reference, e per Yano stesso anche
  `agents/*.yaml`/`playbooks/*.yaml`; scrive la matrice comando→risultato
  atteso→fonte→già-coperto-da-test-esistente-sì/no. Non esegue nulla.
- **`qa-functional-verifier`** (coding-model) — esegue davvero ogni riga
  della matrice in worktree/sandbox isolata, mai su dati di produzione;
  classifica PASS/FAIL/BLOCKED con evidenza; coordina in parallelo gli
  specialisti già esistenti pertinenti (`security-evaluator`,
  `e2e-simulator`, `a11y-tester`, `speed-benchmarker`,
  `dependency-health`, `mutation-tester`) invece di duplicarli; dopo ogni
  ciclo di correzione ri-esegue **l'intera matrice**.

Il planner resta il solo che apre i ticket di correzione e li instrada a
`coder`/`reviewer` (o `frontend-developer`/`frontend-reviewer`): il nuovo
playbook non introduce un meccanismo di remediation parallelo, riusa quello
già esistente (`backend-change`/`frontend-browser`), rispettando il vincolo
di Yano "le dipendenze tra playbook non sono supportate" — è il planner,
non il playbook, a comporre i ruoli di più playbook nella stessa run, esattamente
come già fa oggi per un task misto backend+frontend+docs.

### 4.3 Due prompt dedicati

File: [`prompts/qa-inventory-analyst.md`](./prompts/qa-inventory-analyst.md),
[`prompts/qa-functional-verifier.md`](./prompts/qa-functional-verifier.md) —
nello stesso stile compatto di `prompts/tdd-agent.md`/`prompts/debugger.md`
(placeholder `{{BRIEF}}`/`{{CAPABILITIES}}`, protocollo numerato).

### 4.4 Caso speciale: self-check di Yano

Quando il progetto di riferimento è Yano stesso, il protocollo di
`qa-functional-verifier` (punto 3) impone di eseguire **prima** la suite
interna già esistente (`npm test`, i tre `lint:*`/`check-*`, `yano doctor`)
come evidenza di base, e di usare la matrice solo per colmare ciò che quella
suite non copre — esattamente la distinzione che ho constatato oggi: i
quattro controlli automatici che ho lanciato sono passati, ma non toccano
minimamente drift doc↔comportamento o combinazioni di opzioni non testate.
Il confine di sicurezza è lo stesso già usato dal `debugger` in modalità
`yano-maintenance`: mai mutare il catalogo globale o un altro progetto, solo
lavorare in un worktree dedicato di `yano-orchestrator`.

### 4.5 Varianti da proporre nell'intervista di Architect

Come `knowledge-authoring` (variants `single-author`/`research-and-author`/
`full-team`), propongo che Architect offra:

- **`quick-gate`** — solo `qa-functional-verifier`, ri-esegue la suite
  automatica già esistente nel progetto target più un campione mirato della
  matrice; per un check di routine veloce.
- **`full-audit`** (default per "controllo qualità completo") —
  `qa-inventory-analyst` + `qa-functional-verifier` al completo, con
  coordinamento di tutti gli specialisti pertinenti disponibili nel
  progetto (security, e2e, a11y, performance, mutation).
- **`self-audit`** — come `full-audit` ma vincolato al confine
  `yano-maintenance`, con priorità assoluta alla suite interna esistente.

## 5. Patch documentale suggerita

File: [`docs-catalog-patch.md`](./docs-catalog-patch.md) — riga da
aggiungere alla tabella di `docs/playbook-catalog.md` e bullet per la
sezione "Specialist checklists". Non serve toccare `prompts/planner.md`: il
meccanismo `yano architect assess`/`yano playbook candidates` è già
generico e instraderà la richiesta in linguaggio naturale una volta che il
playbook è promosso, a patto che `label`/`description` contengano parole
chiave come "qualità", "audit", "verifica funzionale", "self-check",
"comandi" (già il caso in questa bozza).

## 6. Come si attiva per davvero (percorso reale, non bypassabile da qui)

Questa sessione non ha accesso a `yano`/`herdr` (vedi §2), quindi non posso
eseguire dal vivo il flusso reale di promozione. Il percorso corretto,
coerente con `playbooks/architect-provisioning.yaml`, è:

1. Apri una sessione planner reale su questo progetto (o su qualunque altro
   progetto Yano) e chiedi: *"Fai un controllo qualità completo su questo
   progetto per vedere se tutto funziona come dovrebbe."*
2. Il planner esegue `yano architect assess --project-root <root> --task
   "<task>" --json`; con questa bozza ancora non promossa, `catalog.action`
   risulterà `create`.
3. Architect apre l'intervista (`yano architect propose --new-playbook`):
   ambito globale, agente singolo/team, velocità/profondità — puoi
   rispondere ricalcando §4.5 sopra, oppure indicare a chi ti assiste in
   quella sessione di partire da questa cartella (`playbook.yaml`,
   `roles-additions.yaml`, `prompts/*.md`) come contenuto della proposta
   invece di scriverla da zero.
4. Dopo `yano architect answer --status approved`, Architect verifica ogni
   capability dichiarata (`yano architect verify`), il watcher osserva una
   run ephemeral di validazione, e solo con esito sano + tuo feedback
   positivo Architect esegue `yano architect promote`.
5. Da quel momento qualunque planner, su qualunque progetto, troverà
   `qa-full-audit` tra i candidati di `yano architect assess`/
   `yano playbook candidates` per richieste simili.

## 7. Decisioni aperte da confermare

- **Nome**: `qa-full-audit` va bene, o preferisci un altro id (es.
  `quality-gate`, `capability-audit`, `self-check`)? Il nome finale lo
  fissa comunque Architect durante l'intervista.
- **Riuso vs nuova skill**: ho fatto riferimento a skill già esistenti
  (`documentation-lookup`, `tdd-development`, `yano-planner-trace-analysis`,
  `yano-cli`) invece di proporne di nuove, per restare nel perimetro già
  provisionato. Se preferisci una skill dedicata (es.
  `capability-inventory-mapping`) va aggiunta al catalogo skill e
  verificata da Architect come qualunque altra capability.
- **Dove vivono questi file**: li ho scritti in
  `.scratch/qa-full-audit-proposal/` (convenzione già usata dal repo per
  piani/proposte non ancora operative) invece che direttamente in
  `playbooks/`, `agents/roles.yaml`, `prompts/` — editare quei file live
  cambierebbe subito il comportamento di ogni istanza reale che li legge,
  quindi ho preferito lasciare la promozione al flusso Architect reale (o a
  una tua conferma esplicita se preferisci che li applichi io direttamente
  qui nel repo, fuori dal flusso Architect).

## 8. File di questa proposta

- `playbook.yaml` — playbook completo, già validato con
  `scripts/playbook-loader.mjs`
- `roles-additions.yaml` — le due nuove voci per `agents/roles.yaml`
- `prompts/qa-inventory-analyst.md`
- `prompts/qa-functional-verifier.md`
- `docs-catalog-patch.md` — patch per `docs/playbook-catalog.md`
- `PROPOSAL.md` — questo documento
