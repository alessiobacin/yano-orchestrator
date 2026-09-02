Type: human
Kind: task
Status: resolved

## Question

Dall'audit di ottimizzazione prompt richiesto dall'utente: `extensions/orchestrator.ts`
(`loadRolePrompt()`, righe 652-703) appende **automaticamente**
`MANDATORY_SPECIALIST_PLANNER_HANDOFF` (~250 token, "Handoff obbligatorio al
planner") al termine del prompt di ogni ruolo con `brief` impostato in
`agents/roles.yaml`, tranne `planner`/`coder`/`reviewer`.

Verificato che `docs-sync`, `security-evaluator`, `frontend-developer`,
`frontend-reviewer` hanno tutti `brief` impostato — quindi ricevono questo
blocco automaticamente. Tre di questi (`docs-sync.md`, `security-evaluator.md`,
`frontend-reviewer.md`) scrivono ANCHE a mano una propria istruzione generica
"rispondi/manda con `agent_send` a planner con un riassunto", che nel prompt
renderizzato finale finisce impilata subito prima del blocco identico
auto-iniettato — token sprecati a ogni singolo lancio di questi ruoli, non un
risparmio una tantum.

Verificato invece che `qa-functional-verifier.md`, `qa-inventory-analyst.md`,
`tdd-agent.md`, `architecture-diagrammer.md` NON ripetono questa istruzione:
si affidano correttamente al meccanismo automatico. Il pattern corretto esiste
già nel repo, applicato in modo incoerente.

Caso particolare `frontend-reviewer`: il suo "manda a planner" non è un ping
di stato come per gli altri specialisti, è il gate di chiusura del ciclo
`frontend-developer → frontend-reviewer → planner` (stesso ruolo funzionale
del `reviewer` backend, che infatti è esplicitamente escluso dal meccanismo
automatico). `frontend-reviewer` non è nella lista di esclusione
`["planner","coder","reviewer"]` — probabile svista, non decisione
deliberata. Non l'ho corretta in questo ticket (richiede toccare l'elenco di
esclusione nell'estensione, rischio più alto): segnalata per il ticket #123
(estrazione dei blocchi condivisi), che tocca comunque lo stesso file.

## Answer

Sfoltiti i tre file rimuovendo solo la parte letteralmente ridondante con
`MANDATORY_SPECIALIST_PLANNER_HANDOFF` (il "rispondi/manda ad agent_send a
planner con un riassunto" generico), **conservando** ogni sfumatura
specifica di ruolo che l'auto-append non copre:

- `docs-sync.md`: mantenuta la regola "il tuo output è quasi sempre già il
  risultato finale, eccezione solo su un vero disallineamento doc↔codice
  (manda a coder, riverifica, poi procedi)".
- `security-evaluator.md`: mantenuta la regola "se la tua fase è l'ultima
  prima della chiusura, dillo esplicitamente (ultimo gate prima del merge)".
- `frontend-reviewer.md`: mantenuto l'elenco di contenuto specifico
  (worktree, report, test, prova browser) e la frase sul flusso obbligatorio
  `planner → frontend-developer → frontend-reviewer → planner`.

`frontend-developer.md` non è stato toccato: la sua istruzione "manda SEMPRE
a frontend-reviewer, mai a reviewer o al planner direttamente" non duplica
l'auto-append (non menziona affatto un invio diretto a planner), quindi non
c'era ridondanza da correggere lì.

Verifica: `node scripts/smoke-test-specialist-prompt.mjs` (40 ruoli si
renderizzano senza placeholder residui), `node scripts/smoke-test-development-contracts.mjs`
(nessuna delle stringhe verificate testualmente tocca queste sezioni),
`npm run check:docs`. Nota onesta: questo cambia testo di un prompt
istruzionale per un LLM — non esiste in questo sandbox un `pi`/Herdr reale
per verificare il comportamento a runtime; la verifica qui è strutturale
(caricamento, assenza di placeholder, assenza di rottura dei contratti
testuali già coperti da smoke test), non comportamentale.

## Comments

- Aperto e risolto nella sessione di ottimizzazione prompt richiesta
  dall'utente (branch `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
