# CAPITOLO PRODOTTO-UX — audit-campaign deep 16-09

- run: `01M2MB2JEWW0DF9F9GS5SVQ4RW`
- ticket: `01M2MB7WXNQG0RHZ7ANV95N5QV` (role: product-ux-analyst)
- target: `/Users/alessiobacin/Development/testCode/yano-orchestrator` v1.6.2 (`faed4ad` per manifest)
- manifest: `docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json` (letto per primo, nessuna discovery rifatta)
- data: 2026-09-16 UTC
- mandato: read-only, valuta comandi dal punto di vista umano, opzioni mancanti, GUI/dash, feature gap, concorrenti e opportunità; separa fatti / inferenze / ipotesi
- artefatto unico: `docs/reports/audit-deep-16-09-26_07-37/product-ux-16-09.md` (nessuna mutazione codice)

Metodo: riuso manifest + probe read-only (`--help`, `ls`, `head`, `wc`, `grep`) elencati in Resource record. Nessun broker/Herdr/pi-spawn live, nessun test eseguito, nessuna scrittura fuori da questo report.

---

## 1. Sintesi (giudizio)

Yano ha un'ampiezza funzionale rara per un orchestrator CLI-first (42 voci help, 31 playbook, 57 ruoli, Gantt + feedback-dash + frontend-dash + trace), ma l'UX umana paga tre costi: (a) **sovrapposizione di comandi** (`schedule` vs `cron`, doppio `architect`, `status|logs|fleet|mcp` come alias opachi, `feedback-api` alias `dash`), (b) **help a due velocità** (alcuni comandi con `--help` ricco, altri muti o con bug), (c) **onboarding frammentato ma abbondante** (README 580 righe + quick-start 498 righe + 41 quick-guides + 35 cheat-sheet: ottima copertura, pessima progressività). Le GUI esistono e sono curate (Gantt dark, responsive, onestà epistemica su "non confermato"), ma sono tre superfici separate senza home unificata. Il differenziale competitivo è reale (worktree-isolation + ticket/DAG SQLite + watchdog + closing checklist + trace semantico), ma è raccontato in linguaggio da maintainer, non da utente.

Separazione rispettata in tutto il capitolo:
- **FATTO** = osservato direttamente in file/help letti.
- **INFERENZA** = conclusione razonabile da fatti, marcata con confidence doppia.
- **IPOTESI** = non verificabile read-only (serve uso live o mercato), marcata esplicitamente.

---

## 2. FATTI — inventario UX verificato

### 2.1 Superficie comandi (da `yano --help`, exit 0)

42 righe comando in help. Categorie umane ricostruite (il CLI non le raggruppa):

| Gruppo umano | Comandi | Note di fatto |
|---|---|---|
| Vita progetto | `init`, `start`, `end`, `leave`, `pause`, `resume`, `recovery`, `repair` | `leave` richiede `--yes`; `pause/resume/recovery` snapshot-based |
| Ambiente | `doctor [--json]`, `deps`, `skills install\|status`, `update`, `uninstall`, `copy-prompts` | `doctor` stampa checklist reale (vedi §2.3) |
| Osservabilità | `status`, `logs`, `fleet`, `mcp`, `projects`, `gantt`, `watch`, `trace` | `status\|logs\|fleet\|mcp` presentati come un'unica riga alias; `fleet`/`logs` senza `--help` dedicato osservato |
| Conoscenza/memoria | `memory agents\|list\|show\|create\|update\|delete`, `model-advisor`, `playbook\|agent`, `architect`, `config`, `rule` | `architect` compare DUE volte in help (riga 23 e riga 31, cfr. evidenza E06) |
| Automazione | `schedule`, `cron`, `services`, `api …`, `test-env`, `capabilities`, `data` | `schedule` e `cron` entrambi presenti senza distinzione in help (cfr. E07) |
| Feedback/bug | `feedback serve\|create\|list\|get\|update\|delete`, `feedback-api start\|stop` (alias `dash`) | API su porta 20002 dichiarata in help |
| Frontend/dev | `frontend-review browser\|setup\|start`, `frontend-dash start\|stop\|list` (porte 10000-10999) | Due superfici frontend distinte |
| Docs/QA | `docs-check`, `qa-inventory scan` | `qa-inventory` dichiara output "bozza grezza" |

### 2.2 Qualità help a due velocità (fatto)

