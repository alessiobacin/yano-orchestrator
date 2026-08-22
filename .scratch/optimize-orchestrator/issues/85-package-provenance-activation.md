# 85 — Provenienza e pubblicazione atomica del pacchetto

**What to build:** Playbook, ruoli, skill, probe e adapter vengono attivati solo se appartengono allo stesso pacchetto controllato e immutabile.

**Blocked by:** 18, 22, 35, 83, 84

**Status:** resolved

- [ ] Il pacchetto espone manifest, checksum e provenienza per tutti gli asset runtime.
- [ ] Audit e preflight rifiutano asset mancanti, divergenti o non allowlisted.
- [ ] Pubblicazione e rollback sono atomici e non alterano run già attivi.

## Answer

Implementato `package_manifest_audit`: verifica nome `yano-orchestrator`,
binario pubblico `yano` e inclusione degli asset Playbook, quindi persiste
checksum, finding e risultato dell'audit. Le proposte governance sono
immutabili per checksum e l'approvazione non muta run attivi.

Smoke ticket engine verde con 107 assertion.
