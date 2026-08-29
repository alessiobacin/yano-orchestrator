# Documentation synchronization policy

La documentazione di Yano è parte del contratto operativo del codice: un
comando, un flag, un percorso dati, un ruolo o un flusso non è completato finché
gli utenti e gli agenti non possono trovarne la descrizione aggiornata.

## Matrice obbligatoria

| Modifica | Superfici da verificare |
| --- | --- |
| CLI, sottocomando o flag | `bin/yano.mjs`, `README.md`, `docs/quick-start.md`, quick guide pertinente, `skills-vendor/yano/yano-cli/references/command-reference.md`, `skills-vendor/yano/yano-cli/SKILL.md` |
| Stato, routing, persistenza o data-root | `docs/architecture.md`, `docs/architecture.mmd`, diagramma operativo pertinente, quick guide pertinente |
| Agente, ruolo, playbook o capability | `agents/`, prompt, `docs/playbook-catalog.md`, documentazione dell'agente, skill CLI se il comando è usabile dagli agenti |
| Trace, database, indice o registro | `docs/yano-trace.md`, `docs/architecture.md`, diagramma trace pertinente, guide trace/Gantt |
| Installazione, harness o prerequisito | `README.md`, guida installazione, reference CLI, skill CLI, test/lint di installazione |

Quando una superficie non è applicabile, va verificato esplicitamente il
motivo nel report o nel commit. La documentazione globale descrive il
comportamento del pacchetto, le quick guide spiegano un'operazione concreta,
la skill insegna agli agenti come usare la CLI e i diagrammi descrivono
relazioni e flussi.

## Procedura per ogni modifica al codice

1. Cercare il comando, il flag, il ruolo o il percorso modificato con `rg`.
2. Aggiornare la superficie normativa (`README`, reference CLI e/o
   `architecture.md`).
3. Aggiornare il percorso operativo: quick start, quick guide e cheat-sheet.
4. Aggiornare `architecture.mmd` e il diagramma operativo se cambia un flusso
   o una relazione.
5. Eseguire il controllo deterministico e la suite:

   ```bash
   npm run check:docs
   npm test
   ```

Per una verifica locale che obblighi anche la presenza di modifiche documentali
quando ci sono file di codice non committati:

```bash
YANO_DOCS_ENFORCE_DIFF=1 npm run check:docs
```

Il controllo non genera testo automaticamente e non sostituisce il giudizio
del reviewer; fallisce invece quando mancano superfici fondamentali, quando il
contratto Gantt è disallineato o quando una modifica locale al codice non è
accompagnata da alcun aggiornamento documentale.

## Contratto Gantt corrente

Il Gantt è per progetto. Le porte automatiche sono nel range `10000-19999` e
la selezione usa uno slot stabile più il fallback su una porta libera. Il flag
`--persistent` registra il link nel data-root globale; `--link` recupera il
Gantt del progetto corrente e `--links` elenca tutte le registrazioni. Il
registro conserva anche un link fermo, ma il server resta un processo
foreground e il suo aggiornamento live vale finché il processo è in esecuzione.