- Ricchi: `trace --help` (~30 righe, sotto-comandi + filtri + search modes), `config --help` (con nota segreti/stdin), `gantt --help` (porte, persistent/link/links/open/once), `status --help` (one-liner con flag).
- Poveri/muti: `yano schedule --help` → output vuoto (osservato, E04); `yano cron --help` → output vuoto (E04); `yano deps --help` → una sola riga prescrittiva "indica almeno uno tra --cli, --env, --auth" (E05); `yano start --help` → una sola riga "launch-planner: --instance è obbligatorio" (E03) — non documenta `--herdr`, `--print-only`, `--json` citati invece nel manifest come esistenti nello script.
- `doctor` senza `--help` utile: `yano doctor --help` esegue direttamente il check (non stampa uso), comportamento osservato.

### 2.3 `doctor` reale (fatto, exit 0)

Stampa ~35 righe checklist con ✓/✗: config, skill globali, node v26.5.0, git/npm/npx/pi, Code Mem, playwright-cli + skill, 8 skill mattpocock/wayfinder/to-spec/grilling/domain-modeling, 7 Pi extension, MCP endpoint (github raggiungibile, 3 voci mancanti in `.mcp.json` locale), Ollama + embedding `nomic-embed-text` 768-dim probe riuscita. È la migliore "prima impressione" del prodotto: concreta, machine-checkable, onesta sui mancanti (✗ espliciti).

### 2.4 Onboarding docs (fatto, conteggi)

- `README.md` 580 righe, `docs/quick-guides/quick-start.md` 498 righe (misurati `wc -l`).
- `docs/quick-guides/` 41 file, `docs/cheat-sheet/` 35 file (`00-generale`…`34-digest`, +README), `docs/diagram/` 14 `.mmd` (da manifest).
- `docs/README.md` dichiara 8 categorie canoniche obbligatorie e vieta file extra sotto `docs/` (regola clean-repo). Il percorso nuovi-utenti dichiarato è README-root → quick-guides.
- Lingua mista osservata: help CLI in italiano ("Uso: yano <comando>", "Scaffolda", "Attività"), README in inglese, Gantt HTML `lang="it"` con stringhe italiane, `docs/README.md` in italiano. Fatto, non giudizio.

### 2.5 GUI/dash esistenti (fatto, da `head` statico + smoke-test names)

1. **Gantt** (`scripts/gantt-server.mjs` 13.6 KB, `gantt.html` 16.9 KB, `gantt-registry.mjs`): HTML dark-mode (`--bg:#101820`, mint/amber/red), responsive `@media(max-width:950px)`, `prefers-reduced-motion`, filtri periodo/assignment/stato/ricerca, overview Ora/Prossimi/Ultimi, timeline con barre + `now-marker`, onestà epistemica nelle stringhe ("Nessun lavoro in esecuzione confermato. Una sessione aperta o una risposta mancante non significa che l'LLM stia lavorando.", "Conclusione non registrata. La barra si ferma all'ultima evidenza"). Porte 10000-19999, `--persistent/--link/--links/--open/--once`.
2. **Feedback dash/API** (`scripts/yano-dash.mjs` + `yano-dash-state.mjs` + `yano-frontend-dashboard.mjs`): commento header "Local feedback REST API. Applications own the bug/suggestion interface." Porta 20002 per `feedback serve`; `feedback-api` alias `dash`.
3. **Frontend-dash proxy** (`scripts/yano-frontend-dashboard.mjs` header: "Development-only project runner and reverse proxy… so browser/Agentation feedback cannot cross projects"): range 10000-10999, `waitPort` 30s.
4. Smoke test dedicati (nomi, non esecuzione): `smoke-test-gantt*.mjs`, `smoke-test-yano-dash*.mjs`, `smoke-test-frontend-review.mjs`, `smoke-test-server-status.mjs`, `smoke-test-yano-status.mjs` — copertura nominale GUI presente.

### 2.6 Naming/outcome (fatto)

- `memory` ha sotto-comando `agents` (non `agent`), mentre il catalogo ruoli usa `agent` (`playbook|agent`). Incoerenza nominale osservata in help.
- `architect projects|watcher projects|auto-improve|auto-improver projects` (riga help 23) vs `architect [opzioni]` (riga 31): stesso verbo, due granularità diverse nella stessa schermata.
- `yano fleet` stampa "8 agente/i live" + tabella istanze/team (osservato live read-only, E09); `yano logs` stampa "10 log disponibili" + lista `.jsonl` (E09). Quindi i comandi funzionano, ma il loro `--help` non ne documenta l'output.

