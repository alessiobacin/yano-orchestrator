# 83 — Playbook author in sandbox

Type: human
Kind: task

**What to build:** L'agente `playbook-author` produce proposte di Playbook validate in sandbox e non può attivarle direttamente.

**Blocked by:** 09, 76

**Status:** resolved

- [ ] La proposta include schema, capability, guardie, effetti, failure route e checksum.
- [ ] Validazione, preflight e review generano esiti auditati senza mutare run attivi.
- [ ] Attivazione e rollback richiedono un passaggio di approvazione esplicito.

## Answer

Implementato il flusso `governance_proposal_create` per proposte Playbook in
sandbox con checksum immutabile, seguito da `governance_proposal_validate`.
La proposta non modifica Playbook attivi né run esistenti; l'approvazione è un
passaggio separato riservato all'utente.
