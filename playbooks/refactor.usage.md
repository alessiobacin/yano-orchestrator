# `refactor` — come si attiva

Playbook globale bundlato (`playbooks/refactor.yaml`, ruolo dedicato
`refactoring-specialist` in `agents/roles.yaml`, `activation: lazy` come
gli altri specialisti a valle di Architect). Non richiede l'iter di
provisioning di Architect: è disponibile subito in ogni progetto che gira
su questa versione di `yano-orchestrator`, esattamente come `backend-change`
o `debate`.

## 1. Perché esiste

Prima di questo playbook, `candidateForTask()` in
`scripts/yano-architect.mjs` instradava qualunque richiesta dall'aria di
refactoring — "refactor", "architettura", "modular", "cleanup",
"manutenibil" — dentro il generico `backend-change`:

```js
if (/refactor|refactoring|architettura|modular|cleanup|manutenibil/.test(text)) return { playbook: "backend-change", roles: ["refactoring-specialist", "reviewer"], reason: "refactoring/backend intent" };
```

Il che significava che un refactoring era indistinguibile, a livello di
contratto, da qualunque altro task di consegna backend: stesso stato
`implementing`, stesso gate `tests_run` (basta che i test girino *dopo* la
modifica, non che il loro esito venga confrontato con un prima), nessun
posto dedicato dove imporre esplicitamente "niente feature nuove" e
"comportamento osservabile identico prima e dopo" come contratto invece
che come promemoria nel `brief` del ruolo.

`refactor` è ora un playbook di catalogo a sé stante, sorella di
`backend-change` (stessa ceremony: worktree isolato, reviewer, conferma di
finalizzazione) ma con un contratto più stretto su esattamente l'unica
cosa che definisce un refactoring: uno stato `baseline` dedicato che
registra l'esito dell'intera suite di test *prima* di qualunque modifica,
uno stato `verifying` che la ri-esegue per intero *dopo* — non solo sui
file toccati — e un report di chiusura che porta l'evidenza before/after
non-regressione esplicita, non un generico "i test passano". Vedi gli
invarianti `full_test_suite_green_before_and_after` e
`non_regression_evidence_in_final_report` in `playbooks/refactor.yaml`.

## 2. Richiesta in linguaggio naturale al planner

L'attivazione non è un comando CLI diretto: è un messaggio al planner, che
la instrada da solo tramite la stessa valutazione del catalogo usata per
ogni altro task (vedi `prompts/planner.md`, sezione "Scoping" e "Catalogo
playbook e team dinamici").

```text
Fai un refactoring del modulo di autenticazione per ridurre la duplicazione
```

```bash
yano architect assess --project-root "$PWD" \
  --task "Fai un refactoring del modulo di autenticazione per ridurre la duplicazione" \
  --json
```

Output reale (verificato in questa sessione):

```json
{
  "candidate_playbook": "refactor",
  "candidate_reason": "pure refactoring intent — no behavior change",
  "roles": ["refactoring-specialist", "reviewer"],
  "catalog": {
    "action": "reuse",
    "exact_match": { "id": "refactor" }
  },
  "playbook_selection": { "user_choice_required": false }
}
```

Nota sulla formulazione: una frase come "Rifattorizza il modulo di
autenticazione" (participio coniugato, senza la parola "refactoring"
letterale) **non** attraversa la regex del cascade — che cerca le
sottostringhe letterali `refactor|refactoring|architettura|modular|
cleanup|manutenibil` — e cade nel default `conversation`, con `refactor`
proposto solo come alternativa a punteggio più basso nel catalogo
(`intent_overlap`), non come match esatto. "Fai un refactoring di..." o
"Refactoring di..." attraversano la regex in modo pulito e sono la
formulazione realistica da usare in italiano; l'equivalente inglese
`"refactor the authentication module to reduce duplication"` funziona
altrettanto bene. Nessuna scelta ambigua in nessuno dei due casi:
`user_choice_required` è `false` e il planner procede senza fermare il
turno.

## 3. Cosa fa il planner sotto al cofano

1. **Scoping (`received` → `preflight`)** — il planner conferma con
   l'utente il perimetro del refactoring e, esplicitamente, che non si
   tratta né di una feature nuova né della correzione di un bug non
   collegato (`no_new_feature_or_bugfix_confirmed_with_user`) prima di
   aprire il worktree isolato.
2. **Piano proposto e confermato (`preflight` → `awaiting_plan_confirmation`
   → `baseline`)** — prima ancora di eseguire la baseline dei test,
   `refactoring-specialist` scrive un piano concreto del refactoring:
   quali file/moduli tocca, quale approccio di ristrutturazione userà, e
   cosa esplicitamente NON cambierà. Il planner lo presenta all'utente in
   `awaiting_plan_confirmation` e nessuna transizione verso `baseline` è
   possibile senza `user_approved_refactor_plan` — la conferma di
   perimetro del punto 1 non basta da sola. L'utente può approvare così
   com'è o chiedere una revisione (`user_requests_plan_revision`), e il
   planner ripresenta il piano rivisto invece di procedere. Vedi
   l'invariante `refactor_plan_proposed_and_confirmed_before_any_change`.
