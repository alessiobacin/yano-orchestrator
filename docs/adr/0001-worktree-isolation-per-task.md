# ADR-0001: Worktree Git isolato per task

- **Stato**: accettata
- **Data**: 2026-09-02 (è la prassi operativa corrente; codificata come ADR durante la pulizia del repo, vedi `playbooks/clean-repo.usage.md` §4)
- **File di riferimento**: `prompts/planner.md`, `docs/architecture/architecture.md`, `docs/notes/development-notes.md` (Revisione 24), `prompts/docs-sync.md`, `prompts/specialist.md`

## Contesto

Ogni task orchestato deve modificare file, eseguire test e produrre report
senza rischiare lo stato degli altri task e senza sporcare la directory
principale del progetto. In un incidente reale documentato in
`docs/notes/development-notes.md` (Revisione 24) una feature era stata divisa su
**tre worktree separati** con merge caotico, perché sessioni planner diverse
non avevano memoria dei worktree aperti dagli altri. La lezione operativa è
diventata una regola strutturale.

## Decisione

Ogni task lavora **esclusivamente** in un worktree Git dedicato:

- Il planner crea/riusa il worktree con `worktree_create(slug)`: checkout
  isolato su branch `task/<slug>`, nidificato in `.worktrees/<slug>` dentro
  il progetto, con voce `.gitignore` auto-gestita che lo esclude dal
  `git status` della directory principale.
- Prima di creare uno slug il planner chiama `worktree_list_open`: se un
  worktree aperto sembra lo stesso task o una continuazione naturale, chiede
  all'utente se riusarlo invece di crearne un altro (regola `prompts/planner.md`:
  "Ogni task modifica esclusivamente un worktree git dedicato; il merge e il
  commit nella directory principale avvengono solo dopo il completamento
  positivo dell'intero ciclo").
- Tutti i file di lavoro, i test e il report del task (`reports/<slug>.md`)
  stanno nel worktree. Gli agenti vengono però **avviati dalla root del
  progetto, mai con `cd <worktree_path>`**: l'estensione rifiuta
  intenzionalmente una cwd dentro `.worktrees/` per evitare DB, report e
  scope MQTT annidati.
- Il merge nella directory principale avviene solo alla fine dell'intero
  ciclo con `worktree_finalize(slug)`, che richiede autodichiarazioni
  esplicite: `user_confirmed`, `e2e_tests_run` o motivo, `version_bumped` o
  motivo, `docs_synced` o motivo. Su conflitto il merge si interrompe pulito
  e il worktree resta per la risoluzione manuale — mai risolvere alla cieca.
- `worktree_abandon(slug, reason)` chiude un worktree senza merge solo quando
  il lavoro è già stato integrato diversamente (es. risoluzione manuale) e
  rifiuta se ci sono modifiche non committate.
- Il report del task vive nel worktree e viene esteso con `report_append`
  (append atomica, per non perdere le sezioni degli altri agenti che lavorano
  lo stesso worktree in parallelo); i file condivisi usano `file_claim`/
  `file_release`.

## Conseguenze

- La directory principale resta pulita durante tutto il task: niente file
  sparsi, niente stato git intermedio, niente merge parziali visibili.
- I conflitti di merge sono un evento esplicito e gestito, non un merge
  caotico; il fallimento di un task non contamina gli altri.
- Il costo è un passo infrastrutturale in più per il planner (create, riuso,
  finalize) e worktree che restano aperti finché il task non è concluso —
  da qui la necessità di `worktree_list_open` e della procedura di recovery
  che interroga trace, ticket e worktree per riprendere un task dopo uno
  stall del planner.