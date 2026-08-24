# 84 — Role-definition agent con ricerca capability

Type: human
Kind: task

**What to build:** L'agente `role-definition` ricerca e motiva le capability necessarie prima di proporre un nuovo ruolo in `roles.yaml`.

**Blocked by:** 08, 77, 83

**Status:** resolved

- [ ] La proposta collega ogni capability a probe, versione, scope e prerequisito.
- [ ] CLI, MCP, skill e credenziali non verificabili sono esplicitamente bloccanti.
- [ ] La proposta resta sandboxata, auditata e separata dall'attivazione del ruolo.

## Answer

Il flusso governance accetta proposte `role` dall'agente `role-definition`,
persistendo documento, checksum e lista delle capability richieste. La lista
è parte della proposta e viene validata prima dell'eventuale approvazione;
capability non verificabili restano dichiarazioni non attive.
