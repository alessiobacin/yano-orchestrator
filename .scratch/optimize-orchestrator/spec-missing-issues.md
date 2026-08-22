# Specifica dei gap residui di enforcement runtime deterministico

## Problem Statement

Il vertical slice Playbook esistente persiste binding, generazioni, evidenze,
hold, outbox, effetti e redazione. Restano però non specificati i confini
operativi necessari per completare l'enforcement: riallineamento tra Playbook,
plan e DAG; capability verificabili e durevoli; dispatcher degli effetti
esterni; approvazioni multi-utente; failure/recovery bounded; raccolta delle
evidenze finali; retention e benchmark; governance per nuovi agenti e Playbook.

Senza questi contratti il sistema può essere coerente nel singolo comando, ma
non dimostra in modo deterministico che il run corrente sia eseguibile,
recuperabile e finalizzabile.

## Solution

Completare la specifica e poi l'implementazione in otto aree ordinate:

1. **Reconciliation**: confronto persistito tra Playbook, plan e DAG, con
   diff, generazione, esito bounded e stati `blocked`/`needs_replan`.
2. **Capability cards**: probe tipizzati per CLI, skill, MCP e credenziali,
   con versione, fingerprint, scope, checksum, scadenza e stato persistito.
3. **Effect dispatcher**: leasing, fencing, retry, failure e dead-letter per
   gli effetti esterni; solo adapter allowlisted possono eseguire side effect.
4. **Approval/escalation**: principal, scadenza, escalation e resume idempotenti
   legati a run, checksum e generazione.
5. **Failure/recovery**: percorsi bounded, sostituzione worker sullo stesso
   ticket, budget di retry e replan senza duplicare il lavoro.
6. **Finalize evidence**: collector deterministico di test, stato workspace,
   commit e merge/push, con invalidazione dell'evidenza diventata stale.
7. **Retention/benchmark/migration**: policy esplicite, soglie riproducibili,
   migrazioni con preflight/postflight/rollback e diagnostica.
8. **Meta-governance**: agenti per proporre Playbook e ruoli, ricerca delle
   capability necessarie, sandbox, audit e attivazione immutabile approvata.

## User Stories

1. Come planner, voglio associare ogni stato Playbook a una fase e a un nodo
   plan/DAG, così il runtime sa quale lavoro è autorizzato.
2. Come runtime, voglio persistere la mappatura fase-ticket e la sua versione,
   così il riallineamento non dipende dal prompt corrente.
3. Come runtime, voglio rilevare conflitti tra Playbook, plan e DAG e fermarmi
   in `blocked` o `needs_replan`, senza inventare transizioni.
4. Come operatore, voglio consultare diff, cause, generazione e risultato
   dell'ultimo reconciliation.
5. Come sistema, voglio una capability card per ogni ruolo, istanza e run,
   così una capability globale non viene erroneamente riutilizzata.
6. Come sistema, voglio registrare probe, versione, scope, checksum, expiry e
   fingerprint dell'ambiente per ogni card.
7. Come orchestrator, voglio dispatchare solo capability card `verified` e
   compatibili con il checksum del run.
8. Come operatore, voglio remediation deterministica per probe falliti, con
   prerequisiti, messaggio manuale e rollback.
9. Come runtime, voglio un dispatcher che usi esclusivamente adapter esterni
   allowlisted e validi il payload prima del dispatch.
10. Come dispatcher, voglio lease e fencing token per impedire doppio dispatch
    durante retry o riavvio.
11. Come operatore, voglio tentativi, errori, retry e dead-letter persistiti e
    consultabili.
12. Come runtime, voglio portare il run a `blocked`/`needs_replan` quando un
    effetto esterno fallisce oltre il limite, senza perdere l'audit.
13. Come sistema, voglio vincolare ogni approval a principal, run, checksum e
    generazione.
14. Come sistema, voglio che approval scadute o cancellate impediscano il
    dispatch successivo.
15. Come operatore, voglio escalation e resume idempotenti, con audit del
    cambio di responsabile.
16. Come runtime, voglio un failure route con azione bounded e stato terminale
    esplicito, invece di retry illimitati.
17. Come planner, voglio sostituire un worker offline mantenendo lo stesso
    ticket e la stessa generazione logica.
18. Come runtime, voglio un budget per retry e replan, fenced per run e round.
19. Come sistema, voglio raccogliere automaticamente le evidenze finali
    tramite adapter eseguibili e allowlisted.
20. Come sistema, voglio legare l'evidenza a worktree e commit e invalidarla
    quando il contenuto osservato cambia.
21. Come operatore, voglio evidenze separate per test, commit, merge e push,
    senza dichiarare completato un passaggio non osservato.
22. Come amministratore, voglio retention distinta per eventi, evidenze,
    outbox e dead-letter, con conservazione degli audit richiesti.
23. Come maintainer, voglio benchmark riproducibili con soglie versionate per
    latenza, retry, recovery e crescita dello storage.
24. Come operatore, voglio migrazioni con preflight, postflight, diagnostica e
    rollback sicuro prima di toccare run attivi.
25. Come owner, voglio che l'agente autore di Playbook lavori in sandbox e
    produca solo proposte validate, mai attivazioni implicite.
26. Come owner, voglio che l'agente autore di ruoli ricerchi e motivi CLI, MCP,
    skill e capability richieste prima di proporre un ruolo.
27. Come amministratore, voglio attivare Playbook e ruoli solo tramite una
    pubblicazione immutabile con checksum e audit.
28. Come auditor, voglio verificare che Playbook, ruoli, skill, probe e adapter
    distribuiti appartengano allo stesso pacchetto controllato.

## Implementation Decisions

- Conservare SQLite, MQTT, CLI e fixture tarball come seam black-box esistenti.
- Usare come chiave canonica `(project, run_id, playbook_checksum, generation)`.
- Modellare capability in stati `declared`, `probing`, `verified`, `failed`,
  `expired` e `blocked`, con probe tipizzati e timeout bounded.
- Separare sempre decisione, outbox e dispatch: il runtime non esegue shell
  arbitraria né side effect direttamente.
- Aggiornare il ticket esistente per failure e replan; non creare duplicati.
- Rendere approval ed evidenze vincolate al contesto osservato e invalidabili.
- Versionare policy di retention, benchmark e migrazione.
- Tenere le proposte meta-operative in sandbox fino ad approvazione esplicita.

## Testing Decisions

Verificare con test black-box SQLite/MQTT/CLI/tarball: reconciliation coerente,
conflitti e race; cache capability, fingerprint, timeout, redaction e rollback;
lease, fencing, retry e dead-letter degli adapter; principal/generation/expiry
delle approval; sostituzione worker e budget bounded; evidenze stale su workspace
modificato; migrazioni, retention e benchmark; sandbox, audit, approvazione e
rollback delle proposte di nuovi Playbook e ruoli.

## Out of Scope

- Sostituire MQTT, SQLite, Pi, worktree o il comando `yano`.
- Decisioni autonome su approvazioni umane.
- Considerare prompt, ruolo o output LLM come evidenza runtime.
- Shell arbitraria, capability non allowlisted o side effect non attestati.
- Migrare silenziosamente run attivi durante un cambio di schema.

## Further Notes

L'ordine raccomandato è reconciliation, capability cards, dispatcher,
approval, recovery, finalize, retention/benchmark e meta-governance. La
specifica è incrementale: preserva il vertical slice già presente e definisce
i contratti mancanti prima di aggiungere nuovi adapter o nuovi ruoli.
