# ADR-0004: La riscrittura del watcher/supervisore mantiene SQLite, MQTT e Herdr

- **Stato**: accettata
- **Data**: 2026-09-09
- **File di riferimento**: `scripts/watch-stalls.mjs`, `scripts/yano-watcher-registry.mjs`,
  `extensions/orchestrator.ts` (`watchdogSweep()`), `scripts/watcher/*.mjs`,
  `scripts/yano-herdr-client.mjs`, `.pi/extensions/yano-orchestrator/orchestratorStorage/orchestrator.db`,
  `watcher-registry.sqlite`

## Contesto

La Fase 1 della riscrittura di IANO ("da zero", non refactor incrementale) ha
riguardato il sotto-sistema watcher/supervisore — il processo più "caldo"
(gira ogni minuto via cron) e meno stabile del progetto: 53 ticket
auto-generati sui propri bug interni negli ultimi 12 giorni, 52 ancora
aperti, una duplicazione reale della logica "ticket stallato" tra il
watchdog in-process e il processo standalone, un doppio publish MQTT dello
stesso evento `ticket_stalled` da entrambi i watcher.

Prima di iniziare, le fondamenta tecnologiche (MQTT, SQLite, Herdr, Pi
extension API) erano state esplicitamente messe in discussione — nessuna
era off-limits per la rivalutazione. È stato inoltre confermato come vincolo
non negoziabile: la compatibilità con i dati esistenti sul disco
dell'utente (`orchestrator.db`, `watcher-registry.sqlite`) e con la
superficie CLI `yano watch` / `yano watcher *`, senza migrazione forzata né
reinizializzazione.

## Decisione

**Si confermano tutte e tre le fondamenta per la Fase 1: SQLite, MQTT, Herdr.**
Nessuna sostituzione tecnologica è stata introdotta in questa fase.

- **SQLite (`node:sqlite`, built-in Node)**: `watcher-registry.sqlite` (tabella
  `watcher_projects`) e `orchestrator.db` sono file reali sul disco
  dell'utente, letti da un cron che gira ogni minuto. Qualunque sostituzione
  di storage avrebbe richiesto una migrazione non richiesta dall'utente,
  violando direttamente il vincolo di compatibilità. `node:sqlite` è built-in
  Node — zero rischio di installazione aggiuntiva — quindi non c'è un caso
  sul piano velocità/costo per sostituirlo.
- **MQTT**: usato da consumer esterni allo scope della Fase 1 (altri tool
  dei 65 registrati in `extensions/orchestrator.ts`, oltre al watcher).
  Sostituirlo avrebbe richiesto ricablare quei consumer senza alcun
  beneficio misurabile per il problema effettivamente diagnosticato.
- **Herdr (`scripts/yano-herdr-client.mjs`)**: client condiviso con
  retry/backoff, già identico tra `watch-stalls.mjs`,
  `yano-watcher-registry.mjs` e `yano-repair.mjs`, riusato così com'è nella
  riscrittura (nessuna riscrittura necessaria — dipendenza già pulita).

Dove serviva davvero intervento non era la tecnologia ma **l'uso**:

- Uno spawn di sottoprocesso Node completo per un singolo publish MQTT in
  `notifyPlannerOfOrphanedTickets()` — un bug di efficienza reale, non una
  scelta tecnologica — sostituito con il client `mqtt` già importato
  in-process (Fase 1/M1).
- Il doppio publish dello stesso evento `ticket_stalled` — risolto con un
  gate anti-doppio-publish basato su un heartbeat file locale
  (`scripts/watcher/heartbeat.mjs`), non con un cambio di broker o
  protocollo (Fase 1/M5).
- La logica di rilevamento "ticket stallato" duplicata e divergente tra i
  due watcher — unificata in un unico modulo puro condiviso
  (`scripts/watcher/detect-stalled-tickets.mjs`), non con un cambio di
  motore di query (Fase 1/M4).

## Conseguenze

- Zero migrazione visibile per l'utente finale: nessun cambio ai dati su
  disco, nessun cambio alla superficie CLI `yano watch` / `yano watcher *`.
- Il vincolo di compatibilità è rispettato senza compromettere la priorità
  velocità/costo, perché i veri colli di bottiglia diagnosticati (spawn di
  sottoprocesso, connessioni MQTT ridondanti, doppio publish, query
  duplicate) erano tutti risolvibili a livello di uso, non di fondamenta.
- Se una fase futura tocca un sotto-sistema con vincoli di compatibilità
  diversi (es. nessun dato legacy da preservare), questa ADR non impedisce
  di rivalutare le fondamenta in quel contesto — vale solo per lo scope
  qui coperto (watcher/supervisore).
