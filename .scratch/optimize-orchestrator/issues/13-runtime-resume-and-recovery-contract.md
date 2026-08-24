Type: human
Kind: grilling
Status: resolved
Blocked by: 02, 03

## Question

Quale contratto implementativo deve collegare stato corrente, idempotency key, lease/fencing, retry bounded, sostituzione worker e resume? Definire record persistiti, atomicità, ownership, transizioni dopo crash e condizioni che impediscono doppie esecuzioni o scritture da worker scaduti.

## Answer

Lo stato corrente persistito è la fonte operativa del resume; eventi e checkpoint restano audit e diagnostica. Ogni transizione è atomica in SQLite insieme a nuovo stato, generation, lease/fencing token, idempotency key e intent dell'eventuale effetto esterno.

Il runtime usa un outbox/inbox persistente per evitare divergenze tra stato e messaggi: un effetto non consegnato viene ritentato con lo stesso messaggio e la stessa idempotency key.

Dopo un crash durante un'operazione in-flight, il resume rileva l'operazione incompleta e la ritenta; non la marca automaticamente come completata.

Sostituzione del worker, replanning o nuovo round incrementano `generation`. Ogni mutazione deve presentare generation e fencing token correnti; il runtime rifiuta le scritture di generazioni precedenti anche se il worker è ancora connesso.

## Comments

- Decisione HITL raccolta dall'utente il 2026-08-22.
