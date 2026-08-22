Type: grilling
Status: resolved

## Question

Qual è il contratto normativo del Playbook e quale autorità esercita sul planner e sul runtime? Definire schema/versionamento, stati canonici, eventi ammessi, guardie, invarianti, azioni idempotenti, transizioni invalide, override umano e comportamento quando planner, piano o persistenza propongono uno stato incompatibile.

## Answer

Il Playbook è la fonte normativa unica delle transizioni runtime. Il planner mantiene la responsabilità delle decisioni qualitative e propone piano, ticket e intenti; non può imporre direttamente una transizione non prevista dal Playbook.

Quando piano, DAG e stato Playbook divergono, il runtime tenta un riallineamento automatico e bounded secondo regole deterministiche. Se il riallineamento non è possibile entro i limiti definiti, il run viene portato in uno stato esplicito di blocco/replanning, mai lasciato attivo in modo ambiguo.

`human_approval` è obbligatoria soltanto per le transizioni che il Playbook dichiara come soggette ad approvazione. Merge, finalize o escalation non sono automaticamente tutti soggetti ad approvazione se il Playbook non li configura così.

Un Playbook incompatibile o di versione sconosciuta causa fail-fast del runtime e blocco del run; non è ammesso un fallback implicito a un altro contratto.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
