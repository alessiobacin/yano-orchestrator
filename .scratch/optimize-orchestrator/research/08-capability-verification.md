# Research 08 — Verifica delle capability per nuovi ruoli

## Decisione risultante

Un agente che propone una nuova voce in `agents/roles.yaml` deve trattare
`skills`, `cli`, `mcp` e credenziali come requisiti dichiarativi da verificare,
non come capability già disponibili. La proposta è accettabile solo quando
ogni requisito ha una prova riproducibile nell'ambiente target e un esito
esplicito; in caso contrario il runtime deve rifiutare il ruolo o marcarlo
`unavailable`, senza dispatch automatico.

## Evidenze locali

### Modello e limiti attuali

- [`agents/roles.yaml`](../../../agents/roles.yaml) contiene per ruolo `skills`,
  `cli`, `mcp`, `model` e `teams`; i valori sono nomi/stringhe, senza versione,
  comando di verifica, scope, requisito di credenziale o permesso richiesto.
- [`agents/agents.yaml`](../../../agents/agents.yaml) applica override per
  istanza. Il campo `inherit_role_tools` è documentato come predefinito a true.
- In [`extensions/orchestrator.ts:251-270`](../../../extensions/orchestrator.ts:251)
  i tipi di configurazione espongono soltanto array di stringhe per skill/CLI/MCP.
  In [`extensions/orchestrator.ts:297-323`](../../../extensions/orchestrator.ts:297)
  `resolveCapabilities()` fa merge/deduplica di role e instance, ma non esegue
  discovery o health check.
- In [`extensions/orchestrator.ts:1555`](../../../extensions/orchestrator.ts:1555)
  le skill risolte sono usate dal capability matching. In
  [`extensions/orchestrator.ts:4349-4353`](../../../extensions/orchestrator.ts:4349)
  `ticket_claim` confronta solo `role + skills` con `required_capabilities`;
  `cli` e `mcp` non partecipano al gate.
- Le note di sviluppo registrano il gap reale: `--role` senza una corrispondente
  istanza in `agents.yaml` non alimenta correttamente le capability del ruolo
  ([`docs/development-notes.md:2377-2394`](../../../docs/development-notes.md:2377)).

### Caricamento delle skill

- Le skill vendorizzate sono file `SKILL.md` sotto
  [`skills-vendor/`](../../../skills-vendor/), non una registry runtime.
  La procedura di isolamento e caricamento per ruolo è implementata in
  [`scripts/launch-planner.mjs`](../../../scripts/launch-planner.mjs) e verificata
  da [`scripts/check-skill-isolation.mjs`](../../../scripts/check-skill-isolation.mjs).
- Le note confermano che il campo `skills` di `roles.yaml` è metadato
  informativo per le skill vendorizzate; il caricamento effettivo del planner
  avviene tramite flag `--skill` ([`docs/development-notes.md:2846-2879`](../../../docs/development-notes.md:2846)).
- Pertanto la prova minima per una skill deve includere: path risolto, file
  `SKILL.md` leggibile, contenuto/manifest valido, versione o commit noto, e
  caricamento in una sessione del ruolo. La presenza del nome YAML da sola non
  basta.

### CLI

- [`scripts/doctor.mjs:36-46`](../../../scripts/doctor.mjs:36) usa un controllo
  di esistenza dell'eseguibile e tratta anche un exit code non-zero come
  “trovato”; questo è utile per discovery ma non prova che la CLI sia
  utilizzabile.
- Lo stesso doctor verifica versioni/risoluzione di Node, git e `pi`, e la
  raggiungibilità del broker MQTT ([`scripts/doctor.mjs:97-145`](../../../scripts/doctor.mjs:97)).
- Il preflight di un nuovo ruolo deve quindi fare due prove distinte:
  `resolve` (eseguibile trovato sul PATH o path assoluto) e `probe` (comando
  non distruttivo, versione/help, exit code ammesso, timeout, stdout/stderr
  sanitizzati). Il risultato deve conservare path reale, versione, exit code,
  timestamp, ambiente/progetto e motivo di eventuale fallimento.

### MCP

- [`mcp.json`](../../../mcp.json) mostra due trasporti diversi: `chrome-devtools`
  via comando stdio (`npx ...`) e `stitch` via HTTP URL. La configurazione è
  project-wide; non esprime scope per ruolo.
