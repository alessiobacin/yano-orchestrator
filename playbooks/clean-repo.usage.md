# `clean-repo` — come si attiva

Playbook globale bundlato (`playbooks/clean-repo.yaml`, ruolo dedicato
`repo-curator` in `agents/roles.yaml`, `activation: lazy` come gli altri
specialisti a valle di Architect, e riuso del ruolo esistente `docs-sync`
esattamente come `reviewer` è già riusato da `backend-change`, `refactor`
e `qa-hardening`). Non richiede l'iter di provisioning di Architect: è
disponibile subito in ogni progetto che gira su questa versione di
`yano-orchestrator`, esattamente come `refactor` o `debate`.

## 1. Perché esiste

Prima di questo playbook non esisteva un posto dedicato per una richiesta
del tipo "pulisci questa repo", "sposta questi file dove dovrebbero
stare" o "controlla se la documentazione è completa". Una richiesta così
non è un refactoring (non tocca comportamento di codice), non è un task
di `documentation-release` puro (non si limita a scrivere doc, tocca
anche file da rimuovere o spostare) e non è nemmeno un `qa-full-audit`
(non verifica funzionalità, verifica la struttura del repository). Senza
un playbook dedicato, `candidateForTask()` avrebbe instradato una
richiesta simile in modo imprevedibile — dentro `documentation-release`
se la frase conteneva la sottostringa "document", dentro `refactor` se
conteneva "cleanup", o nel fallback generico `backend-change` — e
soprattutto **senza nessun gate esplicito di conferma umana prima di
cancellare o spostare qualunque file**, perché nessuno di quei playbook è
pensato per un'azione distruttiva come rimozione/spostamento di file.

`clean-repo` è ora un playbook di catalogo a sé stante con un contratto
costruito attorno a un solo principio non negoziabile: **repo-curator non
cancella e non sposta mai nulla di propria iniziativa**. Costruisce un
elenco puntuale di candidati alla rimozione e alla rilocazione, ciascuno
con una motivazione concreta e — prima ancora di proporlo — la scansione
di ogni riferimento (import, link di documentazione, path in config/CI)
che punterebbe a quel file, per sapere in anticipo cosa si romperebbe. Lo
stato `awaiting_change_plan_confirmation` è un gate esplicito, non un
promemoria nel `brief` del ruolo: **copre un'unica relazione di modifiche
unificata**, non solo la rimozione/rilocazione ma anche il piano
documentale (sezione 4) — nessuna transizione verso `applying_cleanup` è
possibile senza `user_approved_or_edited_removal_and_relocation_list` **e**
`user_approved_documentation_plan` insieme, e l'utente può approvare
tutto, un sottoinsieme o niente per la parte di cleanup. Anche quando
rifiuta tutta la rimozione/rilocazione, la creazione dei file
documentali resta comunque condizionata alla sua approvazione esplicita
del piano documentale — non è mai data per scontata solo perché il
cleanup è stato rifiutato o approvato. Vedi l'invariante
`change_plan_proposed_and_confirmed_before_any_modification` in
`playbooks/clean-repo.yaml`.

Il secondo motivo per cui esiste è l'audit di completezza documentale:
`clean-repo` verifica il repository contro un set canonico di categorie
documentali (sezione 4) e fa scrivere a `docs-sync` — riusando lo stesso
ruolo che già chiude ogni `documentation-release` — i file mancanti con
contenuto reale tratto dal repository appena auditato, mai uno stub
segnaposto con dei TODO (`missing_docs_are_real_not_placeholders`).

## 2. Richiesta in linguaggio naturale al planner

