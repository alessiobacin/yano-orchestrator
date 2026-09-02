# Vendored skills — mattpocock/skills

Questa cartella contiene una copia **vendorizzata** (non un mirror che si
aggiorna da solo) di alcune skill del repo pubblico di Matt Pocock. Vive
FUORI da `.pi/skills/`, `~/.pi/agent/skills/` e `.agents/skills/`
deliberatamente, per non attivare la discovery automatica di Pi su tutti i
ruoli. Le skill di pianificazione vengono caricate esplicitamente solo per il
ruolo `planner`; la snapshot di `code-review` è conservata come riferimento e
il reviewer usa l'adapter Yano dedicato in
`skills-vendor/yano/yano-code-review/` (vedi `scripts/launch-planner.mjs`).

- **Repo sorgente**: https://github.com/mattpocock/skills
- **Commit pinnato**: `9c9f36ccd3995266cd675468af71639c8dde1ec5`
- **Link al commit**: https://github.com/mattpocock/skills/commit/9c9f36ccd3995266cd675468af71639c8dde1ec5
- **Data del pin**: 2026-08-18
- **Fetch**: `git clone --depth 1` (shallow, HEAD al momento del pin — non uno
  sparse-checkout, l'intero repo è stato clonato in una directory scratch e
  poi solo le directory elencate sotto sono state copiate qui)

## Skill vendorizzate e perché

Richieste esplicitamente dall'utente:

- **`wayfinder`** (da `skills/engineering/wayfinder/` nel repo sorgente) —
  scompone un task grande/ambiguo in una mappa di "ticket" di decisione,
  risolti uno alla volta finché la via non è chiara.
- **`to-spec`** (da `skills/engineering/to-spec/`) — collassa la
  conversazione/mappa di decisioni in un'unica spec pubblicata sul tracker.
- **`to-tickets`** (da `skills/engineering/to-tickets/`) — trasforma la spec
  approvata in tracer-bullet vertical slices con criteri di accettazione e
  blocking edges. In Yano il suo output Markdown viene importato una sola
  volta nel layer SQLite/DAG, che resta la fonte runtime.
- **`code-review`** (da `skills/engineering/code-review/`) — snapshot del
  metodo a due assi Spec/Standards e del baseline di code smell. Non viene
  iniettata integralmente nel reviewer perché il suo workflow originale usa
  fixed point richiesto all'utente e sub-agent paralleli; Yano ne usa i
  contenuti tramite l'adapter runtime `yano-code-review`.

Vendorizzate perché sono **dipendenze dirette e non aggirabili** di wayfinder,
to-spec e del flusso di planning (letto il `SKILL.md` di ognuna prima di
escluderle o integrarle, come richiesto):

- **`grilling`** (da `skills/productivity/grilling/`) — la primitiva di
  interrogazione a round che `wayfinder` invoca via Skill tool in OGNI
  sessione di charting ("Name the destination" e "Map the frontier" la
  chiamano entrambe, incondizionatamente).
