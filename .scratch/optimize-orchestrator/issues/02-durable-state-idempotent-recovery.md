Type: human
Kind: grilling
Status: resolved

## Question

Come devono essere persistiti e ripresi run, fase, ticket, assegnazione, worktree, messaggi e generazione/idempotency key dopo crash o riavvio? Definire checkpoint, lease/fencing, deduplicazione, ordine degli eventi, stato ambiguo e procedura di resume sicura senza doppia esecuzione o perdita di lavoro.

## Answer

Il resume usa lo stato corrente persistito come fonte per la ripresa; non richiede il replay di una event history per ricostruire lo stato. Gli eventi e i checkpoint eventualmente esistenti restano utili per audit e diagnostica, ma non sono la fonte normativa del resume.

Ogni operazione runtime deve avere una idempotency key stabile e persistita, con scope almeno per run, ticket, worktree, handoff MQTT e transizione Playbook. Un retry riusa la stessa chiave, così un’operazione ripetuta dopo crash non produce un secondo effetto logico.

Le assegnazioni dei worker usano lease e fencing token. Dopo scadenza o sostituzione, il worker precedente non può più modificare ticket, stato del run o transizioni, anche se torna online.

Un’azione esterna rimasta ambigua dopo un crash viene ritentata con la stessa idempotency key. Il retry deve comunque essere bounded e, dopo il limite previsto dal contratto di failure/recovery, produrre una transizione esplicita di errore o escalation.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