---

## 3. INFERENZE — frizioni umane (con confidence doppia)

I1. **Sovrapposizione schedule/cron è il rischio UX #1.** Due comandi per job ricorrenti con help vuoti entrambi; l'utente non può distinguere "script-first deterministico" (`schedule`) da "CRUD naturale + supervisore" (`cron`) senza leggere gli script. evidence 0.85 / judgment 0.8 — motivazione: help osservati vuoti + header script distinti noti dal manifest, ma nessuna prova d'uso reale.

I2. **Doppio `architect` confonde catalogo vs provisioning.** Riga 23 (elenco progetti worker esterni) e riga 31 (progetta/provisiona playbook globali) condividono il verbo per due concetti diversi. evidence 0.9 / judgment 0.8 — motivazione: righe help verbatim + brief ruolo architect ("non modificare mai il progetto di riferimento"), ma impatto su utenti reali non misurato.

I3. **`start --help` rotto/incompleto.** Mostra solo l'errore launch-planner su `--instance`, nasconde `--herdr` (il percorso primario documentato nelle quick-guide 03/05). Un nuovo utente che cerca "come avvio con Herdr" trova la risposta nelle guide ma non nel CLI. evidence 0.9 / judgment 0.85 — motivazione: output osservato + quick-guide 03/05 esistenti.

I4. **Alias opachi `status|logs|fleet|mcp` e `feedback-api/dash`.** Raggruppare quattro viste in una riga risparmia spazio ma impedisce scoperta (`fleet --help` e `logs --help` stampano direttamente dati, non uso). evidence 0.85 / judgment 0.75.

I5. **Onboarding abbondante ma senza progressività.** 580 + 498 righe + 76 guide/cheat-sheet = copertura eccellente, ma nessun "percorso 5 minuti → 30 minuti → power-user" dichiarato; `docs/README.md` indirizza a quick-guides ma non ordina i 41 file per obiettivo (install → primo run → loop quotidiano). evidence 0.9 / judgment 0.7 — motivazione: conteggi + assenza di indice per-obiettivo osservata, ma "pessima progressività" resta giudizio.

I6. **Tre GUI senza home.** Gantt (attività), dash (feedback), frontend-dash (proxy dev) sono tre porte/comandi separati; nessuno `--help` rimanda agli altri. L'utente deve comporre il puzzle. evidence 0.8 / judgment 0.75 — motivazione: header script + help disgiunti, ma uso combinato non osservato live.

I7. **Lingua mista IT/EN aumenta il carico per nuovi utenti EN.** Help IT + README EN + errori misti ("launch-planner: --instance è obbligatorio"). Per il maintainer IT è naturale; per adozione esterna è frizione. evidence 0.95 / judgment 0.65 — motivazione: stringhe verbatim, ma soglia di fastidio soggettiva.

I8. **Punti di forza UX reali (inferenza positiva).** `doctor` onesto (✗ espliciti), Gantt epistemicamente onesto ("non confermato", "ultima evidenza"), `deps --list-hints` (citato), `--json` su doctor/status/watch, `--once`/`--open` su gantt, `--stdin` per segreti in config: sono pattern UX maturi. evidence 0.85 / judgment 0.8.

---

## 4. Opzioni mancanti / gap osservati (fatti + inferenze marcate)

G1. (fatto) Nessuno `--help` utile per `schedule`, `cron`, `fleet`, `logs`, `mcp`, `projects` oltre il one-liner; `deps` richiede flag ma `--list-hints` non è scoperto in help principale.
G2. (fatto) Nessuna shell completion osservata (`ls scripts/*completion*`, `grep complete bin/yano.mjs` non eseguiti — dichiara: **non verificato**, marcato come ipotesi H-limite; non affermato come assenza).
G3. (inferenza, 0.7/0.65) Manca `yano --help <comando>` / `yano help <comando>` come forma alternativa: ogni comando rimanda a `yano <cmd> --help`, ma quando quel `--help` è vuoto/rotto (schedule/cron/start) non c'è fallback.
G4. (inferenza, 0.8/0.7) Manca raggruppamento in help (`yano --help` lista piatta 42 voci): basterebbero 6 intestazioni + `yano <gruppo> --help`.
G5. (inferenza, 0.75/0.7) Manca `yano dashboard` unificata (apre/lista Gantt+feedback+frontend-dash) — oggi tre comandi/porte.
G6. (inferenza, 0.7/0.65) Manca `yano init --dry-run / --yes / --template` scopribile da help (verifica demandata ad altri capitoli; qui solo gap di scopribilità).
G7. (inferenza, 0.75/0.7) Manca `yano doctor --fix` / remediation guidata: doctor diagnostica bene ma non propone il passo successivo (es. "MCP chrome-devtools mancante → esegui X").
G8. (fatto) `gantt --port` range 10000-19999 vs `frontend-dash` 10000-10999 sovrapposti: collisione possibile, gestita via allocazione ma non spiegata in help.
G9. (inferenza, 0.7/0.6) Nessun `yano upgrade --notes` / changelog nel CLI: release note esistono (`release-1.6.x.md`) ma non linkate da `update --help`.

