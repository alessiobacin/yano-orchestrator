## Destination

Spec pubblicata in [spec.md](spec.md) tramite `to-spec`; i seam di test scelti sono CLI black-box, runtime extension con SQLite/MQTT e tarball installabile.

Una specifica tecnica pronta per l'implementazione di `yano-orchestrator` che renda affidabili e deterministici i run multi-agente: il Playbook governa le transizioni runtime, lo stato sopravvive a crash e riavvii, ogni failure ha recovery bounded o escalation, e il pacchetto distribuisce configurazione e capability verificabili. Il CLI pubblico globale è `yano`.

## Notes

Dominio: estensione Pi/Node.js per orchestrazione multi-agente su MQTT 5, con SQLite, DAG dei ticket e worktree condiviso per task.

Priorità: 1) affidabilità dopo crash/offline/non-risposta; 2) enforcement deterministico del Playbook; 3) performance; 4) packaging e rinomina completa.

Vincoli: mantenere il modello di worktree condiviso con `file_claim`/`file_release`; il planner conserva le decisioni qualitative, il runtime applica le transizioni; il comando pubblico è `yano`; la destinazione è una specifica, non l'implementazione.

Ogni decisione deve includere invarianti osservabili, stato persistito, comportamento in caso di errore e criteri di test. Consultare `docs/architecture.mmd`, `docs/development-notes.md`, `docs/agents/issue-tracker.md` e i prompt/ruoli pertinenti.

## Decisions so far

<!-- closed tickets only; open children are discovered from issues/ -->

