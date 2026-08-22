Type: task
Status: resolved
Blocked by: 15, 20, 59

## Question

Rendere osservabile quale ruolo runtime ha confermato un effect Playbook.

## Acceptance Criteria

- L’evento `playbook_effect_acknowledged` include `actor_role`.
- Il retry idempotente non crea un secondo evento.
- Nessun payload effect sensibile viene copiato nell’audit.

## Resolution

L’ack passa `identity.role` allo storage e l’audit registra solo `actor_role`, effect id, generation e idempotency key. Smoke test verifica l’actor `effect-adapter`.
