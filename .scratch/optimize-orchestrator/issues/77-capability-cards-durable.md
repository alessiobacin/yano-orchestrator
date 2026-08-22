# 77 — Capability cards durevoli e versionate

**What to build:** Il runtime conserva una capability card verificata per ruolo, istanza e run e la invalida quando cambia l'ambiente osservato.

**Blocked by:** 08, 16, 21

**Status:** resolved

- [ ] La card registra stato, probe, versione, scope, checksum, fingerprint ed expiry.
- [ ] Il dispatch accetta solo card `verified` compatibili con il binding immutabile del run.
- [ ] Probe falliti, scaduti o invalidati sono redatti, auditati e non soddisfano guardie.

## Answer

Implementate le capability card SQLite per run, ruolo e istanza, con scope,
fingerprint, checksum del Playbook, expiry, stato e ultimo errore. Il tool
`capability_card_verify` riusa i probe bounded già esistenti e salva solo card
`verified` dopo evidenza valida; i fallimenti persistono come `failed`. Sono
disponibili lista, invalidazione a `blocked` e projection redatta in
`run_status`.

Smoke ticket engine verde con 94 assertion: scope ruolo/istanza, checksum,
fallimento probe e invalidazione verificati.
