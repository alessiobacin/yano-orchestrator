# Coherence audit — default-orchestration

Data: 2026-08-22

## Risolto in questa iterazione

- `prompts/planner.md` descriveva `run_create({slug,title})` e `spec_create({run_id,title,description})`, ma i tool reali accettano rispettivamente `objective`/`domain` e `run_id`/`title`/`content`. Il prompt ora usa le firme reali e conserva lo slug nel report/piano.

## Buchi che possono interrompere il flusso

### 1. Il Playbook non è ancora caricato dal runtime

`plan_set`/`plan_advance`/`agent_send` applicano solo il vecchio gate di fase. Il file YAML è quindi il contratto dichiarativo iniziale, non ancora una macchina a stati eseguibile.

### 2. Piano e DAG possono divergere

Il runtime non verifica che ogni fase di `plan_set` abbia esattamente i ticket corrispondenti, né che tutti i ticket della fase siano `done` prima di `plan_advance`. Il planner può avanzare una fase con ticket mancanti o ancora `running`.

### 3. Il ciclo coder↔reviewer non è imposto dal tool

Il prompt lo richiede, ma `agent_send` non verifica che un task con codice sia passato da coder a reviewer prima della valutazione del planner. Un agente potrebbe dichiarare completato il lavoro saltando il reviewer.

### 4. I task non-code restano ungated

La scelta è coerente con la validazione attuale di `plan_set`, ma il runtime non possiede ancora il flusso alternativo dichiarato dal Playbook: worktree/report → delega → verifica → conferma → finalize.

### 5. Preflight e approvazione durevole non esistono ancora

Gli assunti in `.scratch/optimize-orchestrator/spec.md` prevedono `yano deps`/capability probe e `human_approval`, ma non risultano ancora tool o transizioni runtime equivalenti. Il Playbook li tratta come gate obbligatori solo quando applicabili.

### 6. Un ticket fallito non ha una transizione automatica di replanning

`ticket_complete(status: failed)` lascia i dipendenti bloccati. Questo è sicuro, ma senza un comando/guardia di replanning il run può restare attivo indefinitamente finché il planner non crea manualmente un ticket sostitutivo.

### 7. Finalize verifica autodichiarazioni, non evidenze

`worktree_finalize` richiede i quattro flag della checklist, ma non verifica autonomamente test, version bump o docs-sync. Un prompt errato può quindi dichiarare un passaggio mai eseguito.

### 8. Run e worktree non sono legati a livello di storage

`run_create` non riceve lo slug del worktree; il collegamento resta una convenzione del planner/report. Dopo un riavvio è possibile avere più run candidati per lo stesso task se il report non viene recuperato.

## Ordine suggerito per la prossima iterazione

1. Loader + validatore del Playbook, con stato persistito per `slug`.
2. Gate atomico piano↔ticket: `plan_advance` richiede i ticket della fase `done` e il ticket layer registra il phase id.
3. Gate coder↔reviewer e prova di revisione nel report/event log.
4. Collegamento persistente run↔slug/worktree e resume deterministico.
5. Stato `failed` → replanning esplicito, con nuovo ticket e dipendenze aggiornate.
6. Preflight/human approval e verifica delle evidenze di finalize.