- **`domain-modeling`** (da `skills/engineering/domain-modeling/`) —
  **scoperta durante il vendoring, non anticipata nella richiesta
  originale**: `wayfinder` chiama il Skill tool con `"domain-modeling"`
  esattamente negli stessi due punti incondizionati in cui chiama
  `"grilling"` ("call the Skill tool twice, for 'grilling' and
  'domain-modeling'"). Senza vendorizzarla, ogni sessione di charting di
  wayfinder fallirebbe quel passo. Include anche `ADR-FORMAT.md` e
  `CONTEXT-FORMAT.md`, referenziati dal suo stesso `SKILL.md` — copiati
  insieme perché parte della stessa directory.
- **`setup-matt-pocock-skills`** (da
  `skills/engineering/setup-matt-pocock-skills/`) — entrambe `wayfinder` e
  `to-spec` rimandano a questa skill se il tracker/vocabolario di triage non
  è ancora configurato per il repo ("tell the user to run
  `/setup-matt-pocock-skills`"). Vendorizzata per intero, inclusi i
  template seed (`issue-tracker-github.md`, `issue-tracker-gitlab.md`,
  `issue-tracker-local.md`, `triage-labels.md`, `domain.md`) — solo
  `issue-tracker-local.md` viene effettivamente usato in questo repo (vedi
  sotto), gli altri restano inerti ma fanno parte della directory completa
  della skill.

## Esplicitamente fuori scope (richiesta dell'utente)

- **`implement`** (`skills/engineering/`) — esclusa su richiesta esplicita
  dell'utente. Non toccata e non vendorizzata; le sue pratiche utili sono già
  riflesse nei prompt coder/reviewer e nei playbook.

## Dipendenza NON vendorizzata, nota e documentata (limite noto)

Il `SKILL.md` di `wayfinder` referenzia anche due skill aggiuntive, ma solo
**condizionatamente** — non in ogni sessione, solo se un ticket di un certo
tipo viene creato durante il charting:

- **`research`** (`skills/engineering/research/`) — invocata via Skill tool
  solo per ticket di tipo "Research".
- **`prototype`** (`skills/engineering/prototype/`) — invocata via Skill
  tool solo per ticket di tipo "Prototype".

Scelta deliberata: **non vendorizzate**. A differenza di `grilling` e
`domain-modeling` (chiamate SEMPRE, in ogni sessione di charting), queste
due dipendono dal tipo di ticket che wayfinder decide di creare — la mappa
può benissimo usare solo ticket `grilling`/`task` e non incontrare mai
questo limite. Vendorizzarle avrebbe ampliato lo scope ben oltre le "due
skill" richieste esplicitamente dall'utente (sono skill sostanzialmente più
grandi, con proprie logiche di subagent).

**Limite noto e conseguenza concreta**: se durante una sessione `wayfinder`
del planner viene creato un ticket di tipo `research` o `prototype`, il
tentativo di risolverlo chiamando il relativo Skill tool fallirà (skill non
caricata per quella sessione). `prompts/planner.md` documenta questo limite
esplicitamente e istruisce il planner a preferire i tipi `grilling`/`task`
e, se un ticket `research`/`prototype` emerge comunque dalla mappa, a
segnalarlo all'utente invece di tentare di risolverlo silenziosamente. Se
in futuro serve superare questo limite, vendorizzare anche `research`/
`prototype` con lo stesso procedimento di questo file.

## Tracker: markdown locale, nessuna dipendenza da GitHub

Su richiesta esplicita dell'utente, nessuna dipendenza da GitHub Issues.
`setup-matt-pocock-skills` è stato eseguito in una sessione planner
scegliendo il tracker **"Local Markdown"** (`issue-tracker-local.md`) —
mappa e ticket di wayfinder vivono come file in `.scratch/<effort>/` nel
repo di lavoro del task (dentro il worktree del task, non nel repo di
`yano-orchestrator` stesso — vedi Revisione 22 in `docs/notes/development-notes.md`
per il dettaglio). Nessun CLI `gh`/`glab` richiesto.

## Aggiornare il pin in futuro

Questo NON è un mirror che si tiene aggiornato da solo. Per aggiornare
consapevolmente:

1. `git clone --depth 1 https://github.com/mattpocock/skills.git` in una
   directory scratch, annotare il nuovo commit hash.
2. Diff manuale tra il commit pinnato qui sopra e il nuovo HEAD per le 6
   directory elencate in questo file — leggere ogni `SKILL.md` prima di
   sovrascrivere, non fare un copy-paste alla cieca (stesse cautele del
   vendoring iniziale: nessuno script da eseguire alla cieca, verificare se
   sono comparse nuove dipendenze da altre skill del repo sorgente).
3. Aggiornare commit hash e data in questo file.
4. Rieseguire la suite di smoke test e il controllo di isolamento per-ruolo
   (vedi Revisione 22 in `docs/notes/development-notes.md`).