3. **Baseline (`baseline` → `refactoring`)** — solo dopo la conferma del
   piano, e prima di toccare una sola riga di codice,
   `refactoring-specialist` esegue **l'intera suite di test esistente**
   (non solo i file che verranno toccati) e ne registra il risultato nel
   report (`full_test_suite_run_before_any_change`,
   `baseline_results_recorded_in_report`). Questo è il momento che
   `backend-change` non ha: lì i test vengono eseguiti solo *dopo* la
   modifica, qui c'è uno stato dedicato a fotografare lo stato "prima".
4. **Refactoring (`refactoring` → `verifying`)** — la ristrutturazione
   vera e propria avviene nel worktree isolato, secondo il piano
   confermato al punto 2. Se durante il lavoro emerge una feature nuova
   genuinamente utile, viene esplicitamente scorporata come task separato
   invece di essere infilata in questo round (invariante
   `no_new_features`, failure route
   `new_feature_or_behavior_change_detected_mid_round`) — mai introdotta
   silenziosamente, e i test non vengono modificati per nascondere un
   fallimento (`tests_not_modified_to_hide_failure`).
5. **Verifica (`verifying` → `review`)** — la stessa suite completa viene
   ri-eseguita per intero (`full_test_suite_rerun_after_change`) e il suo
   esito confrontato con la baseline registrata al punto 3: o combacia, o
   ogni deviazione viene spiegata esplicitamente
   (`post_change_results_match_baseline_or_deviation_explained`), mai
   passata sotto silenzio. L'evidenza before/after viene registrata nel
   report (`non_regression_evidence_recorded`).
6. **Review (`review`)** — il reviewer approva solo dopo aver verificato
   che il round rispetti il contratto: nessuna feature nuova, nessun
   cambio di comportamento osservabile, evidenza before/after reale nel
   report — non una semplice riga "tests pass". Un round che introduce
   comportamento nuovo o omette l'evidenza baseline viene respinto
   (`reject`) con `concrete_findings`, non approvato con riserva.
7. **Completamento (`review` → `completed`)** — il planner chiude solo con
   `reviewer_approved`, `non_regression_evidence_in_final_report` nel
   report finale, e conferma esplicita dell'utente
   (`no_finalize_before_explicit_user_confirmation`), esattamente come
   `backend-change`.

## 4. Differenza da `backend-change`

Stessa ceremony di consegna: worktree isolato
(`isolated_worktree`), approvazione del reviewer
(`reviewer_required_for_code`), nessuna finalizzazione senza conferma
esplicita dell'utente. `refactor` non sostituisce questa ceremony, la
eredita — non è un playbook "leggero" come `conversation` o `debate`.

Quello che aggiunge, come contratto e non come convenzione informale:

- Un piano di refactoring proposto per iscritto e confermato esplicitamente
  dall'utente in uno stato dedicato (`awaiting_plan_confirmation`) prima
  che una sola riga di codice venga toccata — `backend-change` non ha
  questo gate, si affida solo alla proposta generica di team/fasi.
- Uno stato `baseline` dedicato (`backend-change` non ne ha uno: lì i
  test girano solo dopo l'implementazione, dentro `submit_review`).
- La suite di test **completa** ri-eseguita dopo la modifica — non solo i
  file toccati — con un confronto esplicito rispetto alla baseline
  registrata prima.
- Il divieto di feature nuove e di cambi di comportamento osservabile è
  un invariante del playbook (`no_new_features`,
  `identical_observable_behavior_before_and_after`), non solo una riga nel
  `brief` del ruolo `refactoring-specialist` in `agents/roles.yaml`.
- Il report di chiusura deve portare evidenza before/after esplicita
  (`non_regression_evidence_in_final_report`), non un generico "i test
  passano" come potrebbe bastare in un `backend-change` qualunque.

## 5. Cosa NON aspettarti da questo playbook

- Nessuna feature nuova infilata "già che ci siamo" — se emerge durante il
  round, viene scorporata come task separato, mai fusa nel refactoring
  corrente (`no_new_features`).
- Nessuna correzione di bug non collegato al perimetro concordato — un
  bug scoperto durante il refactoring va segnalato, non silenziosamente
  riparato nello stesso round.
- Nessuna ri-esecuzione parziale della suite ("solo i file che ho
  toccato") accettata come evidenza di non-regressione: solo l'intera
  suite, prima e dopo, soddisfa `full_test_suite_green_before_and_after`.
- Nessun cambio di comportamento osservabile — risposte API, output CLI,
  qualunque cosa sia osservabile dall'esterno — a meno di un'eccezione
  esplicitamente confermata in anticipo dall'utente e nominata per nome
  nel report, mai infilata silenziosamente sotto l'etichetta "refactor".

## 6. Verifica diretta del playbook

```bash
yano playbook show refactor --json
```

Restituisce `id: refactor`, `catalog.scope: global`, `catalog.reusable:
true` — lo stesso schema di ogni altro playbook del catalogo, verificato
da `node scripts/lint-playbooks.mjs`.
