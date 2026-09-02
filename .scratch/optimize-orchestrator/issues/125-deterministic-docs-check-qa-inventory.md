Type: human
Kind: task
Status: resolved

## Question

Quarto e ultimo passo dell'audit di ottimizzazione: l'utente ha chiesto di
riesaminare il codice per trasformare fasi di playbook attualmente guidate
da LLM in script deterministici, "soprattutto quelle ripetitive". Nel report
iniziale avevo segnalato due candidate concrete, entrambe fasi che un agente
LLM ripete IDENTICAMENTE a ogni singola invocazione senza che serva vero
giudizio per la parte meccanica:

1. **docs-sync, "Contratto documentale canonico"**: ogni round, l'agente deve
   verificare a memoria se ciascuna delle otto categorie canoniche sotto
   `docs/` esiste e ha contenuto, se i percorsi legacy (`docs/quick_guides/`,
   `docs/diagramma/`) hanno ancora roba da migrare, e se restano file vaganti
   direttamente sotto `docs/`. È una verifica di esistenza/non-vacuità di
   file — puramente meccanica, zero giudizio richiesto — che oggi l'LLM
   ricostruisce leggendo la repo ogni volta.
2. **qa-inventory-analyst, step 2 "Raccogli le fonti dichiarate"**: prima di
   poter esercitare il vero giudizio del ruolo (stimare risultato atteso,
   effetti downstream, segnalare ambiguità), l'agente deve enumerare a mano
   ogni comando/opzione da README, `docs/guides/**`, `--help` reale, e per
   Yano stesso anche `agents/*.yaml`/`playbooks/*.yaml` — anche questo è
   raccolta meccanica di fonti, non giudizio.

## Answer

Creati due nuovi comandi CLI deterministici, seguendo esattamente il pattern
già in uso in `scripts/yano-deps.mjs` (`export async function runYanoX({cwd,
argv})`, `--json`, oggetto di report tipizzato, `--project-root`, read-only,
mai un crash — solo un report con `ok:false` e i dettagli):

