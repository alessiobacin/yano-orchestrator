# `get-the-best-from` — come si attiva

Playbook globale bundlato (`playbooks/get-the-best-from.yaml`, con un ruolo
dedicato `repo-benchmarker` in `agents/roles.yaml`, `activation: lazy` come
gli altri specialisti a valle di Architect). Non richiede l'iter di
provisioning di Architect: è disponibile subito in ogni progetto che gira su
questa versione di `yano-orchestrator`, esattamente come `conversation` o
`debate`.

## 1. Perché esiste

Prima di questo playbook non esisteva un posto dedicato per "confronta
questo progetto con quest'altra repo su GitHub e dimmi cosa possiamo
rubare/importare". Un task così sarebbe caduto nel cascade di
`candidateForTask()` in modo imprevedibile — molto probabilmente in
`conversation` (nessun verbo di delivery riconosciuto), perdendo però ogni
garanzia strutturale specifica di questo tipo di richiesta: nessuna regola
che imponga analisi indipendenti prima del confronto, nessuna garanzia di
sola lettura sul repository esterno, nessun requisito di citazione
file/riga, nessun promemoria sulla licenza quando la raccomandazione è
"copia questa logica concreta". `get-the-best-from` esiste per dare a
questo tipo di richiesta lo stesso trattamento strutturato che `debate` dà
al confronto tra posizioni astratte — ma applicato a un confronto concreto
tra due repository reali, uno dei quali è il progetto corrente.

## 2. Richiesta in linguaggio naturale al planner

L'attivazione non è un comando CLI diretto: è un messaggio al planner, che
la instrada da solo tramite la stessa valutazione del catalogo usata per
ogni altro task (vedi `prompts/planner.md`, sezione "Scoping" e "Catalogo
playbook e team dinamici").

```text
Confronta il progetto con https://github.com/some-org/some-repo e dimmi
cosa possiamo importare
```

```bash
yano architect assess --project-root "$PWD" \
  --task "Confronta il progetto con https://github.com/some-org/some-repo e dimmi cosa possiamo importare" \
  --json
```

Output reale (verificato in questa sessione):

```json
{
  "candidate_playbook": "get-the-best-from",
  "candidate_reason": "comparative repository benchmarking intent",
  "roles": ["repo-benchmarker"],
  "catalog": {
    "action": "reuse",
    "exact_match": { "id": "get-the-best-from" }
  },
  "playbook_selection": { "user_choice_required": true }
}
```

A differenza dell'esempio di `debate`, qui `user_choice_required` è `true`:
il task condivide singoli token con gli intent di `clean-repo` ("repo"),
`debate` ("confronta") e `conversation` ("cosa"), quindi il catalogo
propone `get-the-best-from` come `recommended` ma elenca anche quei tre
playbook come alternative a punteggio più basso — lo stesso meccanismo di
scoring per intent-overlap usato per qualunque altro task ambiguo, non un
comportamento speciale di questo playbook. Il planner presenta comunque
`get-the-best-from` come raccomandazione principale e procede dopo la
conferma dell'utente sul roster, esattamente come farebbe con qualunque
selezione multipla.

## 3. Cosa fa il planner sotto al cofano

1. **Framing** — il planner conferma con l'utente l'URL della repository di
   riferimento e le focus area del confronto (tutto il progetto, o solo
   architettura/test/tooling/pattern specifici); se l'utente non specifica
   focus area, il confronto di default è completo.
2. **Verifica accessibilità** — prima di lanciare qualunque analisi, il
   planner verifica che entrambi i repository siano leggibili (il progetto
   corrente e la repository di riferimento, che deve essere clonabile o
   fetchabile — se privata e non accessibile, si passa a
   `failure_routes.reference_repository_unreachable_or_private_without_access`).
3. **Lancio delle due istanze indipendenti (`analyzing`)** — il planner
   lancia due istanze di `repo-benchmarker`: una analizza **solo** il
   progetto corrente, l'altra analizza **solo** la repository di
   riferimento (clonata/fetchata in una posizione temporanea isolata, mai
   nel worktree del progetto corrente). Nessuna delle due vede i risultati
   dell'altra finché entrambe non hanno finito — esattamente lo stesso
   principio del turno di apertura indipendente di `debate.yaml`
   (`opening_arguments_are_independent`), qui applicato all'analisi
   comparativa invece che all'argomentazione (vedi l'invariante
   `independent_analysis_before_comparison`). Ogni punto di forza o
   debolezza rilevato deve citare un file (e riga/funzione dove possibile)
   concreto — mai un'impressione generica senza nulla da verificare
   (`evidence_has_file_and_line_references`).
