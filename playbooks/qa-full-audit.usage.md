# `qa-full-audit` — come si attiva

Playbook globale bundlato (`playbooks/qa-full-audit.yaml`, ruoli
`qa-inventory-analyst`/`qa-functional-verifier` in `agents/roles.yaml`). Non
richiede l'iter di provisioning di Architect (proposta ephemeral →
validazione → promozione): è disponibile subito in ogni progetto che gira su
questa versione di `yano-orchestrator`, esattamente come `qa-hardening` o
`tdd-agent`.

## 1. Richiesta in linguaggio naturale al planner

L'attivazione normale non è un comando CLI diretto: è una richiesta al
planner, che la instrada da solo.

```text
Fai un controllo qualità su questo progetto per vedere se tutto quello che
prevede questo progetto funziona come dovrebbe.
```

## 2. Cosa fa il planner sotto al cofano

Il planner, per ogni task non banale, esegue prima la valutazione del
catalogo (vedi `prompts/planner.md`, sezione "Catalogo playbook e team
dinamici"):

```bash
yano playbook candidates \
  --task "Fai un controllo qualità su questo progetto per vedere se tutto quello che prevede questo progetto funziona come dovrebbe" \
  --project-root "$PWD" --json
```

Output reale (verificato in questa sessione con `node
scripts/yano-architect.mjs candidates ...` sul repo di yano-orchestrator
stesso):

```json
{
  "recommended": { "id": "qa-full-audit", "score": 120,
    "reasons": ["candidate_for_task", "intent_overlap:2"] },
  "candidates": [
    { "id": "qa-full-audit", "score": 120 },
    { "id": "qa-hardening", "score": 40, "reasons": ["declared_related_playbook"] }
  ],
  "user_choice_required": true
}
```

`user_choice_required: true` perché `qa-hardening` è dichiarato playbook
correlato (`catalog_alternatives`): il planner deve mostrare entrambe le
opzioni, spiegare perché consiglia `qa-full-audit` (audit esaustivo e
riusabile dell'intero progetto) rispetto a `qa-hardening` (follow-up
TDD/mutation su un task specifico) e attendere conferma prima di procedere —
non sceglie in silenzio.

Un task che invece parla solo di test/regressione (es. "Scrivi test di
regressione per il modulo pagamenti") continua a raccomandare `qa-hardening`
come primario, con `qa-full-audit` proposto come alternativa correlata: il
routing esistente non cambia, si arricchisce.

## 3. Binding e avvio dei ruoli

Dopo conferma dell'utente, il planner lega il playbook (`playbook_bind`) e
avvia le istanze via Herdr con il comando standard:

```bash
yano start --instance qa-inventory-analyst-01 --role qa-inventory-analyst
yano start --instance qa-functional-verifier-01 --role qa-functional-verifier
```

Poi delega con `agent_send` prima a `qa-inventory-analyst` (fase `mapping`,
costruisce la matrice), poi a `qa-functional-verifier` (fase `verifying`,
esegue davvero ogni voce) — vedi `playbooks/qa-full-audit.yaml` per stati e
transizioni complete.

## 4. Non solo il comando: anche cosa cambia negli altri comandi

Ogni voce della matrice che muta uno stato persistente o condiviso deve
dichiarare quali altri comandi cambiano risultato di conseguenza, con il
delta atteso — e `qa-functional-verifier` deve verificarlo davvero, non solo
il risultato diretto del comando eseguito. Esempio concreto (lo stesso che
useresti per verificare Yano):

| Comando eseguito | Stato mutato | Comandi downstream da riverificare | Delta atteso |
|---|---|---|---|
| `yano init --name "Demo"` | registra il progetto nel registro globale | `yano projects --json` | `project_count` +1, nuova voce con `root=<path>` |
| | | `yano fleet --project-root <path>` | progetto elencato, agenti ancora offline finché nessuno è avviato |
| `yano start --instance coder-01 --role coder` | avvia un'istanza Pi via Herdr | `yano fleet` | l'istanza `coder-01` passa a presente/online |
| | | `yano projects --json` | il progetto ora conta almeno un agente live |
| `yano end --run <id> --yes` | chiude il run in SQLite | `yano status` | il run non compare più tra quelli attivi |

`qa-functional-verifier` cattura uno snapshot dei comandi downstream
**prima** di eseguire il comando mutante e uno **dopo**, in un ambiente
isolato/deterministico (stesso pattern già usato da
`scripts/smoke-test-*.mjs`: `YANO_DATA_DIR`/`XDG_CONFIG_HOME` puntati a una
directory temporanea, mai lo stato globale reale), e confronta il delta
osservato con quello dichiarato. Un comando che produce l'output diretto
giusto ma non propaga correttamente a un comando downstream dichiarato è un
**FAIL**, non un pass con una nota a margine — vedi l'invariante
`mutating_commands_verified_for_cross_command_propagation` in
`playbooks/qa-full-audit.yaml`.

## 5. Varianti (scelta del planner, non un flag CLI)

Come per `knowledge-authoring`, le varianti sono composizioni di ruoli che il
planner propone in base alla dimensione del task, non un `--variant` di
`yano start` (quel flag esiste solo per le proposte ephemeral di Architect):

- **`quick-gate`** — solo `qa-functional-verifier`, ri-esegue la suite
  automatica già esistente nel progetto target più un campione mirato;
  per un check di routine veloce.
- **`full-audit`** (default per "controllo qualità completo") — entrambi i
  ruoli, con coordinamento di tutti gli specialisti QA/security/performance
  già esistenti e pertinenti al progetto (`security-evaluator`,
  `e2e-simulator`, `a11y-tester`, `speed-benchmarker`, `dependency-health`,
  `mutation-tester`).
- **`self-audit`** — come `full-audit` ma vincolato al confine
  `yano-maintenance` (vedi sotto).

## 6. Caso speciale: self-check di Yano stesso

Quando il progetto di riferimento è `yano-orchestrator`, `qa-functional-verifier`
esegue prima la suite interna già presente nel repo come evidenza di base,
e usa la matrice solo per colmare ciò che quella suite non copre (drift
doc↔comportamento, opzioni non testate):

```bash
npm test                       # scripts/test-all.mjs, tutta la suite smoke-test-*
npm run lint:capabilities
npm run lint:playbooks
npm run check-skill-isolation
npm run check-syntax
yano doctor --network
```

Stesso confine di sicurezza già usato dal ruolo `debugger` in modalità
`yano-maintenance`: mai un altro progetto, mai fuori da un worktree dedicato
di `yano-orchestrator`.
