# Vendored skills — github/awesome-copilot

Questa cartella contiene una copia **vendorizzata** (non un mirror che si
aggiorna da solo) di una skill del repo pubblico `github/awesome-copilot`.
Vive FUORI da `.pi/skills/`, `~/.pi/agent/skills/` e `.agents/skills/`
deliberatamente, per non attivare la discovery automatica di Pi su tutti i
ruoli — viene caricata esplicitamente solo per i ruoli `reviewer` e
`frontend-developer` (vedi `scripts/launch-planner.mjs` e Revisione 49 in
`docs/notes/development-notes.md`), esattamente come `skills-vendor/mattpocock/`
è cablata solo per `planner` (Revisione 22).

- **Repo sorgente**: https://github.com/github/awesome-copilot
- **Commit pinnato**: `83561bd7d8a46fcda0581aedabdf8eac7cb196b6`
- **Link al commit**: https://github.com/github/awesome-copilot/commit/83561bd7d8a46fcda0581aedabdf8eac7cb196b6
- **Data del pin**: 2026-08-22
- **Fetch**: `git clone --depth 1` (shallow, HEAD al momento del pin, in una
  directory scratch — poi solo `skills/chrome-devtools/` è stata copiata
  qui, verbatim, byte per byte: nessun editing, nessuna riformattazione).

## Skill vendorizzata e perché

Richiesta esplicitamente dall'utente (Revisione 49): dare ai ruoli
`reviewer` e `Frontend Developer` la capacità di **verificare davvero, nel
browser, che il frontend funzioni** (non solo leggere il codice) prima di
approvare o dichiarare concluso un task — richiamando esplicitamente
https://www.skills.sh/github/awesome-copilot/chrome-devtools come skill da
usare a questo scopo.

- **`chrome-devtools`** (da `skills/chrome-devtools/` nel repo sorgente) —
  un solo file (`SKILL.md`, nessuna sottocartella `agents/` a differenza
  delle skill mattpocock), che documenta come usare gli strumenti MCP del
  server `chrome-devtools` (navigazione, click/fill, snapshot/screenshot,
  console log, network requests, performance trace) seguendo un flusso
  "snapshot-first".

## Limite importante, letto per intero PRIMA di vendorizzare (stessa cautela già seguita per mattpocock/skills)

A differenza delle skill mattpocock (puro markdown, nessuna dipendenza
esterna oltre al Skill tool stesso), `chrome-devtools` **richiede un vero
server MCP in esecuzione** (`npx chrome-devtools-mcp@latest`) perché i tool
che nomina (`navigate_page`, `take_snapshot`, `list_console_messages`,
ecc.) esistano davvero in una sessione `pi`. Questo NON è un limite di
questa skill in sé, ma della piattaforma Pi:

- **Pi non ha supporto nativo a MCP** (dichiarato esplicitamente su
  pi.dev: "No MCP"). Serve installare il pacchetto di terze parti
  `pi-mcp-adapter` (`pi install npm:pi-mcp-adapter`, poi riavviare Pi) per
  qualunque server MCP — non solo `chrome-devtools` — sia raggiungibile da
  una sessione.
- **Una volta installato `pi-mcp-adapter`, NON esiste alcun modo nativo di
  limitare un server MCP a solo alcuni ruoli/sessioni** — la documentazione
  del pacchetto stesso lo dichiara esplicitamente ("There is NO CLI flag
  to select MCP servers per session"). Un `.mcp.json`/`.pi/mcp.json` che
  dichiara `chrome-devtools` lo rende disponibile a QUALUNQUE istanza
  `pi` di quel progetto — planner, coder, security-evaluator, ecc. — non
  solo a reviewer/frontend-developer.

Per questo, il vero confine "solo reviewer e Frontend Developer" richiesto
dall'utente è realizzato in DUE metà, non una sola, esattamente come per
mattpocock/skills (dove `--skill` è cablato per ruolo da
`scripts/launch-planner.mjs`, mai a livello di configurazione MCP — qui non
esisteva un problema di MCP da risolvere):

1. **La SKILL** (questo file) — *è* scopabile per ruolo, e lo è:
   `scripts/launch-planner.mjs` aggiunge `--skill
   <percorso-di-questa-cartella>` SOLO quando il ruolo risolto è
   `reviewer` o `frontend-developer` (vedi `CHROME_DEVTOOLS_SKILL_ROLES` in
   quel file), mai per planner/coder/altri specialisti. Verificato da
   `scripts/check-skill-isolation.mjs`.
2. **Il server MCP** — *non è* scopabile per ruolo (limite di
   `pi-mcp-adapter`/Pi, non di questo pacchetto): va dichiarato
   project-wide in `.mcp.json` (vedi `.mcp.json.example` nella root del
   pacchetto, copiato in ogni progetto scaffoldato da `yano init` come
   `.mcp.json.example`, mai come `.mcp.json` attivo — l'utente deve
   consapevolmente rinominarlo/attivarlo e installare `pi-mcp-adapter`,
   stesso principio già seguito per `.env.example` vs `.env`). Sarà quindi
   TECNICAMENTE raggiungibile anche da altri ruoli se lo abilitano, ma
   `prompts/reviewer.md` e `prompts/frontend-developer.md` sono gli UNICI
   due prompt di ruolo aggiornati per istruirne davvero l'uso (convenzione
   a livello di prompt, non un vincolo di codice — stesso pattern già
   accettato altrove in questo pacchetto, es. il loop
   frontend-developer↔reviewer).

## Aggiornare il pin in futuro

Questo NON è un mirror che si tiene aggiornato da solo. Per aggiornare
consapevolmente:

1. `git clone --depth 1 https://github.com/github/awesome-copilot.git` in
   una directory scratch, annotare il nuovo commit hash.
2. Diff manuale tra il commit pinnato qui sopra e il nuovo HEAD per
   `skills/chrome-devtools/` — leggere il nuovo `SKILL.md` per intero
   prima di sovrascrivere (stessa cautela del vendoring iniziale:
   verificare se sono comparse sottocartelle/dipendenze nuove che
   servirebbe vendorizzare insieme, come già successo per
   `domain-modeling` nel caso mattpocock).
3. Aggiornare commit hash e data in questo file.
4. Rieseguire `npm run check-skill-isolation` e la suite di smoke test.
