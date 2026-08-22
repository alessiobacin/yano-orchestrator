Type: grilling
Status: resolved
Blocked by: 04, 12, 13

## Question

Qual è l'algoritmo bounded con cui il runtime riallinea stato Playbook, piano e DAG dopo crash, retry, replanning o messaggi duplicati? Definire precedenza delle evidenze, operazioni ammesse, generation fencing, condizioni di convergenza, conflitto non risolvibile e audit del risultato.

## Answer

La precedenza delle evidenze è: stato Playbook persistito → generation/fencing → ticket DAG persistito → piano del planner → messaggi MQTT ricevuti.

Il realignment automatico è limitato a operazioni deterministiche e non distruttive: deduplicare, ripristinare projection e riaprire ticket coerenti con una failure. Non può inventare ticket o modificare obiettivi qualitativi.

Dopo ogni tentativo vengono verificati invarianti Playbook, completezza fase-ticket e generation corrente. Tentativi e tempo sono bounded e l'operazione è idempotente; il superamento del limite porta a `blocked`/`needs_replan`.

Un conflitto non risolvibile lascia intatti i dati originali, registra un diff completo e notifica planner/utente. Messaggi con generation o fencing token obsoleti sono ignorati come eventi operativi ma conservati nell'audit.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