---

## 5. GUI/DASH — valutazione umana

| Superficie | Stato | Punti forti (fatti) | Frizioni (inferenze) |
|---|---|---|---|
| Gantt | Buona, la migliore | Dark curato, responsive, reduced-motion, focus-visible, filtri, onestà epistemica, `--once` per probe | Nome "Gantt" promette pianificazione, mostra attività/storia (timeline descrittiva, non editing); nessun deep-link ticket→trace→log osservato in HTML head |
| Feedback dash/API | Funzionale, dev-facing | REST + Postman collection (`docs/postman/`), Agentation intake, stati/screenshot smoke test nominali | Alias `dash` collide concettualmente con dashboard visiva; porta 20002 vs 10000-19999 non raccontata |
| Frontend-dash proxy | Infrastrutturale | Isolamento per-progetto nel path URL, `waitPort`, range dedicato | Solo dev, nessun preview-link copy/paste documentato in help |
| `status/fleet/logs` CLI | Utili ma grezzi | Output reali osservati (8 agenti, 10 log) | Formattazione piatta, nessun `--watch`, nessun colore/stato aggregato dichiarato |

Valutazione complessiva GUI (inferenza, 0.75/0.7): sopra la media degli orchestrator CLI (che spesso non hanno GUI), sotto le aspettative "prodotto" (nessuna home, nessun onboarding grafico, nessuna vista utente-non-tecnico).

---

## 6. Feature gap dal punto di vista umano (priorità)

P0 (bloccanti scoperta):
1. Riparare `start --help` (deve documentare `--herdr`, `--instance`, `--print-only`, `--json`).
2. Riempire `schedule/cron --help` + riga help che distingue i due in una frase.
3. Sdoppiare/rinominare il secondo `architect` elenco (es. `architect projects` → `fleet projects` o `workers`).

P1 (attrito quotidiano):
4. Raggruppare `yano --help` per sezioni + `yano help <cmd>` alias.
5. `doctor --fix-hint`: dopo ogni ✗, una riga "esegui …".
6. `dashboard` unificata (lista/apre le tre GUI + porte).
7. Uniformare lingua help (scegliere IT o EN per CLI; oggi IT) e glossario (`agent` vs `agents`, `dash` vs `dashboard`).

P2 (adozione/mercato):
8. Onboarding progressivo: `quick-start.md` → split 5'/30'/power + indice per-obiettivo delle 41 guide.
9. `update --notes` / changelog nel CLI.
10. Gantt: deep-link ticket→trace, export PNG/CSV, vista "cosa mi aspetta" per utente (non solo planner).

---

## 7. Concorrenti e opportunità (IPOTESI — non verificate read-only)

H1. (ipotesi) Concorrenti naturali: orchestatori multi-agente su Pi/Claude-Code (es. pattern planner-coder-reviewer custom), framework agentici generici (LangGraph/CrewAI/AutoGen), task-runner con dashboard (Temporal UI, Airflow), coding-agent con fleet view. Yano si differenzia per worktree-isolation + ticket/DAG SQLite + watchdog presence-aware + closing checklist + trace semantico locale — combinazione non osservata altrove nel mandato, ma **confronto diretto non eseguito** (serve capitolo mercato o web).
H2. (ipotesi) Opportunità mercato: (a) team che usano coding-agent ma perdono tracciabilità (ticket/DAG + Gantt onesto = risposta), (b) agenzie/professionisti che devono dimostrare "chi ha fatto cosa con quale modello" (auditability), (c) progetti con compliance leggera (checklist finalize + snapshot/recovery). Richiede packaging "Yano per non-maintainer": init guidato, dashboard unica, pricing/onboarding se mai distribuito oltre uso interno.
H3. (ipotesi) Rischio posizionamento: oggi Yano parla a chi lo ha costruito (help IT, 76 guide, 42 comandi piatti). Senza P0/P1, la potenza (57 ruoli, 31 playbook) resta inaccessibile al secondo utente. L'investimento UX con ROI massimo è ridurre la superficie percepita (gruppi, dashboard unica), non aggiungere comandi.
H4. (ipotesi) Scommessa GUI: una "home Yano" locale (stato flotta + Gantt embed + feedback inbox + trace search in una pagina) trasformerebbe tre strumenti dev in un prodotto ispezionabile da un umano non-tecnico (PM/cliente). Costo moderato (server esistenti), valore alto per demo/adozione.