- I prompt confermano il limite operativo: il server MCP abilitato può essere
  tecnicamente raggiungibile da ogni ruolo, anche se solo alcuni prompt lo
  usano ([`prompts/reviewer.md:195-214`](../../../prompts/reviewer.md:195)).
- Per uno stdio MCP la prova deve avviare il server in modo controllato e
  completare handshake/`initialize` e `tools/list`, verificando che i tool
  richiesti esistano e che gli schemi siano validi. Per HTTP deve verificare
  URL/transport, handshake e autorizzazione senza stampare token.
- Un MCP dichiarato per un ruolo ma disponibile soltanto project-wide deve
  essere riportato come capability condivisa, non come isolamento di sicurezza
  per ruolo. Se il Playbook richiede isolamento, la configurazione deve essere
  rifiutata finché il runtime non lo garantisce.

### Credenziali e permessi

- [`mcp.json:7-13`](../../../mcp.json:7) contiene una credenziale HTTP
  direttamente nella configurazione. Il report non ripete il valore: il futuro
  preflight deve rilevare pattern di secret nei file versionati, bloccare la
  proposta e richiedere secret store/environment reference. La credenziale
  eventualmente esistente va ruotata fuori da questa ricerca.
- Per credenziali non basta verificare che una variabile sia valorizzata: bisogna
  eseguire una probe minima autorizzata verso la risorsa dichiarata, con scope
  esplicito e output redatto. Il risultato deve distinguere `missing`, `invalid`,
  `expired`, `insufficient_scope` e `verified`.

## Fonti ufficiali

- [npm `package.json` documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/): il campo `bin` mappa i nomi dei comandi ai file eseguibili; utile per verificare che la CLI pubblicata corrisponda al nome dichiarato.
- [Node.js `child_process.execFile`](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback): esegue direttamente un file senza shell; espone timeout, environment, exit/error e output, quindi è la base sicura per probe CLI non interattive. Input non fidato non deve essere passato con `shell: true`.
- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization): HTTP MCP può richiedere OAuth; i client devono usare discovery metadata, resource indicators e storage sicuro dei token. La specifica indica invece che stdio recupera credenziali dall'ambiente.
- [MCP Transports specification](https://modelcontextprotocol.io/specification/draft/basic/transports): stdio significa processo server avviato dal client e messaggi JSON-RPC su stdin/stdout; Streamable HTTP è l'altro trasporto standard. Questo definisce le prove di avvio/handshake da eseguire.

## Procedura proposta per l'agente “role-definition”

1. Leggere `roles.yaml`, `agents.yaml`, prompt, manifest/package manager,
   configurazione MCP e documentazione locale; classificare ogni requisito
   come skill, CLI, MCP, credential, model/provider o permission.
2. Normalizzare i nomi e risolvere i riferimenti senza eseguire comandi
   dichiarati dal repository alla cieca. Registrare fonte, versione/commit,
   path/URL, scope e dipendenze.
3. Eseguire probe read-only bounded: file/manifest per skill; `--version` o
   `--help` per CLI; initialize/list-tools per MCP; chiamata minima autorizzata
   per credential/scope. Ogni probe ha timeout, exit policy e redaction.
4. Calcolare capability effettive come intersezione tra dichiarazione,
   caricabilità, autenticazione, permessi e isolamento. Una capability non
   verificata non entra in `required_capabilities` e non abilita dispatch.
5. Produrre un report con tabella `requirement | declared | resolved | verified |
   evidence | version | scope | failure`, più conflitti role/instance e rischi.
6. Consentire la scrittura in `agents/roles.yaml` solo dopo validazione
   sintattica, assenza di secret, nomi univoci, capability verificate e
   approvazione umana; il runtime deve ripetere il preflight all'avvio/run e
   rifiutare configurazioni cambiate o non compatibili.

## Invarianti per la futura implementazione

- Nessun nome in `skills`, `cli` o `mcp` è prova sufficiente di disponibilità.
- Nessun secret in chiaro in YAML/JSON, report, log o eventi MQTT.
- Una capability dichiarata ma non verificata produce `blocked`/`needs_replan`,
  non un dispatch ottimistico.
- La capability card deve essere versionata e legata all'ambiente; un cambio di
  binario, skill, server MCP, credenziale, scope o modello invalida la verifica.
- Il runtime deve distinguere capability effettive da metadati usati per
  matching e deve correggere il gap attuale tra `--role` e `agents.yaml` prima
  di affidarsi al ruolo dinamico.
