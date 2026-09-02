# ADR-0002: Namespace MQTT project-scoped con presence per ruolo/istanza

- **Stato**: accettata
- **Data**: 2026-09-02 (prassi corrente; codificata come ADR durante la pulizia del repo)
- **File di riferimento**: `docs/architecture/architecture.md` (sezioni "Runtime boundaries" e "Project repair and reconciliation"), `prompts/planner.md`, `extensions/orchestrator.ts`

## Contesto

Più processi `pi` indipendenti lavorano sullo stesso progetto e coordinano
deleghe, risposte e stato attraverso un broker MQTT 5 condiviso. Servono (a)
isolamento tra progetti che usano lo stesso broker e (b) un modo affidabile
per sapere se un agente è davvero vivo prima di delegargli lavoro, senza
confondere evidenza storica e presenza attuale.

## Decisione

- **Namespace project-scoped**: i topic MQTT sono prefissati
  `pi/<project>/...`; due progetti sullo stesso broker restano isolati a meno
  che l'operatore non passi deliberatamente lo stesso `--project`.
  `yano start` risolve l'identità dalla root e passa lo slug canonico
  esplicitamente al processo `pi` figlio, così un'estensione caricata da
  un'installazione diversa non può scegliere in silenzio un namespace
  condiviso (docs/architecture/architecture.md, "Runtime boundaries").
- **Identity a quattro campi**: ogni istanza ha `instance`, `role`, `project`
  e `team`. La delega `agent_send` avviene per istanza esatta (1:1) o per
  ruolo (fan-out a tutte le istanze vive di quel ruolo); le risposte si
  recuperano con `agent_get`/`agent_await`.
- **Presence retained con validazione**: le card retained portano il topic di
  status e il campo `project`; il runtime valida entrambi prima di aggiungere
  una card al roster. Il watcher segnala `project_scope_mismatch` quando un
  worker si unisce al namespace sbagliato.
- **Evidenza storica ≠ agente vivo**: nelle operazioni di inventario e repair,
  le card MQTT `offline` o con heartbeat stantio sono trattate come evidenza
  storica, mai come agenti live (`docs/architecture/architecture.md`, "Project repair and
  reconciliation").
- **Sicurezza anti-loop**: ogni send eredita un hop count dal task in entrata
  e viene scartata oltre 24 hop; `new_round: true` azzera il contatore per un
  nuovo giro di lavoro logicamente collegato. `agent_terminate` (spegnimento
  forzato di un peer) è riservato al planner. `agent_publish_event` pubblica
  eventi di stato sul canale del team senza mai innescare il turno di un altro
  agente.

## Conseguenze

- La presenza è advisory ma sufficiente a emettere un warning immediato
  quando un target non è live; la delega a un target offline viene reindirizzata
  (fallback a `planner-01` o al canale watcher persistente) invece di essere
  riportata come riuscita.
- Il fan-out per ruolo è deliberatamente senza claim arbitration: tutte le
  istanze vive del ruolo ricevono il messaggio; il planner usa i gate di fase
  (`plan_set`/`plan_advance`) per controllare chi è effettivamente abilitato
  a lavorare.
- Le card retained richiedono manutenzione (heartbeat, validazione del campo
  `project`) ma rendono il roster ricostruibile senza polling, e i worker
  appaiono immediatamente dopo la connessione.