# `debate` — come si attiva

Playbook globale bundlato (`playbooks/debate.yaml`, con un ruolo dedicato
`debater` in `agents/roles.yaml`, `activation: lazy` come gli altri
specialisti a valle di Architect). Non richiede l'iter di provisioning di
Architect: è disponibile subito in ogni progetto che gira su questa
versione di `yano-orchestrator`, esattamente come `conversation` o
`qa-full-audit`.

## 1. Perché esiste

Fino a `yano model-advisor` (vedi `docs/quick-guides/yano-model-advisor.md`), ogni ruolo
in `agents/roles.yaml` dichiarava un `model` fisso (`reasoning-model` o
`coding-model`, un'alias sempre uguale): far parlare due istanze dello
stesso ruolo su un topic controverso significava, di fatto, far parlare lo
stesso modello con se stesso sotto due prompt diversi — variazione di
prompt travestita da confronto, non un vero secondo punto di vista.

Ora ogni ruolo parte da `model: llmproxy` (routing automatico) e
`yano model-advisor recommend --role-class coordinator --json` restituisce
un pin concreto scelto sul catalogo **live** di llmProxy in base a costo,
punteggio di coding e latenza reali del momento — non una scelta fissa una
volta per tutte. `debate` è il playbook che sfrutta questo per uno scopo
preciso: il planner lancia più istanze del ruolo `debater` e pinna
**deliberatamente** ciascuna a un modello diverso tra quelli che il
catalogo live offre, così la diversità di opinione nel dibattito è
diversità di modello reale, non solo variazione di prompt sullo stesso
modello. Vedi l'invariante `model_diversity_is_the_point` in
`playbooks/debate.yaml`.

## 2. Richiesta in linguaggio naturale al planner

L'attivazione non è un comando CLI diretto: è un messaggio al planner, che
la instrada da solo tramite la stessa valutazione del catalogo usata per
ogni altro task (vedi `prompts/planner.md`, sezione "Scoping" e "Catalogo
playbook e team dinamici").

```text
Facciamo un dibattito: conviene usare Postgres o MongoDB per questo caso?
```

```bash
yano architect assess --project-root "$PWD" \
  --task "Facciamo un dibattito: conviene usare Postgres o MongoDB per questo caso?" \
  --json
```

Output reale (verificato in questa sessione):

```json
{
  "candidate_playbook": "debate",
  "candidate_reason": "structured multi-model debate intent",
  "roles": ["debater"],
  "catalog": {
    "action": "reuse",
    "exact_match": { "id": "debate" }
  },
  "playbook_selection": { "user_choice_required": false }
}
```

Nessuna scelta ambigua: `debate` non ha `catalog_alternatives` dichiarate
da nessun altro branch del cascade, quindi `user_choice_required` è
`false` e il planner procede senza fermare il turno.

## 3. Cosa fa il planner sotto al cofano

1. **Framing** — il planner riformula il topic in modo neutro (non prende
   posizione lui stesso, vedi l'invariante
   `planner_acts_as_moderator_never_a_debater`) e decide quante istanze di
   `debater` servono — normalmente **2-4**, quante posizioni distinte ha
   senso far confrontare per quel topic — e quale stance assegnare a
   ciascuna.
2. **Proposta modelli** — per ciascuna istanza chiama
   `yano model-advisor recommend --role-class coordinator --json` (stessa
   sezione "### Modelli per agente" di `prompts/planner.md` usata per ogni
   altro ruolo) e cerca di pinnare **modelli distinti** tra le istanze,
   quando il catalogo live ne offre almeno due opzioni valide. Se il
   catalogo non è raggiungibile o offre meno di due opzioni valide, lo
   dichiara esplicitamente nella proposta invece di far girare tutti i
   debater sullo stesso modello in silenzio.
3. **Conferma utente** — presenta roster, stance e modelli nello stesso
   messaggio (come fa per qualunque team) e aspetta conferma prima di
   lanciare le istanze — nessun `worktree_create`, nessun `plan_set`.
4. **Turno di apertura (`opening_round`)** — ogni debater riceve solo il
   topic e la propria stance, mai gli argomenti degli altri: il planner
   non inoltra nessun argomento di apertura finché non li ha ricevuti
   tutti (invariante `opening_arguments_are_independent`). È il punto
   dell'intero playbook — un round parallelo davvero indipendente, non
   una catena dove il secondo debater ancora la propria risposta a quella
   del primo.
5. **Turno di replica (`rebuttal_round`)** — una volta raccolti tutti gli
   argomenti di apertura, il planner li condivide con tutti i debater e
   raccoglie le repliche: ciascun debater vede gli argomenti altrui e
   risponde nel merito, eventualmente dichiarando se un controargomento
   l'ha davvero convinto a cambiare posizione (vedi il `brief` del ruolo
   `debater` in `agents/roles.yaml`).
6. **Sintesi (`synthesizing`)** — il planner scrive una sintesi che
   attribuisce ogni posizione rilevante al debater/modello che l'ha
   sostenuta e nomina esplicitamente dove i debater hanno convergito e
   dove sono rimasti in disaccordo — mai una risposta unica "fusa" che
   nasconde il disaccordo (invariante `synthesis_names_agreement_and_disagreement`).

Se un modello pinnato smette di rispondere a metà round per un errore di
provider/autenticazione, il fallback è lo stesso di qualunque altro ruolo:
`llmproxy` auto, poi errore reale solo se anche l'auto fallisce — e viene
dichiarato nella sintesi finale (`any_model_fallback_disclosed_to_user`),
mai lasciato silenzioso.

## 4. Se il dibattito cristallizza in un task vero

Come per `conversation`: se la sintesi rivela un intento concreto e
realizzabile ("ok, andiamo con Postgres, implementalo"), il planner
rilancia `yano architect assess`/`candidateForTask` per la descrizione
ormai concreta del task, presenta il playbook di consegna raccomandato e
attende conferma.

`playbook_bind` è immutabile per tutta la vita di una run in questo
codebase (vedi `extensions/orchestrator.ts`). `debate` rispetta questa
regola come ogni altro playbook: **non** prova mai a ri-legare la run
corrente a un playbook diverso. La run `debate` corrente si limita a
transitare in `completed` con un `handoff_target` annotato; è una
**nuova** run — nuovo slug, nuovo worktree, nuovo `plan_set`, nuovo
`playbook_bind` — quella che parte sul playbook raccomandato, solo dopo la
conferma esplicita dell'utente sull'handoff.

## 5. Cosa NON aspettarti da questo playbook

A differenza di `qa-full-audit` o di qualunque playbook di consegna:

- Non crea nessun worktree.
- Non produce nessun report di consegna (`.pi/extensions/yano-orchestrator/reports/<slug>.md`)
  nel senso dei playbook di delivery — è un dibattito, non un task tracciato
  a fasi di implementazione.
- Non chiama mai `plan_set`, `ticket_create` o `worktree_finalize`.
- Non ferma il turno per una conferma del team nel senso di
  `qa-full-audit` — l'unica conferma esplicita che ha senso qui, oltre a
  quella iniziale su roster/stance/modelli, è quella sull'handoff, quando
  il dibattito cristallizza in un vero task.
- Non produce mai una singola risposta "blended" che nasconde il
  disaccordo: la sintesi deve attribuire ogni posizione rilevante al
  debater/modello che l'ha sostenuta, altrimenti `conclude_debate` non è
  autorizzato (vedi `synthesis_names_agreement_and_disagreement`).

## 6. Verifica diretta del playbook

```bash
yano playbook show debate --json
```

Restituisce `id: debate`, `catalog.scope: global`, `catalog.reusable:
true` — lo stesso schema di ogni altro playbook del catalogo, verificato
da `node scripts/lint-playbooks.mjs`.