- [Contratto e autorità del Playbook](issues/01-playbook-authority-contract.md) — il Playbook è normativo; il runtime riallinea automaticamente in modo bounded, blocca su incompatibilità e applica `human_approval` solo dove configurato.
- [Stato persistente, idempotenza e recovery](issues/02-durable-state-idempotent-recovery.md) — il resume parte dallo stato corrente; retry e deduplicazione riusano idempotency key persistite, mentre lease e fencing impediscono scritture da worker scaduti.
- [Failure semantics e recovery bounded](issues/03-bounded-failure-recovery.md) — failure class distinte, budget configurabili, sostituzione dei worker e replanning sul ticket esistente; budget esaurito significa `blocked`, escalation e stop dei dispatch.
- [Coerenza tra Playbook, piano e DAG](issues/04-single-source-plan-dag-playbook.md) — Playbook normativo, piano del planner e DAG operativo; validazione di completezza/univocità e gate di avanzamento solo con ticket approvati.
- [Gate strutturali tra planner, coder e reviewer](issues/05-structural-role-gates.md) — handoff code vincolati dal runtime, loop reviewer-coder bounded, specialisti consultivi e percorsi non-code tramite Playbook dedicati.
- [CLI `yano`: packaging e migrazione](issues/06-cli-yano-packaging-migration.md) — il nome ufficiale è `yano-orchestrator`, il solo binario è `yano`, senza alias `legacy-cli`, e la rinomina comprende riferimenti pubblici e interni.
- [Famiglia di Playbook non-code](issues/07-non-code-playbook-family.md) — il planner propone Playbook/versione, il runtime valida, il percorso base usa worker e validator dedicati e il fallback coder è esplicito; le versioni attive sono immutabili.
- [Ricerca delle capability per nuovi agenti](issues/08-research-agent-capabilities.md) — `roles.yaml` contiene dichiarazioni, non prove; servono probe bounded per skill, CLI, MCP e credenziali, con blocco delle capability non verificabili o dei secret hardcoded.
- [Governance degli agenti meta-operativi](issues/09-meta-agents-governance.md) — `playbook-author` e `role-definition` propongono in sandbox; validazione, preflight, review e human approval precedono attivazione, con rollback e immutabilità dei run esistenti.
- [Bootstrap deterministico di `yano init`](issues/11-yano-init-deterministic-preflight-bootstrap.md) — preflight ordinato e ripetuto, secret richiesti solo quando necessari, installazioni da manifest approvato e rollback diagnostico senza stato parziale.
- [Rimozione della credenziale MCP hardcoded](issues/10-remove-hardcoded-mcp-secret.md) — secret rimosso dalla configurazione e vecchia chiave ruotata/revocata; `yano init` deve usare un riferimento sicuro senza ristampare il valore.
- [Ricerca delle capability per nuovi agenti](issues/08-research-agent-capabilities.md) — le capability in `roles.yaml` sono dichiarazioni da provare; preflight e runtime devono verificare caricabilità, versione, scope, credenziali e permessi, rifiutando configurazioni nominali o insicure.
- [Contratto eseguibile del Playbook](issues/12-playbook-executable-contract.md) — schema completo validato fail-fast, realignment bounded, effetti esterni idempotenti, approvazioni persistite e versioni immutabili per i run attivi.
- [Contratto runtime di resume e recovery](issues/13-runtime-resume-and-recovery-contract.md) — stato corrente operativo, transizioni atomiche, outbox/inbox persistente, retry delle operazioni in-flight e fencing con generation/token correnti.
- [Control loop del watchdog](issues/14-supervisor-watchdog-control-loop.md) — supervisore deterministico con soglie configurabili, recovery operativo autonomo, sweep idempotenti e riattivazione del finalize senza inventare piani.
- [Evidenze obbligatorie per finalize](issues/15-finalize-evidence-contract.md) — test, version bump, docs-sync, approvazioni, report e worktree verificati realmente; mancanze bloccano merge/push, che restano distinti e idempotenti.
- [Modello runtime del capability preflight](issues/16-capability-preflight-runtime-model.md) — capability card con stati ed evidenze, cache invalidata dai cambi ambientali, composizione role/instance verificata e dispatch solo con capability `verified`.
- [Audit distribuzione pacchetto `yano`](issues/17-yano-package-distribution-audit.md) — audit fallito: il pacchetto espone ancora `legacy-cli`, si chiama `yano-orchestrator` e non distribuisce i Playbook sotto `.pi/`.
- [Loader e distribuzione Playbook](issues/18-playbook-loader-distribution-contract.md) — Playbook in percorso package esplicito, override locali dichiarati, checksum/origine obbligatori, immutabilità per run e nessun fallback implicito.
- [Correzione rename e asset package](issues/22-package-rename-and-assets-fix.md) — rename e tarball corretti: package/binario `yano`, Playbook inclusi, `yano init` verificato; resta un failure SQLite preesistente in `yano-status`.
- [Contratto `decision_holds`](issues/27-decision-holds-schema-contract.md) — hold qualitativi durevoli con stati/expiry, risposta autenticata e idempotente, migrazione obbligatoria e visibilità in `yano-status`.
- [Implementazione migrazione `decision_holds`](issues/28-implement-decision-holds-migration.md) — tabella, vincoli, indice e percorso `yano-status` implementati; smoke test verde con 7 asserzioni.
- [API runtime dei decision hold](issues/29-decision-hold-runtime-api.md) — lifecycle con tool separati, autorizzazioni, generation/idempotency, resume via outbox, replanning esplicito e audit idempotente.
- [Schema persistence/outbox](issues/19-persistence-schema-outbox-contract.md) — control-plane SQLite separato con WAL, vincoli di deduplicazione/lease, migrazioni fail-fast, retention esplicita e blocco su corruzione.
- [Collector evidenze finalize](issues/20-finalize-evidence-collector-contract.md) — adapter verificabili, evidenze legate al commit, invalidazione dopo modifiche, redaction obbligatoria e audit separato di merge/push.
- [Probe e installer capability](issues/21-capability-probe-installer-contract.md) — manifest/lockfile autorizzato, installazioni per tipo, probe bounded/redatte, handshake MCP, rollback e capability card con evidenze.
- [Contratto performance](issues/23-performance-acceptance-contract.md) — metriche complete, budget cold/warm, soglie hard configurabili, benchmark riproducibili e regressioni che bloccano release senza interrompere run attivi.
- [Interprete Playbook e runtime gate](issues/24-playbook-interpreter-runtime-gate.md) — guardie dichiarative, transizioni atomiche, effetti asincroni espliciti, rollback su errore e serializzazione per run senza bypass dei tool.
- [Reconciliation bounded tra piano e DAG](issues/25-bounded-plan-dag-reconciliation.md) — precedenza allo stato Playbook persistito, realignment non distruttivo e idempotente, conflitti conservati e messaggi obsoleti auditati ma ignorati.
- [Stato durevole di approval ed escalation](issues/26-durable-approval-escalation-state.md) — stati persistenti, approval legata a versione/generation/evidenze, resume autenticato, stop dispatch e deduplicazione dei conflitti.
- [Implementazione runtime dei decision hold](issues/30-implement-decision-hold-runtime-api.md) — tool lifecycle, generation/idempotency, audit, expiry watchdog e resume planner tramite outbox con `needs_replan`.
- [Riconciliazione startup](issues/31-implement-startup-reconciliation.md) — al riavvio del planner vengono persistiti findings deterministici su ticket dangling e hold aperti senza auto-mutazioni.
- [Control plane e project scoping](issues/32-control-plane-and-scoping-regressions.md) — `agent_control` allow-listed e test MQTT isolato da retained status preesistenti.
- [Smoke late-broker](issues/33-late-broker-smoke-prerequisite.md) — prerequisito `mosquitto` assente gestito come skip diagnostico, senza errori `spawn` non gestiti.
- [Wiring planner research flow](issues/34-planner-research-flow-wiring.md) — guida ricerca e chiusura `to-spec` → `to-tickets` esplicitamente collegate al prompt planner.
- [Final package surface audit](issues/35-final-package-surface-audit.md) — tarball installabile verificato con binario `yano`, Playbook distribuiti e nessun identificatore legacy pubblico.
- [Init preflight before writes](issues/36-init-preflight-before-writes.md) — `yano init` blocca prima dello scaffold su prerequisiti mancanti e lascia il target invariato.
- [Machine-readable preflight](issues/37-machine-readable-preflight.md) — `yano doctor --json` espone check strutturati per enforcement e installer deterministici.
- [Init preflight regression test](issues/38-init-preflight-regression-test.md) — smoke test automatizzato per failure senza scritture parziali.
- [MCP credential preflight](issues/39-mcp-credential-preflight.md) — chiavi richieste solo per MCP attivi, prompt interattivo o failure diagnostico senza scaffold parziale.
- [MCP credential regression test](issues/40-mcp-credential-regression-test.md) — verifica automatizzata di failure non interattivo senza scritture o mutazioni del placeholder.
- [Auto-start broker preflight](issues/41-auto-start-broker-preflight.md) — `yano init` avvia il compose MQTT ufficiale quando Docker è già disponibile e il broker è assente.
- [Post-preflight package verification](issues/42-post-preflight-package-verification.md) — tarball installabile verificato con doctor, init e smoke test preflight distribuiti.
- [Plan-ticket completion gate](issues/44-plan-ticket-completion-gate.md) — `plan_advance` richiede ticket persistenti `done` quando il piano è collegato a un run.
- [Implementazione gate strutturale degli handoff](issues/45-implement-structural-role-handoff-gate.md) — `agent_send` rifiuta gli shortcut del percorso code e consente solo il loop planner/coder/reviewer dichiarato.
- [Evidenze persistenti delle guardie Playbook](issues/46-persist-playbook-guard-evidence.md) — le transizioni consumano solo evidenze idempotenti persistite nel run, mai liste auto-dichiarate.
- [Migrazione additiva dello schema storage](issues/47-additive-storage-schema-migration.md) — i database v1 vengono portati a schema v2 in modo monotono e fail-fast su versioni non supportate.
- [Probe capability skill](issues/48-skill-capability-evidence-probe.md) — una skill soddisfa una guardia solo se `SKILL.md` è realmente risolvibile e leggibile.
- [Handshake capability MCP](issues/49-mcp-handshake-capability-evidence.md) — un MCP soddisfa una guardia solo dopo avvio bounded e risposta JSON-RPC `initialize` valida.
- [Probe capability credenziali](issues/50-credential-capability-evidence-probe.md) — una credenziale soddisfa una guardia solo se il `.env` contiene un valore non-placeholder, senza esporlo.
- [Actor Playbook vincolati all’identità](issues/51-identity-bound-playbook-actors.md) — gli actor delle transizioni vengono verificati contro il ruolo runtime e non sono auto-dichiarabili dal planner.
- [Projection evidence in run status](issues/52-run-status-playbook-evidence-projection.md) — le evidenze Playbook persistite sono visibili nella superficie di resume senza secret.
- [Audit evidence idempotente](issues/53-idempotent-playbook-evidence-audit.md) — i retry della stessa evidence non duplicano il record né l’evento audit.
- [Allowlist effect Playbook](issues/54-playbook-effect-kind-allowlist.md) — gli effect kind sconosciuti falliscono nel loader prima del binding runtime.
- [Contratto payload effect Playbook](issues/55-playbook-effect-payload-contract.md) — gli effect noti richiedono payload strutturalmente sufficienti prima del binding.
- [Runtime effect human approval](issues/56-human-approval-effect-runtime.md) — `human_approval` apre atomicamente un decision hold persistente e auditato.
- [Gate ack human approval](issues/57-approval-effect-ack-gate.md) — un effect approval si chiude solo dopo la risoluzione del hold associato.
- [Ack approval solo answered](issues/58-approval-ack-requires-answered.md) — cancellazione, expiry o blocco non vengono trattati come approvazione.
- [Autorizzazione adapter effetti esterni](issues/59-external-effect-adapter-authorization.md) — notification e MQTT richiedono `effect-adapter`; il planner non può falsificarne la consegna.
- [Sync enforcement default Playbook](issues/60-sync-default-playbook-enforcement-doc.md) — il default Playbook distingue le invarianti runtime già applicate dai gap ancora planner-owned.
- [Authorization before effect retry](issues/61-authorization-before-effect-retry.md) — il fast-path idempotente non può bypassare il ruolo richiesto dall’effect esterno.
- [Generation before effect retry](issues/62-generation-before-effect-retry.md) — il fast-path idempotente non può bypassare il fencing della generation.
- [Atomic transition update fencing](issues/63-atomic-transition-update-fencing.md) — una race senza state update fa rollback di effect, hold e audit.
- [Projection recovery Playbook completa](issues/64-run-status-playbook-recovery-projection.md) — `run_status` espone evidence, outbox effects e decision hold in un’unica lettura durevole.
- [Redaction projection Playbook](issues/65-redacted-playbook-recovery-projection.md) — context e payload sensibili vengono redatti in `run_status` senza alterare lo storage.
- [Redaction decision hold tools](issues/67-redact-decision-hold-tools.md) — `decision_hold_get/list` non possono bypassare la redazione della projection.
- [Redaction decision hold lifecycle](issues/68-redact-decision-hold-lifecycle.md) — create/answer/cancel non ristampano context o metadata sensibili.
- [Redaction cancel hold audit](issues/69-redact-hold-cancel-audit.md) — l’audit di cancellazione conserva solo la presenza della reason, non il testo libero.
- [Redaction Playbook effect tools](issues/70-redact-playbook-effect-tools.md) — list/ack degli effect non possono bypassare la redazione di `run_status`.
- [Redaction Playbook binding](issues/71-redact-playbook-binding-projection.md) — snapshot e payload del binding sono redatti nelle risposte senza alterare lo storage immutabile.
- [Redaction Playbook transition response](issues/72-redact-playbook-transition-response.md) — la risposta transition non espone payload effect sensibili.
- [Redaction Playbook evidence](issues/73-redact-playbook-evidence-projection.md) — record/list/status delle evidence condividono una projection redatta e un testo breve.
- [Spec dei gap runtime residui](issues/74-spec-missing-runtime-issues.md) — specifica pubblicata per le issue mancanti: reconciliation, capability cards, dispatcher, approval, recovery, finalize, retention/benchmark e governance.
- [Implementazione loader/interprete Playbook](issues/43-implement-playbook-loader-interpreter.md) — loader fail-fast, binding immutabile, transizioni atomiche, guardie evidence-backed, outbox ed effect ack con fencing verificati dagli smoke test.
- [Dispatcher effetti Playbook](issues/75-playbook-effect-dispatch-lease-retry.md) — delivery state persistito, lease/token fencing, retry bounded e dead-letter adapter-only.
- [Reconciliation completo Playbook–plan–DAG](issues/76-reconcile-playbook-plan-dag.md) — ticket verticale per mapping, diff e conflitti persistiti.
- [Capability cards durevoli](issues/77-capability-cards-durable.md) — ticket verticale per capability versionate, scoped e invalidabili.
- [Failure effetti e dead-letter runtime](issues/78-effect-failure-run-state.md) — ticket verticale per integrare failure bounded con lo stato del run.
- [Approval multi-principal ed escalation](issues/79-approval-escalation-multiprincipal.md) — ticket verticale per approval vincolate e resume auditato.
- [Recovery worker e budget replan](issues/80-worker-recovery-replan-budget.md) — ticket verticale per sostituzione worker e retry bounded.
- [Finalize evidence collector](issues/81-finalize-evidence-collector.md) — ticket verticale per evidenze finali separate e stale-aware.
- [Retention, benchmark e migrazioni](issues/82-retention-benchmark-migration-ops.md) — ticket verticale per policy operative e diagnostica.
- [Playbook author sandbox](issues/83-playbook-author-sandbox.md) — ticket verticale per proposte Playbook validate e non attivabili implicitamente.
- [Role-definition capability research](issues/84-role-definition-capability-research.md) — ticket verticale per la ricerca delle capability dei nuovi ruoli.
- [Provenienza e pubblicazione pacchetto](issues/85-package-provenance-activation.md) — ticket verticale per manifest, checksum, audit e attivazione atomica.
- [Audit actor effect ack](issues/66-effect-ack-actor-audit.md) — l’audit registra il ruolo runtime che conferma l’effect senza duplicare retry o secret.

