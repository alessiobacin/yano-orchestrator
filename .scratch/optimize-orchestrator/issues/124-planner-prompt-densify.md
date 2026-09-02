Type: human
Kind: task
Status: resolved

## Question

Terzo passo dell'audit di ottimizzazione prompt: riscrivere `prompts/planner.md`
(il file più grande, ~50.7 KB / ~456 righe) in stile denso — tagliare
convenevoli/testo di contorno, trasformare paragrafi descrittivi in elenchi
puntati azionabili, verbi imperativi diretti, mantenendo intatti contesto
critico/vincoli/istruzioni chiave, con tag XML dove aiutano la leggibilità —
preservando ogni stringa/regex già verificata dagli smoke test esistenti.

Prima di riscrivere ho enumerato **tutte** le asserzioni testuali esatte
(stringhe letterali o regex) che gli smoke test fanno contro
`prompts/planner.md`, cercando in tutto il repo (non solo negli script più
ovvi): 22 vincoli distinti, sparsi su 6 file — `smoke-test-development-
contracts.mjs`, `smoke-test-planning-flow.mjs`, `smoke-test-yano-conversation-
playbook.mjs`, `smoke-test-yano-debate-playbook.mjs`, `smoke-test-yano-get-
the-best-from-playbook.mjs`, `smoke-test-e2e-report-regressions.mjs`.

## Answer