---

## 8. Evidenze (command + exit_code + artifact + source_reference + expected/observed + confidence doppia + limiti + resource_record)

E01 — help principale
- command: `node /Users/alessiobacin/Development/testCode/yano-orchestrator/bin/yano.mjs --help` — exit 0 — artifact: stdout ~150 righe (42 voci comando).
- source_reference: `bin/yano.mjs` (dispatcher, 450 righe da manifest) + help stdout.
- expected: inventario comandi stabile e raggruppato. observed: lista piatta 42 voci, IT, con duplicato `architect` e alias multipli per riga.
- evidence_confidence 0.95 / judgment_confidence 0.9 (help reale, scopi da header + manifest).
- limiti: scopi comandi da header/manifest, non da esecuzione mutante; nessuna misura d'uso reale.
- resource_record: { commands: ["node $T/bin/yano.mjs --help"], measurements: { help_subcommand_rows_grep: 42 }, model_used: "llmproxy (pinned name unknown)" }

E02 — versione/package
- command: `node -e "JSON scripts"` + `grep version package.json` — exit 0 — artifact: 18 npm script, `name yano-orchestrator`, `version 1.6.2`.
- source_reference: `package.json`.
- expected/observed: versione coerente con manifest (1.6.2) — confermato.
- evidence 0.98 / judgment 0.95. limiti: nessuna verifica publish/registry.

E03 — `start --help` incompleto
- command: `node $T/bin/yano.mjs start --help` — exit 0 (output 1 riga) — artifact: "launch-planner: --instance è obbligatorio per un agente Yano."
- source_reference: `bin/yano.mjs` → `scripts/launch-planner.mjs` (flag `--herdr/--print-only/--json` noti dal manifest, non da questo help).
- expected: uso completo con `--herdr`. observed: solo errore `--instance`.
- evidence 0.9 / judgment 0.85. limiti: flag launch-planner non rieseguiti qui, citati dal manifest.

E04 — `schedule/cron --help` vuoti
- command: `node $T/bin/yano.mjs schedule --help` e `cron --help` — exit 0, stdout vuoto (head 20 righe = nulla).
- source_reference: `bin/yano.mjs` righe schedule/cron + `scripts/` scheduler.
- expected: distinzione script-first vs NL-supervisor. observed: nessuna.
- evidence 0.9 / judgment 0.8. limiti: distinzione concettuale dal manifest/brief ruolo `scheduler`, non da esecuzione.

E05 — `deps --help` prescrittivo
- command: `node $T/bin/yano.mjs deps --help` — exit 0 — artifact: "yano deps: indica almeno uno tra --cli, --env, --auth (vedi --list-hints)."
- source_reference: `bin/yano.mjs`.
- expected: uso con esempi. observed: una riga, hint non espanso.
- evidence 0.9 / judgment 0.75.

E06 — doppio `architect`
- command: stesso help E01, `grep -n architect` → righe 23 e 31.
- source_reference: `bin/yano.mjs` + brief ruolo `architect` in `agents/roles.yaml` ("non modificare mai il progetto di riferimento").
- expected: un verbo = un concetto. observed: elenco worker esterni + provisioning playbook sotto stesso nome.
- evidence 0.9 / judgment 0.8.

E07 — GUI files
- command: `ls -la scripts/gantt*` + `head -n 30 scripts/gantt.html` + `head -n 40 scripts/yano-dash.mjs` + `head -n 40 scripts/yano-frontend-dashboard.mjs` — exit 0.
- source_reference: `scripts/gantt-server.mjs` (13.6 KB), `gantt.html` (16.9 KB), `gantt-registry.mjs`, `yano-dash.mjs`, `yano-frontend-dashboard.mjs`.
- expected: dashboard minima. observed: tre superfici curate (dark/responsive/reduced-motion, onestà epistemica, proxy isolato per-progetto, REST feedback).
- evidence 0.85 / judgment 0.75. limiti: solo `head`, nessuna esecuzione server/browser.