## Not yet specified

- I dettagli implementativi del loader, del manifest asset, del registro versioni e dell'interprete delle transizioni.
- I dettagli implementativi di schema SQLite, vincoli, migrazioni, retention, outbox/inbox e commit atomici.
- I dettagli implementativi degli adapter progetto, del formato evidence e dell'esecuzione redatta dei comandi.
- I dettagli implementativi di registry/lockfile, installer per tipo, probe, rollback e cache delle capability.
- La correzione del failure SQLite `decision_holds` rilevato dal test `yano-status` e la nuova suite di integrazione persistence.
- L'integrazione completa di approval/escalation con il dispatcher Playbook e le policy di autorizzazione multi-utente.
- I dettagli implementativi dei benchmark, dataset/scenari, metriche persistite e soglie per ambiente.
- I dettagli implementativi del linguaggio dichiarativo delle guardie, dell'interprete e del dispatcher degli effetti.
- I dettagli implementativi dell'algoritmo di reconciliation, delle projection e del diff di conflitto.
- I dettagli implementativi di schema approval/escalation, autorizzazione resume e policy di rientro da `blocked`.

## Out of scope

- Rendere il sistema matematicamente infallibile o eliminare ogni intervento umano.
- Sostituire MQTT, SQLite o il modello di worktree condiviso con un'altra piattaforma.
- Implementare ora le modifiche: questa mappa produce la specifica tecnica e le decisioni necessarie all'implementazione.