- **`yano docs-check [--project-root <dir>] [--json]`**
  (`scripts/yano-docs-check.mjs`): verifica scriptata delle otto categorie
  canoniche (stessa lista di `prompts/docs-sync.md` e
  `scripts/smoke-test-clean-repo-documentation-contract.mjs`, tenuta in sync
  a mano — commentato esplicitamente nel file). Per ciascuna: esiste la
  directory, contiene almeno un file non vuoto (`satisfied`), è
  richiesta (`postman` diventa opzionale se non c'è un segnale di backend).
  Segnala anche i percorsi legacy con contenuto residuo da migrare, i file
  vaganti direttamente sotto `docs/` (tranne `README.md`), e un'euristica
  (non vincolante — il campo si chiama `backend_likely`, non `has_backend`)
  sulla presenza di un backend basata su `package.json` e directory tipiche
  (`src/api`, `server`, `routes`, ecc.).
- **`yano qa-inventory scan [--project-root <dir>] [--yano-self-audit]
  [--json]`** (`scripts/yano-qa-inventory.mjs`): estrae candidati comando dai
  blocchi di codice fenced (bash/sh/shell/console/powershell/pwsh/cmd/zsh) in
  README e `docs/guides/**/*.md`, filtrati sul binario CLI dichiarato in
  `package.json.bin` (mai comandi di terze parti indovinati a caso); cattura
  il vero output `--help` del binario (timeout 5s, mai bloccante, mai finto
  se non risponde); con `--yano-self-audit` elenca anche i ruoli di
  `agents/roles.yaml` e gli id di `playbooks/*.yaml`. Produce solo la bozza
  grezza — MAI il risultato atteso, gli effetti downstream o un giudizio
  sull'ambiguità: quello resta il lavoro esclusivo dell'agente, come dichiara
  esplicitamente il commento in testa al file.

Entrambi wired in `bin/yano.mjs` (import, dispatch, help text, doc-comment in
testa al file) e documentati in
`skills-vendor/yano/yano-cli/references/command-reference.md` (sia
nell'elenco top-level sia nella sezione diagnostica), così la skill
`yano-cli` — già dichiarata da entrambi i ruoli in `agents/roles.yaml` — li
rende scopribili senza bisogno di altro wiring.

Aggiornati i due prompt per usarli:
- `prompts/docs-sync.md`, sezione "Contratto documentale canonico": aggiunta
  l'istruzione di eseguire `yano docs-check --json` **prima** di lavorare
  (come lista di lavoro, non come sostituto della lettura) e di **ri-eseguirlo
  a fine round** per confermare che i gap segnalati sono stati chiusi
  davvero, non solo dichiarati chiusi nel report — chiarito esplicitamente
  che l'euristica `postman_backend_heuristic` resta solo un segnale, la
  decisione finale è sempre dell'agente. Testo esistente (checklist
  descrittiva, esempi, formato report) lasciato intatto: il comando integra
  il protocollo, non lo sostituisce.
- `prompts/qa-inventory-analyst.md`, step 2: aggiunta l'istruzione di
  eseguire `yano qa-inventory scan --json` (con `--yano-self-audit` per
  Yano stesso) come primo passo, chiarendo che è solo una bozza grezza da
  integrare con le fonti che lo scan non copre (riferimento comandi
  vendorizzato, spec/ticket del task) — non elimina il resto del protocollo
  di giudizio (stima risultati attesi, effetti downstream, segnalazione
  ambiguità), lo velocizza solo nella parte meccanica.

**Validazione end-to-end reale, non solo unitaria**: ho eseguito entrambi i
comandi contro questo stesso repository (non un mock) e hanno trovato gap
reali e preesistenti — `yano docs-check` ha segnalato correttamente che
`docs/architecture/`, `docs/quick-guides/` e `docs/notes/` mancano, che
`docs/quick_guides/` (23 file) non è ancora stato migrato, e 15 file vaganti
direttamente sotto `docs/` (es. `docs/architecture.md`,
`docs/development-notes.md`); `yano qa-inventory scan --yano-self-audit` ha
estratto 69 candidati comando dal README e catturato il vero `--help` del
binario `yano`, più 43 ruoli e 20 playbook. Questi gap NON sono stati
corretti in questo ticket (è un lavoro di `clean-repo` separato, fuori scope
— la scoperta stessa è la prova che lo script funziona davvero, non solo sui
fixture di test).

**Test scritti** (nuovi, seguendo il pattern esistente con progetti scratch
reali via `mkdtemp`, non mock): `scripts/smoke-test-yano-docs-check.mjs` (7
scenari: zero categorie, tutte soddisfatte con euristica backend positiva,
directory vuota non soddisfatta, percorso legacy con contenuto flaggato,
file vagante rilevato, `--project-root`, read-only garantito) e
`scripts/smoke-test-yano-qa-inventory.mjs` (7 scenari: estrazione da fence
bash E powershell filtrata sul bin dichiarato, scansione ricorsiva di
`docs/guides/**`, cattura `--help` reale, bin mancante gestito senza crash,
`--yano-self-audit` con/senza flag, `--project-root`, mai un crash a vuoto).

**Verifica eseguita**: `node scripts/check-syntax.mjs` → OK.
`node scripts/smoke-test-yano-docs-check.mjs` → 7/7 OK.
`node scripts/smoke-test-yano-qa-inventory.mjs` → 7/7 OK.
`node scripts/smoke-test-clean-repo-documentation-contract.mjs` → OK
(le regex esistenti sui contenuti di `prompts/docs-sync.md` restano
soddisfatte, ho solo aggiunto testo, non rimosso). `node
scripts/check-skill-isolation.mjs` → OK. `node
scripts/smoke-test-yano-cli.mjs` → OK (la reference dei comandi resta
consistente). `node scripts/smoke-test-development-contracts.mjs`,
`node scripts/smoke-test-launch-any-role.mjs`, `npm run check:docs` → OK.
Verifica CLI diretta: `yano docs-check`/`yano qa-inventory scan` (con e
senza `--json`, con `--project-root`) escono con il codice corretto (1 se
`ok:false`, 0 altrimenti) sia invocati come funzione sia tramite `bin/yano.mjs`.

Nota onesta: come per i tre ticket precedenti (#122-#124), questi due
comandi sostituiscono solo la parte MECCANICA delle due fasi — non è
possibile in questo sandbox verificare comportamentalmente se un agente reale
sceglierà davvero di invocarli prima di procedere a mano (il prompt lo
istruisce, ma seguirlo resta una scelta del modello a runtime). La differenza
rispetto a #122-#124 è che qui il guadagno non dipende SOLO dal fatto che
l'agente segua l'istruzione nel prompt: anche se un agente ignorasse
l'istruzione e procedesse comunque a mano, i due comandi restano comunque
disponibili e verificati come strumenti di verifica standalone (es. in un
futuro step di CI, o invocati manualmente dall'operatore) — un guadagno reale
indipendente dal comportamento del modello.

## Comments

- Aperto e risolto nella sessione di ottimizzazione prompt richiesta
  dall'utente (branch `claude/yano-orchestrator-analysis-wmlrlf`), 2026-09-02.
- I gap reali trovati da `yano docs-check` in questo stesso repository
  (categorie mancanti, percorso legacy da migrare, 15 file vaganti sotto
  `docs/`) sono un lavoro di `clean-repo` legittimo ma esplicitamente fuori
  scope da questo ticket — segnalato qui per tracciabilità, non corretto.