L'attivazione non è un comando CLI diretto: è un messaggio al planner, che
la instrada da solo tramite la stessa valutazione del catalogo usata per
ogni altro task (vedi `prompts/planner.md`, sezione "Scoping" e "Catalogo
playbook e team dinamici").

```text
Pulisci la repo dai file che non servono più e crea la documentazione mancante
```

```bash
yano architect assess --project-root "$PWD" \
  --task "Pulisci la repo dai file che non servono più e crea la documentazione mancante" \
  --json
```

Output reale (verificato in questa sessione, con un progetto di prova
vuoto):

```json
{
  "candidate_playbook": "clean-repo",
  "candidate_reason": "repository cleanup/reorganization/documentation-completeness intent",
  "roles": ["repo-curator", "docs-sync", "reviewer"],
  "capabilities": {
    "skills": [
      "code-review",
      "documentation-lookup",
      "documentation-review",
      "yano-cli",
      "yano-code-review",
      "yano-planner-trace-analysis"
    ],
    "cli": ["git", "npm", "npx"],
    "mcp": ["github"]
  },
  "catalog": {
    "action": "reuse",
    "exact_match": { "id": "clean-repo" },
    "selection_required": false
  },
  "playbook_selection": { "user_choice_required": false },
  "needs_new_playbook": false,
  "requires_user_interview": false
}
```

Nota sulla formulazione e sulle due collisioni a cui la posizione della
regex nel cascade di `candidateForTask()` fa attenzione:

1. La regex di `documentation-release` matcha sulla sottostringa nuda
   `document`. Una frase realistica come "documentazione mancante" o
   "missing documentation" contiene quella sottostringa — per questo il
   ramo `clean-repo` è inserito **prima** di `documentation-release` nel
   cascade (subito dopo `knowledge-authoring`), altrimenti frasi così
   verrebbero inghiottite da `documentation-release` e non
   raggiungerebbero mai `clean-repo`.
2. La regex di `refactor` include il token letterale `cleanup` (senza
   spazio). La regex di `clean-repo` usa solo `clean up` (due parole, con
   uno spazio) più `riorganizza`/`pulisci`/etc — nessuna sottostringa
   letterale in comune, quindi nessuna collisione reale in nessuna delle
   due direzioni. Verificato leggendo entrambe le regex carattere per
   carattere e poi confermato con la CLI reale.

Nessuna delle due collisioni si è materializzata: sia le formulazioni di
`clean-repo` sia quelle preesistenti di `documentation-release` e
`refactor` instradano esattamente dove ci si aspetta (vedi
`scripts/smoke-test-yano-clean-repo-playbook.mjs` per la verifica
completa contro la CLI reale, incluse le non-regressioni). Nessuna delle
frasi proposte in origine per questo playbook ha richiesto una
riformulazione.

## 3. Cosa fa il planner sotto al cofano

1. **Scoping (`received` → `preflight`)** — il planner conferma con
   l'utente il perimetro della pulizia (`cleanup_scope_confirmed`) prima
   di aprire il worktree isolato.
2. **Audit (`preflight` → `auditing`)** — `repo-curator` costruisce, senza
   toccare nulla, tre cose in parallelo: l'elenco dei candidati alla
   rimozione (ciascuno con una motivazione concreta: non referenziato da
   nessuna parte, artefatto generato committato per errore, superato da
   un altro file, ecc.), l'elenco dei file da spostare con il percorso di
   destinazione proposto, e la scansione dei riferimenti a ogni candidato
   **prima** di proporlo, per sapere in anticipo cosa si romperebbe
   (`dangling_reference_scan_completed_before_proposal`). In parallelo
   audita anche la completezza documentale contro le categorie canoniche
   (sezione 4) e verifica se il progetto ha un backend, per sapere se la
   categoria `postman/` si applica o va dichiarata esplicitamente non
   applicabile (`backend_detected_for_postman_requirement_or_explicitly_
   not_applicable`).
3. **Gate di conferma (`auditing` → `awaiting_change_plan_confirmation`)**
   — il planner presenta all'utente **una relazione di modifiche unica**:
   l'elenco puntuale di rimozione/rilocazione, completo di motivazione
   per riga e di destinazione per ogni spostamento, **insieme** al piano
   documentale (quali file mancanti nelle categorie canoniche verranno
   creati, quali esistenti verranno aggiornati). Questo è il cuore del
   playbook: **nessuna cancellazione, spostamento, creazione o
   aggiornamento di file avviene prima di questo punto**. La decisione
   dell'utente sulla parte di cleanup può essere "tutto", "solo alcune
   voci" o "niente" — il silenzio non vale mai come approvazione — e la
   parte documentale richiede comunque la sua approvazione esplicita
   (`user_approved_documentation_plan`) prima che `docs-sync` scriva
   qualunque cosa.
   - Se l'utente approva il cleanup (in tutto o in parte) e il piano
     documentale → `applying_cleanup` (`confirm_change_plan`).
   - Se l'utente rifiuta tutte le voci di cleanup ma approva il piano
     documentale → si salta direttamente a `documenting`
     (`skip_cleanup_confirm_documentation_only`): l'audit documentale
     procede, solo la fase di rimozione/spostamento viene saltata.
   - Se l'utente chiede di rivedere il piano documentale invece di
     approvarlo, il planner lo ripresenta rivisto invece di procedere
     (failure route `user_requests_documentation_plan_revision`).
4. **Applicazione (`applying_cleanup` → `documenting`)** — `repo-curator`
   esegue **solo** le voci esplicitamente approvate
   (`only_approved_items_executed`, `no_unapproved_deletion_or_move`) e
   ripete la scansione dei riferimenti **dopo** l'esecuzione
   (`post_cleanup_reference_scan_clean_or_fixed`): un riferimento
   scoperto rotto solo ora viene sistemato o la singola modifica viene
   ripristinata, mai lasciato penzolante e mai scoperto solo
   dall'utente in un secondo momento.
5. **Documentazione (`documenting` → `review`)** — `docs-sync` (lo stesso
   ruolo, riusato tale e quale, che chiude ogni `documentation-release`)
   crea i file mancanti nelle categorie canoniche con contenuto reale
   tratto dal repository appena auditato, e riconcilia quelli esistenti
   con lo stato corrente del repository.
6. **Review (`review`) e completamento** — il reviewer approva solo con
   evidenza concreta; il report di chiusura porta un resoconto completo:
   cosa è stato rimosso, cosa è stato spostato (percorso vecchio →
   percorso nuovo), quali file di documentazione sono stati creati o
   aggiornati, e quali voci proposte l'utente ha rifiutato — mai un
   generico "pulizia completata"
   (`cleanup_and_documentation_summary_in_final_report`).

## 4. Le otto categorie documentali canoniche

L'audit di completezza documentale controlla la presenza di queste otto
categorie:

| Categoria | Contenuto |
|---|---|
| `architecture/` | documenti di architettura |
| `guides/` | guide di sviluppo |
| `quick-guides/` | guide rapide con flussi/esempi completi di comandi e opzioni per l'utente |
| `adr/` | Architecture Decision Records |
| `notes/` | note tecniche e di lavoro |
| `postman/` | collezione Postman — solo se il progetto ha un backend; altrimenti dichiarata esplicitamente non applicabile, mai saltata in silenzio |
| `cheat-sheet` | elenco comandi |
| `diagram` | diagramma mermaid del flusso logico |

L'invariante `canonical_documentation_categories` impone una regola
precisa prima di proporre una nuova directory per una di queste categorie:
riconoscere una directory equivalente che il progetto usa già, sotto un
nome o una posizione diversa, ed evitare di creare un doppione parallelo.

Ogni categoria realmente mancante deve diventare un deliverable, non solo una
voce nel piano: `docs-sync` crea la directory secondo la convenzione del
progetto e almeno un file reale dentro di essa. Markdown per architettura,
guide, quick guide, ADR, note e cheat-sheet; Mermaid per il diagramma;
collection JSON importabile per Postman quando è presente un backend.
Directory vuote, stub, TODO o esempi inventati non soddisfano il playbook.
L'inventario finale deve elencare tutte le categorie, i percorsi usati/creati
e la decisione esplicita su Postman.

**yano-orchestrator stesso è un esempio dal vivo di questa regola**,
verificato eseguendo `ls docs/` e `ls .` nella root del repository come
parte della stesura di questa sezione:

- `docs/quick_guides` (con l'underscore, non il trattino) copre già
  `quick-guides/`.
- `docs/cheat-sheet` copre già `cheat-sheet`.
- `docs/diagram` (da dicembre 2026; prima `docs/diagramma`) contiene i diagrammi
  Mermaid operativi (`.mmd`, es. `05-trace-db-gantt.mmd`) e copre direttamente
  la categoria canonica `diagram`.
- `docs/postman/` (da dicembre 2026; prima `postman/` in root) contiene
  `yano-debugger.postman_collection.json` e `yano-debugger.postman_environment.json`
  e copre direttamente `postman/` — e yano-orchestrator ha effettivamente un
  backend/CLI, quindi la categoria si applica.
- `docs/architecture.md` + `docs/architecture.mmd` coprono già
  `architecture/`, come file invece che come directory dedicata.
- `docs/development-notes.md` è un candidato ragionevole a coprire
  `notes/` (è già un log di note tecniche/di lavoro per revisione).

Applicando `clean-repo` a yano-orchestrator stesso, l'audit dovrebbe
riconoscere tutte queste equivalenze e **non** proporre `docs/architecture/`,
`docs/quick-guides/` (con il trattino), `docs/cheat-sheet-new/` o simili
come nuove directory duplicate. Al momento della stesura di questa
sezione non è emersa nel repository una directory o un file equivalente
per `guides/` o per `adr/`: un audit reale probabilmente le segnalerebbe
come gap genuini, non come falsi positivi da silenziare.

## 5. Cosa NON aspettarti da questo playbook

- Nessuna cancellazione o spostamento di file senza un elenco puntuale
  approvato esplicitamente dall'utente — mai "ho ripulito quello che mi
  sembrava inutile" come azione autonoma di `repo-curator`.
- Nessun file di documentazione creato come stub segnaposto con dei TODO:
  ogni file che `docs-sync` crea per colmare un gap riflette il
  repository reale — comandi reali, endpoint reali, un diagramma mermaid
  del flusso reale (`missing_docs_are_real_not_placeholders`).
- Nessuno skip silenzioso del requisito Postman per un progetto con
  backend: se il backend è rilevato, la collezione Postman deve essere
  presente o la sua assenza deve essere dichiarata esplicitamente, mai
  semplicemente omessa dal report.
- Nessuna directory duplicata per una categoria documentale che il
  progetto copre già sotto un nome diverso (vedi sezione 4) — l'audit
  riconosce l'equivalente esistente prima di proporne uno nuovo.
- Nessuna rimozione "silenziosa" nemmeno delle voci approvate: dopo
  l'esecuzione, la scansione dei riferimenti viene ripetuta e ogni
  riferimento rimasto rotto viene sistemato o la singola modifica viene
  ripristinata, mai lasciato così.

## 6. Verifica diretta del playbook

```bash
yano playbook show clean-repo --json
```

Restituisce `id: clean-repo`, `catalog.scope: global`, `catalog.reusable:
true` — lo stesso schema di ogni altro playbook del catalogo, verificato
da `node scripts/lint-playbooks.mjs` (19/19 file validati in questa
sessione, `clean-repo.yaml` incluso).
