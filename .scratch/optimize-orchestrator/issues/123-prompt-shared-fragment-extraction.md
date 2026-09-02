Type: human
Kind: task
Status: resolved

## Question

Continuazione dell'audit di ottimizzazione prompt (#122): oltre al blocco
`MANDATORY_SPECIALIST_PLANNER_HANDOFF` già iniettato dal runtime, ho trovato
altri 5 blocchi di testo **byte-per-byte identici o quasi** ripetuti a mano
in più file `prompts/*.md`, ognuno duplicato ad ogni singolo lancio del
ruolo (non un costo una tantum):

1. **Tool-intro + slug reminder** ("Hai a disposizione i tool `agent_list`...
   `file_claim`/`file_release`..." + "**Passa sempre `slug` a `agent_send`**"):
   identico in `coder.md`, `specialist.md`, `docs-sync.md`,
   `frontend-developer.md`. `reviewer.md`/`security-evaluator.md` hanno una
   variante del tool-intro con framing diverso (editor occasionale vs
   primario) ma condividono lo stesso paragrafo slug-reminder verbatim.
2. **Diagram tip** ("## Prima di iniziare: leggi il diagramma, se esiste
   (Revisione 28)..."): identico in `coder.md`, `specialist.md`,
   `security-evaluator.md`, `frontend-developer.md`; `docs-sync.md` ne ha
   una variante con una parentetica aggiuntiva.
3. **Turn-close note** ("## Prima di concludere il turno: dillo sempre
   (Revisione 48)..."): identico in `coder.md`, `reviewer.md`,
   `specialist.md`, `docs-sync.md`, `security-evaluator.md`,
   `frontend-developer.md` — sei copie dello stesso paragrafo, ognuna seguita
   solo da esempi specifici del ruolo.
4. **Ticket-claim step 0** ("Se il messaggio... include anche un `ticket_id`
   (Revisione 26)..."): quasi identico in `specialist.md`, `docs-sync.md`,
   `security-evaluator.md` (`coder.md` ha una variante con numerazione/
   framing propri, non consolidata per non rischiare la sua sequenza di
   step distinta).
5. Bug collegato già segnalato nel ticket #122: `frontend-reviewer` ha
   `brief` impostato in `agents/roles.yaml` ma **manca** dalla lista di
   esclusione `["planner","coder","reviewer"]` in `loadRolePrompt()` —
   riceve quindi anche l'auto-append `MANDATORY_SPECIALIST_PLANNER_HANDOFF`,
   la cui premessa ("non è un'approvazione finale") è attivamente fuorviante
   per lui: la sua approvazione È il gate finale del ciclo
   `frontend-developer → frontend-reviewer → planner`, esattamente come per
   `reviewer` (già escluso).

## Answer

Generalizzato il meccanismo di iniezione runtime già esistente
(`MANDATORY_SPECIALIST_PLANNER_HANDOFF`) a 5 costanti condivise in
`extensions/orchestrator.ts`: `SLUG_REMINDER`, `WORKER_TOOLS_INTRO`,
`DIAGRAM_TIP`, `TURN_CLOSE_NOTE`, `TICKET_CLAIM_STEP0` — sostituite via
`.replaceAll()` nella stessa catena di placeholder già usata per
`{{INSTANCE}}`/`{{BRIEF}}`/ecc. (righe ~3569-3581). Un file che non contiene
un dato placeholder non è toccato (`replaceAll` è un no-op).

File aggiornati con i placeholder, sostituendo solo testo verbatim-identico
(mai testo con sfumature specifiche di ruolo):
- `coder.md`: tool-intro+slug, diagram-tip, turn-close. Ticket-claim step 0
  lasciato intatto (numerazione/framing propri, menziona esplicitamente
  l'approvazione di reviewer).
- `reviewer.md`: solo slug-reminder e turn-close (tool-intro paragrafo
  proprio, framing "editor occasionale" mantenuto).
- `specialist.md` (fallback per ~40 ruoli specialisti): tutti e 4 i
  placeholder applicabili.
- `docs-sync.md`: tutti e 4, con la parentetica specifica sul diagram-tip
  mantenuta accanto al placeholder.
- `security-evaluator.md`: tutti e 4 (slug, diagram-tip, ticket-claim
  step0 con la frase specifica su cosa significa "concluso" per questo
  ruolo mantenuta accanto al placeholder, turn-close).
- `frontend-developer.md`: tool-intro+slug, diagram-tip, turn-close
  (nessun ticket-claim step0 in questo file — la sua sequenza numerata
  parte da 1, non ce l'aveva).
- `frontend-reviewer.md`: nessun placeholder applicabile (file breve,
  autonomo, nessun blocco condiviso verbatim con gli altri) — verificato,
  non toccato oltre al revert della frase Priority-1 (vedi sotto).

Corretto anche il bug del punto 5: lista di esclusione
`["planner","coder","reviewer"]` → `["planner","coder","reviewer",
"frontend-reviewer"]`, con commento che spiega perché (stesso ruolo
funzionale di `reviewer`, gate finale non semplice ping di stato). Di
conseguenza ho **ripristinato** in `frontend-reviewer.md` la frase del
punto 5 del suo protocollo alla forma autonoma originale ("manda
`agent_send` a planner con worktree, report, test e prova browser: è il
gate finale del ciclo...") invece del riferimento "vedi in fondo al tuo
prompt" scritto nel ticket #122 quando ancora assumevo che l'auto-append
gli si applicasse — quel riferimento sarebbe rimasto un rimando a un
blocco che ora, correttamente, non riceve più.

Risparmio di byte per file (misurato, non stimato — solo testo del prompt,
non conta il costo una tantum delle 5 costanti nell'estensione, che sono
definite una volta sola e non duplicate):

| File | Prima | Dopo | Risparmiati |
|---|---|---|---|
| coder.md | 12009 | 10280 | 1729 |
| reviewer.md | 17720 | 17045 | 675 |
| specialist.md | 12355 | 9794 | 2561 |
| docs-sync.md | 11690 | 9608 | 2082 |
| security-evaluator.md | 11217 | 9428 | 1789 |
| frontend-developer.md | 11650 | 10094 | 1556 |

~10.4 KB risparmiati per lancio combinato di questi 6 ruoli (~2500-2600
token stimati a runtime, non una tantum: si ripete a ogni singolo lancio
di ognuno di questi ruoli, e `specialist.md` è il fallback per ~40 ruoli).

Verifica eseguita:
- `node scripts/check-syntax.mjs` → OK.
- `node scripts/smoke-test-specialist-prompt.mjs` → 40 ruoli si renderizzano
  senza placeholder residui. Ho dovuto aggiornare il mirror locale
  `render()` in questo script (aggiunte le 5 nuove sostituzioni, con testo
  segnaposto arbitrario dato che lo script verifica solo l'assenza di
  `{{...}}` residuo, non il contenuto letterale) — senza l'aggiornamento lo
  script falliva perché il suo mirror di `loadRolePrompt()`/`render()` non
  conosceva ancora i 5 nuovi placeholder introdotti nel runtime reale.
- `node scripts/smoke-test-development-contracts.mjs` → OK.
- `node scripts/smoke-test-launch-any-role.mjs` → 41 assertion, incluse
  quelle su frontend-developer/frontend-reviewer e chrome-devtools → OK.
- `npm run check:docs` → OK (9 superfici allineate).
- `node scripts/check-skill-isolation.mjs` → OK.

Nota onesta, come per #122: questo cambia testo di un prompt istruzionale
per un LLM. Non esiste in questo sandbox un `pi`/Herdr reale per osservare
se un agente segue davvero il prompt più corto nello stesso modo — la
verifica qui è strutturale (rendering corretto, nessun placeholder residuo,
nessuna rottura dei contratti testuali già coperti da smoke test,
composizione del comando invariata), non comportamentale a runtime.

## Comments

- Aperto e risolto nella sessione di ottimizzazione prompt richiesta
  dall'utente (branch `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
- Prossimo passo pianificato (non in questo ticket): #124, riscrittura
  densa di `planner.md` (~12.700 token, il file più grande) nello stile
  richiesto dall'utente (elenchi puntati, verbi imperativi, tag XML dove
  utile), preservando le stringhe esatte già verificate dagli smoke test.