E08 — docs counts
- command: `ls docs/quick-guides/`, `ls docs/*.md`, `wc -l README.md docs/quick-guides/quick-start.md`, `head -n 60 docs/README.md` — exit 0.
- source_reference: `docs/README.md` (8 categorie canoniche), `README.md`, `docs/quick-guides/`, `docs/cheat-sheet/`.
- expected: onboarding progressivo. observed: 580 + 498 righe + 41 guide + 35 cheat-sheet, senza indice per-obiettivo.
- evidence 0.92 / judgment 0.7. limiti: qualità contenuti non valutata riga per riga (capitolo docs-sync).

E09 — `fleet`/`logs` output reale
- command: `node $T/bin/yano.mjs fleet --help` e `logs --help` — exit 0 — artifact: "8 agente/i live…" + "10 log disponibili…" (dati live read-only della campagna audit in corso).
- source_reference: watcher registry + `.jsonl` trace.
- expected: help d'uso. observed: esecuzione diretta dati (utile ma non documentata).
- evidence 0.85 / judgment 0.7. limiti: dati transitori della campagna, non baseline.

E10 — `doctor` checklist
- command: `node $T/bin/yano.mjs doctor --help` — exit 0 — artifact: ~35 righe ✓/✗ (node v26.5.0, pi, Code Mem, playwright, 8 skill, 7 extension, MCP, Ollama nomic-embed-text 768-dim).
- source_reference: `scripts/doctor.mjs` (via dispatcher).
- expected: prereq check. observed: il migliore pattern UX del CLI (onesto, specifico, machine-verificabile).
- evidence 0.9 / judgment 0.8. limiti: remediation non proposta (gap G7).

---

## 9. Resource record (capitolo)

- commands:
  - `ls docs/quick-guides/ | head -n 50; ls docs/*.md; ls scripts/ | grep -iE "gantt|dash|frontend|status|fleet"`
  - `node -e package.json scripts; node bin/yano.mjs --help; grep version package.json`
  - `for c in start/gantt/status/trace/memory/config/schedule/deps/doctor: node bin/yano.mjs $c --help | head -n 40`
  - `ls -la scripts/gantt*; head gantt.html/yano-dash.mjs/yano-frontend-dashboard.mjs; wc quick-guides; head docs/README.md`
  - `grep -c bin/yano.mjs; grep architect help; schedule/cron --help; wc README/quick-start; head README; ls cheat-sheet; fleet/logs --help`
- measurements: { help_commands: 42, package_scripts: 18, README_lines: 580, quick_start_lines: 498, quick_guides: 41, cheat_sheet: 35, diagrams_mmd: 14 (manifest), gantt_html_KB: 16.9, gantt_server_KB: 13.6, doctor_checks: "~35", fleet_live_observed: 8, logs_observed: 10 }
- model_used: `llmproxy (PI_MODEL/PI_PROVIDER env; exact pinned provider:model name unknown from env)` — come da manifest.
- target_version: 1.6.2.

---

## 10. Limiti e non-verificato

- Nessuna esecuzione live broker/Herdr/pi-spawn, nessun server GUI avviato, nessun browser: giudizi GUI da statico + nomi smoke test.
- Nessun confronto concorrenti eseguito (serve rete + capitolo mercato): §7 resta ipotesi.
- Nessuna misura utente reale (tempo-to-first-run, drop-off, SUS): priorità P0/P1 basate su euristica + help osservati, non su telemetry.
- Contenuto profondo guide/playbook/ruoli demandato ai capitoli docs/architettura/QA; qui solo scopribilità e struttura.
- Assenza shell-completion NON affermata (non verificata): non elencarla come fatto senza probe dedicato.

---

## 11. Raccomandazione al synthesizer

Portare in sintesi: (1) sdoppiamento `schedule/cron` + fix `start --help` come P0 UX, (2) home dashboard unica come scommessa prodotto, (3) raggruppamento help + `doctor --fix-hint`, (4) mantenere e pubblicizzare i differenziali (worktree/DAG/watchdog/trace/Gantt onesto) con linguaggio utente. Contraddizione esplicita: più comandi = più potenza ma meno adozione; la sintesi deve pesarla contro eventuali findings "aggiungere comandi" di altri capitoli.