4. **Sintesi (`comparing`)** — una volta raccolte entrambe le analisi, il
   planner scrive un confronto side-by-side con le citazioni di entrambe le
   istanze e una lista concreta di cosa potrebbe essere importato nel
   progetto corrente. Quando una raccomandazione concreta consiste nel
   riutilizzare un pezzo di logica non banale (non solo "il pattern
   generale di fare X"), il report segnala esplicitamente la licenza della
   repository di riferimento ed eventuali obblighi di attribuzione, così la
   decisione copia-vs-reimplementa resta esplicita per l'utente invece di
   passare inosservata (`license_and_attribution_flagged_when_relevant`).
   Il planner stesso non sostituisce mai una propria affermazione non
   verificata alle scoperte citate dai due benchmarker
   (`planner_acts_as_synthesizer_never_a_benchmarker`, lo stesso principio
   di neutralità di `planner_acts_as_moderator_never_a_debater` in
   `debate.yaml`).

## 4. Se la comparazione porta a un task vero

Come per `conversation` e `debate`: se il confronto porta a un intento
concreto e realizzabile ("ok, importiamo il loro sistema di retry,
implementalo"), il planner rilancia `yano architect assess`/
`candidateForTask` per la descrizione ormai concreta del task, presenta il
playbook di consegna raccomandato — tipicamente `backend-change` o
`refactor`, a seconda della natura del cambiamento — e attende conferma.

`playbook_bind` è immutabile per tutta la vita di una run in questo
codebase (vedi `extensions/orchestrator.ts`). `get-the-best-from` rispetta
questa regola come ogni altro playbook: **non** prova mai a ri-legare la
run corrente a un playbook diverso. La run `get-the-best-from` corrente si
limita a transitare in `completed` con un `handoff_target` annotato; è una
**nuova** run — nuovo slug, nuovo worktree, nuovo `plan_set`, nuovo
`playbook_bind` — quella che parte sul playbook raccomandato, solo dopo la
conferma esplicita dell'utente sull'handoff.

## 5. Cosa NON aspettarti da questo playbook

- Non scrive mai nulla nella repository di riferimento: nessun push,
  nessun fork, nessuna PR — è clonata/fetchata in sola lettura in una
  posizione temporanea isolata.
- Non modifica mai il codice reale del progetto corrente durante il
  confronto stesso: è un'analisi, non una consegna. Se la conclusione è
  "importiamo X", quell'implementazione è sempre una **nuova** run su un
  playbook di consegna, mai questa run che si ri-lega.
- Non produce mai un'affermazione vaga tipo "il loro progetto è fatto
  meglio" senza una citazione file/riga concreta da verificare — vedi
  l'invariante `evidence_has_file_and_line_references`.
- Non salta mai in silenzio l'avviso su licenza/attribuzione quando la
  raccomandazione concreta è riutilizzare un pezzo di logica non banale
  (vedi `license_and_attribution_flagged_when_relevant`) — se il
  suggerimento è solo "adotta lo stesso pattern generale", l'avviso non è
  necessario, ma quando si tratta di codice concreto da copiare la
  decisione resta sempre esplicita per l'utente.

## 6. Verifica diretta del playbook

```bash
yano playbook show get-the-best-from --json
```

Restituisce `id: get-the-best-from`, `catalog.scope: global`,
`catalog.reusable: true` — lo stesso schema di ogni altro playbook del
catalogo, verificato da `node scripts/lint-playbooks.mjs`.
