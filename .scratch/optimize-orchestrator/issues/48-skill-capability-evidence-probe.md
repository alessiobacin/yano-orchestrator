Type: task
Status: resolved
Blocked by: 08, 16, 21, 46

## Question

Verificare che una skill dichiarata sia realmente caricabile prima di usarla come guardia Playbook.

## Acceptance Criteria

- La sorgente `capability:skill:<name>:loadable` risolve solo percorsi skill dichiarati nel progetto o nei roots Codex/Agents.
- `SKILL.md` deve esistere ed essere leggibile con contenuto non vuoto.
- La probe è fail-closed e non accetta nomi nominali da `roles.yaml`.
- L’evidenza risultante è persistita e idempotente nel run.

## Resolution

Implementata la probe bounded di caricabilità skill nel producer `playbook_evidence_record`, usando il `cwd` dell’istanza e root progetto/Codex/Agents. Smoke ticket engine aggiunto con fixture positiva e skill inesistente: 69 assertion verdi.
