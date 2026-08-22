Type: task
Status: resolved
Blocked by: 10, 11, 16, 46

## Question

Verificare la presenza effettiva delle credenziali necessarie senza esporre o persistere il loro valore.

## Acceptance Criteria

- La sorgente `capability:credential:<name>:present` legge solo il `.env` del progetto.
- Valori vuoti e placeholder sono rifiutati.
- Il valore segreto non compare in audit, output o evidence payload.
- L’evidenza è idempotente e consumabile dalle guardie Playbook.
- Il test copre valore valido e placeholder.

## Resolution

Implementata la probe credential nel producer Playbook: verifica formato del nome, file `.env`, valore non vuoto e rifiuto di placeholder (`<...>`, `YOUR_`, `REPLACE_`, `CHANGEME`). Il secret non viene restituito né registrato. Smoke ticket engine esteso con casi positivo/negativo.