**Scelta di scope, dichiarata esplicitamente**: a differenza dei prompt
specialisti (coder/reviewer/specialist/docs-sync/security-evaluator/frontend-
developer, ticket #122-#123), `planner.md` non conteneva quasi nessun vero
"convenevole" o testo di contorno ripetuto — è già scritto in italiano tecnico
denso, accumulato attraverso 48+ "Revisioni" guidate da incidenti reali in
produzione, con logica condizionale molto fitta (es. "a meno che", "solo se",
"tranne quando" annidati nella stessa frase). È anche il prompt più critico
del sistema: guida ogni decisione di orchestrazione, e ha 22 asserzioni
testuali sparse in tutto il documento, non concentrate in poche sezioni.

Dato questo profilo di rischio, e dato che non esiste in questo sandbox un
`pi`/Herdr reale per verificare comportamentalmente se un agente segue
ancora correttamente il prompt riscritto, ho scelto una riscrittura
**mirata e conservativa** invece di una ristrutturazione integrale con tag
XML su tutto il documento:

- Trasformati in elenchi puntati i paragrafi-fiume più densi (quelli con più
  frasi indipendenti concatenate con `;`/`:` in un unico blocco): l'introduzione
  tool, "Preflight obbligatorio", "Scoping" (il paragrafo più lungo del file),
  la chiusura `to-spec`→`to-tickets`, "Notifiche dagli agenti esterni",
  "Worktree e piano" (fasi ordinate), "Catalogo playbook e team dinamici"
  (selezione competitiva tra playbook, requirements/readiness), "Casi limite
  e note operative" (l'intera sezione, un grab-bag di note slegate).
- Rimossa una ridondanza reale: "## Fine fase e risveglio" punti 3 e 4
  ripetevano entrambi per esteso "è una domanda separata dalla conferma
  finale... non implicita in chiudi/procedi" — accorpata in una riga condivisa
  dopo i due punti.
- **Non toccate** le sezioni tecniche ad alta precisione dove il rischio di
  perdere una sfumatura supera il beneficio: "Confine Pi/llmProxy per i
  modelli" (sintassi comandi esatta, messaggi di errore letterali), "Layer
  ticket/DAG persistente", "Watchdog e risvegli", "Conferme dell'utente e
  decision_hold", "Lancio delle istanze", "Indipendenza obbligatoria coder ↔
  reviewer", "Chiusura obbligatoria" — già scritte come elenchi o comunque
  già alla densità minima senza perdita di precisione.
- Nessun tag XML aggiunto: la struttura `##`/`###` esistente già segmenta il
  documento in sezioni indirizzabili (lo stesso ruolo che avrebbero
  `<instructions>`/`<input>`/`<output_format>`), e questo prompt non ha la
  forma singolo-input/singolo-output per cui quei tag sono pensati — è un
  runbook procedurale con ~23 sezioni indipendenti.

**Risultato onesto**: -565 byte su 50.730 (~1.1%), non la riduzione a doppia
cifra ottenuta sui prompt specialisti in #123 (dove la duplicazione
verbatim tra file era l'80% del guadagno). Per `planner.md` non esisteva
duplicazione tra file da eliminare (è l'unico file con questo contenuto), e
il testo non aveva filler vero da tagliare senza perdere precisione — il
guadagno reale di questa passata è nella **leggibilità/parsabilità** (elenchi
puntati vs paragrafi-fiume da 8-12 frasi), non nel conteggio token, in linea
con la regola 5 della richiesta originale ("se aiutano... le performance di
Claude") più che le regole 1-2 (taglio token). Dichiarato esplicitamente
invece di gonfiare il numero.

**Regressione trovata e corretta (non related al planner.md stesso)**: durante
la verifica ho scoperto che il ticket #123 (Priority 2, commit `a64d34b`)
aveva rotto `scripts/smoke-test-custom-prompts.mjs` — quello script ha un
proprio mirror locale `renderTemplate()` (diverso da quello di
`smoke-test-specialist-prompt.mjs`, già corretto in #123) che confronta il
render con un output atteso byte-per-byte, non solo "nessun placeholder
residuo": non conoscendo i 5 nuovi placeholder (`SLUG_REMINDER`,
`WORKER_TOOLS_INTRO`, `DIAGRAM_TIP`, `TURN_CLOSE_NOTE`, `TICKET_CLAIM_STEP0`)
falliva sul confronto esatto di `coder.md` reso. Avevo eseguito
`smoke-test-specialist-prompt.mjs` in #123 ma non questo script gemello.
Corretto aggiungendo le stesse 5 costanti (copiate verbatim da
`extensions/orchestrator.ts`) al mirror di `smoke-test-custom-prompts.mjs`.
Verificato che ora fallisce identicamente su `git stash` (era già rotto
prima di questo ticket, causato da #123) e passa con la correzione.

**Verifica eseguita**:
1. Script ad-hoc che verifica tutti e 22 i vincoli testuali esatti enumerati
   sopra contro il `planner.md` riscritto — tutti passano.
2. `node scripts/check-syntax.mjs` → OK.
3. Tutti gli smoke test che leggono `prompts/planner.md` per contenuto:
   `smoke-test-development-contracts.mjs`, `smoke-test-planning-flow.mjs`,
   `smoke-test-yano-conversation-playbook.mjs`,
   `smoke-test-yano-debate-playbook.mjs`,
   `smoke-test-yano-get-the-best-from-playbook.mjs`,
   `smoke-test-e2e-report-regressions.mjs`, `smoke-test-instance-liveness.mjs`,
   `smoke-test-plan-gate.mjs` → tutti OK.
4. **Suite completa**: tutti gli 88 smoke test eseguiti individualmente uno
   per uno (broker MQTT nativo avviato in locale) — 87 passano, 1 saltato
   (`smoke-test-mcp-credential-preflight.mjs`, richiede il binario `cm` non
   installato in questo sandbox) e un secondo,
   `smoke-test-yano-watcher-registry.mjs`, fallisce per mancanza di un
   server Herdr live — **entrambi verificati come preesistenti e non
   causati da queste modifiche**: falliscono identicamente con `git stash`
   (nessuna modifica di questo ticket applicata).
5. `npm run check:docs` → OK.

Nota onesta, come per #122/#123: questo cambia il testo del prompt
istruzionale più importante del sistema. Non esiste in questo sandbox un
`pi`/Herdr reale per osservare se il planner segue davvero il prompt più
denso nello stesso modo del prompt originale — la verifica qui è
strutturale (tutti i vincoli testuali sopravvivono letteralmente, nessun
contratto di smoke test rotto, la logica condizionale non è stata
riformulata ma solo riformattata in elenchi puntati preservando ogni
condizione), non comportamentale a runtime. Proprio per questo la
riscrittura è stata deliberatamente conservativa sulle sezioni più a
rischio, invece di massimizzare la compressione.

## Comments

- Aperto e risolto nella sessione di ottimizzazione prompt richiesta
  dall'utente (branch `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
- Prossimo passo pianificato (non in questo ticket): Priority #4, script
  deterministici (`yano docs-check`, `yano qa-inventory scan`) per fasi di
  playbook ripetitive attualmente guidate da LLM.
