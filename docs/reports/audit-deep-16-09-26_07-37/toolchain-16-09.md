# Toolchain readiness — audit-campaign deep (capitolo TOOLCHAIN)

- target (READ-ONLY): `/Users/alessiobacin/Development/testCode/yano-orchestrator` (v1.6.2, HEAD `faed4ad529a3f938535b9100e9f378b9836916b3`)
- manifest (letto per primo, no rediscovery): `docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json` (run `01M2MB2JEWW0DF9F9GS5SVQ4RW`, ticket `01M2MB6P776HV6DVG9WPYKN8F6`)
- contratto confidenza: `prompts/audit-confidence-contract.md` — scala 0-10, `confidence` == `evidence_confidence`, più `judgment_confidence` + `judgment_confidence_rationale`
- vincoli rispettati: nessuna installazione, nessun segreto stampato, nessun live spawn/start, solo artefatto audit scritto (`docs/reports/audit-deep-16-09-26_07-37/toolchain-16-09.md`)
- `scripts/audit-delegation.mjs`: consumato; output vuoto (0 candidati) — la classificazione D0/D1/AI sotto è giudizio specialistico, non output dello script

## Chapter — capability readiness (sintesi)

| Famiglia | Esito |
|---|---|
| CLI core campagna (`node`, `git`, `yano`) | **ready** — probe diretti exit 0 |
| CLI supporto (`npm/npx/docker/compose/herdr/gh/rg/pi/cm/curl/mongosh/playwright-cli/ollama`) | **ready** (kubectl: **partial**, probe canonico da correggere) |
| CLI mancanti (`helm`, `postman`, `semgrep`) | **unready** — opzione installazione registrata, NON installati |
| MCP dichiarati | **unknown** (config ≠ raggiungibilità; handshake live non eseguito per mandato read-only) |
| Skill campionate + globali (`doctor`, `skills status`) | **ready** (file caricabili + sync verificata per `yano-cli`) |
| Script chiave | **ready** per esistenza + header/parse; **unknown** per pass/fail runtime (mai eseguiti: richiedono broker/docker/creds) |
| Playbook (`toolchain-readiness-audit`, `audit-campaign`, 31/31 lint) | **ready** (list/show/check exit 0) |
| Docs canoniche 8/8 | **ready** (`docs-check --json` ok:true) |
| Topologia frontend/backend | **unknown** (`capabilities show` confidence unknown, 2026-09-12) |

## CLI matrix

Formato per riga: dichiarata da / probe / versione+exit / permessi / doc / capitoli / fallback / readiness / motivo + confidenze.

1. `node` v26.5.0 — dichiarata da: `agents/capabilities.yaml` + `package.json` engines (>=22.5.0). Probe: `node --version` exit 0. Permessi: nessuno. Doc: `README.md`, `bin/yano.mjs` header. Capitoli: tutti (D0). Fallback: nessuno necessario. **readiness: ready** — versione misurata sopra minimo. `confidence: 10, evidence_confidence: 10, judgment_confidence: 9, judgment_confidence_rationale: "probe diretto exit 0; resta ignoto il pinned provider:model llmproxy da env."`
2. `git` — dichiarata da: capabilities. Probe: `git rev-parse HEAD` → `faed4ad...` exit 0; `git log --oneline -3` ok. Permessi: lettura repo. Doc: manifest `resource_record`. Capitoli: tutti. Fallback: n/a. **ready**. `confidence: 10, evidence_confidence: 10, judgment_confidence: 9, judgment_confidence_rationale: "prova diretta read-only; nessuna scrittura esercitata."`
3. `yano` 1.6.2 — dichiarata da: `bin/yano.mjs` (450 righe), `package.json` bin. Probe: `node $T/bin/yano.mjs --help` exit 0 (~42 righe comando); `--version` → `1.6.2` exit 0; `deps --cli node,git,yano` → `3/3 soddisfatti` exit 0. Permessi: esecuzione locale, lettura progetto. Doc: skill `yano-cli` (487 righe). Capitoli: tutti. Fallback: invocazione via `node bin/yano.mjs` (usata qui perché il cwd-relative fallisce con MODULE_NOT_FOUND). **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "help/version/deps reali; sottocomandi mutanti mai eseguiti per mandato."`
4. `npm` 11.17.0 / `npx` 11.17.0 — probe `--version` exit 0. **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 9, judgment_confidence_rationale: "probe diretto, nessuna ambiguità."`
5. `docker` 29.7.2 + `docker compose` v5.3.1 — probe `--version` / `compose version` exit 0. Permessi: socket docker (non usato). Capitoli: deployment/delivery, e2e. **ready** (disponibilità binario; daemon health non per capitolo toolchain). `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "versione provata, reachability daemon non esercitata."`
6. `herdr` 0.8.2 — probe `--version` exit 0. **ready** (binario; lifecycle tab mai avviata per mandato). `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "solo versione, nessuno spawn live."`
7. `gh` 2.96.0 — probe `--version` exit 0. Capitoli: QA/evidence. **ready**. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "auth non verificata (sarebbe D1/AI, non probe sicuro senza segreti)."`
8. `rg` 15.1.0 — probe `--version` exit 0. Capitoli: tutti (inventario/parsing). **ready**. `confidence: 10, evidence_confidence: 10, judgment_confidence: 10, judgment_confidence_rationale: "nessuna ambiguità."`
9. `pi` 0.85.1 — probe `--version` exit 0 + `doctor` check `pi: trovato` ok. **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "spawn live mai eseguito per mandato."`
10. `cm` (Code Mem) 0.7.0 — probe `--version` exit 0 + `doctor` ok. **ready**. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "indice semantico non interrogato in questo capitolo."`
11. `curl` 8.7.1 — probe `--version` exit 0. **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 9, judgment_confidence_rationale: "probe diretto."`
12. `mongosh` 2.5.1 — probe `--version` exit 0. Capitoli: nessuno richiesto (solo catalogo). **ready** (extra). `confidence: 8, evidence_confidence: 8, judgment_confidence: 6, judgment_confidence_rationale: "presente ma connessione mai testata."`
13. `kubectl` — presente ma `kubectl --version` → `error: unknown flag: --version` (exit ≠ 0). Probe canonico da capabilities: `kubectl version --client=true` **non eseguito in questo round**. **partial** — binario esiste, segnale versione non raccolto. Fallback: usare probe da catalogo. `confidence: 4, evidence_confidence: 4, judgment_confidence: 6, judgment_confidence_rationale: "evidenza debole: errore flag dimostra presenza ma non versione."`
14. `helm` / `postman` / `semgrep` — `command -v` → NOT-FOUND. **unready**. Gap registrato, installazione NON eseguita (manca autorizzazione). Fallback: capitoli che li richiedono usano evidenza statica o vengono marcati BLOCKED. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "assenza binario è prova diretta; impatto per capitolo è giudizio."`
15. `playwright-cli`, `ollama` (+ embedding `nomic-embed-text` 768d) — solo via `doctor --json`: entrambi `ok:true`, ollama `http://127.0.0.1:11434 v0.20.2` raggiungibile, embedding probe riuscito. **ready (per delega doctor, D1)** — non riprovati con binario diretto in questo capitolo. `confidence: 7, evidence_confidence: 7, judgment_confidence: 7, judgment_confidence_rationale: "evidenza indiretta da script doctor, non da probe diretto del capitolo."`

## MCP matrix

Regola playbook: una configurazione MCP NON dimostra raggiungibilità; skill nominata NON dimostra istruzione caricabile.

| MCP | Dichiarata da | Probe sicuro | Versione/exit | Permessi | Doc | Capitoli | Fallback | Readiness + motivo |
|---|---|---|---|---|---|---|---|---|
| `chrome-devtools` | target `.mcp.json` + `.mcp.json.example` (npx `chrome-devtools-mcp@latest`) + `mcp_capabilities` (optional) | `doctor --json`: `MCP chrome-devtools: pacchetto risolvibile` ok; FAIL `mancante in yano-local-pc/.mcp.json` | exit 0 (doctor); nessun handshake | npx fetch al primo uso | `skills-vendor/awesome-copilot/chrome-devtools` | frontend-browser, product-ux | `playwright-cli` (doctor ok) + review DOM statica | **unknown** — pacchetto risolvibile ma handshake mai eseguito; progetto corrente ≠ target. `confidence: 5, evidence_confidence: 5, judgment_confidence: 6, judgment_confidence_rationale: "segnale statico, ambiguità progetto-target vs progetto-corrente."` |
| `github` | target `.mcp.json` (url `api.githubcopilot.com/mcp`, oauth) + `mcp_capabilities` (optional) | `doctor`: `MCP GitHub endpoint: raggiungibile; OAuth al primo uso` ok; FAIL mancante in `yano-local-pc/.mcp.json` | exit 0 (doctor); OAuth non completato | oauth (mai toccato) | `.mcp.json.example` | QA/evidence, repo-benchmark | `gh` CLI (presente, auth non verificata) + lettura git locale | **unknown** — endpoint raggiungibile ma auth al primo uso mai eseguita. `confidence: 5, evidence_confidence: 5, judgment_confidence: 6, judgment_confidence_rationale: "reachability senza auth non è capability operativa."` |
| `agentation` | target `.mcp.json` + `mcp_capabilities` (optional) | `doctor`: `MCP Agentation: pacchetto risolvibile` ok; FAIL mancante in `yano-local-pc/.mcp.json` | exit 0 (doctor); nessun handshake | npx fetch | playbook `frontend-browser` | frontend review | `playwright-cli` + `frontend-dash` (probe `start` MAI eseguito: mutante) | **unknown** — come sopra. `confidence: 5, evidence_confidence: 5, judgment_confidence: 6, judgment_confidence_rationale: "stesso limite: config+risoluzione ≠ server raggiungibile."` |
| `stitch` | target `.mcp.json` (bearer via `gcloud`, NON stampato) + `.mcp.json.example` + `mcp_capabilities` (optional) | solo lettura nomi server (`python3` list chiavi, no valori) | n/a — probe rete mai eseguito (richiederebbe `gcloud` + token) | bearer gcloud (non toccato) | `.mcp.json.example` | design-redesign | skill `stitch-design-redesign` (file) + review statica mock | **unknown** — credenziale richiesta, mai verificata per mandato no-secrets. `confidence: 4, evidence_confidence: 4, judgment_confidence: 6, judgment_confidence_rationale: "solo dichiarazione; verifica bloccata dal boundary credenziali."` |
| `mongodb` | solo `mcp_capabilities` (optional, inspection) | nessuno (nessun server in `.mcp.json`) | n/a | n/a | capabilities header | data/api-contract | `mongosh` CLI presente | **unknown** (dichiarata, non configurata, non probata). `confidence: 4, evidence_confidence: 4, judgment_confidence: 6, judgment_confidence_rationale: "catalogo la definisce 'known, not reachable-now'."` |
| apple-* / evolution-api | `yano mcp` fonte `yano-local-pc/.mcp.json` (9 voci: apple-notes/messages/contacts/reminders/calendar/maps/mail/voice-memos, evolution-api) | `node $T/bin/yano.mjs mcp` exit 0 (lista nomi) | exit 0; nessun `describe`/`call` | sandbox locale | n/a per target | local-pc-operations | CLI `yano local-pc` (help noto, `ask` mai eseguito: AI) | **partial** — lista dichiarata probata, operatività per-capitolo non probata. `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "lista reale ma appartiene al progetto corrente, non al target."` |

Nomi soltanto: target `.mcp.json` → `['chrome-devtools', 'agentation', 'github', 'stitch']` (valori/segreti MAI stampati).

## Skill matrix (istruzione caricabile?)

| Skill | Dichiarata da | Probe | Doc | Capitoli | Fallback | Readiness |
|---|---|---|---|---|---|---|
| `yano-cli` (487 righe) | playbook requirements (toolchain, audit-campaign) + `agent show toolchain-evaluator` | file `SKILL.md` leggibile + `skills status` → `sincronizzata` exit 0 + `doctor` ok | `skills-vendor/yano/yano-cli/SKILL.md` | tutti | `yano --help` | **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "file caricato + sync globale verificata; sync target-specifica non distinta."` |
| `yano-planner-trace-analysis` (261) | `agent show toolchain-evaluator` + doctor | file leggibile + doctor `presente` ok | `skills-vendor/yano/` | observability, cross-review | `yano trace --help` + JSONL grezzo | **ready**. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "caricabilità file ok; efficacia semantica è AI."` |
| `yano-observer` (42), `yano-code-review` (76) | vendor tree | file leggibili | `skills-vendor/yano/` | observer-audit, review | prompt di ruolo | **ready** (caricabili). `confidence: 8, evidence_confidence: 8, judgment_confidence: 6, judgment_confidence_rationale: "presenza+lettura non provano qualità istruzione."` |
| `ponytail` (120) | skill condivisa full | file leggibile | `skills-vendor/ponytail/ponytail/SKILL.md` | tutti (coding/design/review) | nessuna (default) | **ready**. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "attiva per roster; intensità full confermata dal task."` |
| `to-spec` (75), `to-tickets` (96) | vendor mattpocock + doctor (`to-spec` presente ok) | file leggibili | `skills-vendor/mattpocock/` | planning/decomposition | scrittura manuale spec | **ready**. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "come sopra: caricabile ≠ efficace."` |
| restanti vendor (11 yano + 7 mattpocock + wayfinder/grilling/domain-modeling/code-review/chrome-devtools/playwright-cli) | `ls -R skills-vendor` + doctor (tutti ok) | doctor exit 0 (D1, non rilettura file 1:1) | vendor tree | specialistici | prompt fallback | **partial** — dichiarate+doctor-ok, singola `SKILL.md` non riletta in questo capitolo. `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "evidenza indiretta; verifica file 1:1 oltre budget necessario."` |

## Script + playbook matrix

Script chiave (tutti `OK` esistenza; header/parse come da manifest; esecuzione live MAI fatta per mandato):

| Script | Probe | Readiness |
|---|---|---|
| `scripts/test-all.mjs` | `head -40`: runner check:package-version+syntax+docs+lint+unit+smoke+e2e; auto-avvia broker se `127.0.0.1:1883` irraggiungibile | **partial** — codificato e parsabile; non eseguito (avvierebbe broker/spawn). Fallback capitoli: `lint:capabilities` + `lint:playbooks` + `docs-check` singoli (eseguiti, exit 0). `confidence: 7, evidence_confidence: 7, judgment_confidence: 7, judgment_confidence_rationale: "struttura letta, risultato pass/fail unknown."` |
| `scripts/watch-stalls.mjs`, `watcher/*` (18), `orchestrator-tools/*` (33) | `ls` + manifest header | **partial** (stesso motivo). Fallback: `yano watch --help` + TCP check broker (REACHABLE, vedi sotto). `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "conteggi reali, semantica da header."` |
| `scripts/yano-trace*.mjs`, `yano-invoke.mjs`, `launch-planner.mjs` | manifest header | **partial**. Fallback: `yano trace --help`, `yano start --help` (read-only). `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "mai invocati con effetto."` |
| `scripts/audit-delegation.mjs` | `--help`→usage exit 0; `--manifest audit-manifest-16-09.json` → `{candidates:[], D0:0,D1:0,AI:0}` exit 0 | **ready** come tool, **empty-output** come evidenza (vedi tool-choice). `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "output deterministico ma vuoto: richiede giudizio."` |
| `scripts/audit-resource-ledger.mjs` | `--help`-like run → ledger vuoto `event_count:0` exit 0 | **ready** (emette schema); nessun evento di campagna ancora registrato. `confidence: 7, evidence_confidence: 7, judgment_confidence: 7, judgment_confidence_rationale: "schema verificato, popolazione rinviata al planner."` |
| `scripts/doctor.mjs` (via `yano doctor --json`) | exit 0, `ok:false` per 3 FAIL MCP progetto-corrente (vedi MCP) | **ready** — il `false` globale è evidenza, non guasto probe. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "30 check reali, fallimenti circoscritti e spiegati."` |
| `lint:capabilities` / `lint:playbooks` | exit 0: `17 CLI + 5 MCP resolve`; `31/31 playbook` | **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "verifica deterministica rieseguita, non solo citata dal manifest."` |
| `docs-check` | `--json` → `ok:true`, 8/8 categorie satisfied, exit 0 | **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "prova diretta rieseguita sul target."` |

Playbook:

| Playbook | Probe | Readiness |
|---|---|---|
| `toolchain-readiness-audit.yaml` | `playbook show` exit 0 (document + requirements `node/git/yano`, skill `yano-cli`); `playbook check` → `valid:true`, checksum `60663c…`, warnings `[]` exit 0 | **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "show+check reali con checksum."` |
| `audit-campaign.yaml` | `playbook check` → `valid:true`, checksum `c274a3…`, requirements `node/git/yano` + `yano-cli/yano-planner-trace-analysis`, warnings `[]` exit 0; capitoli/gate letti via grep (toolchain-evaluator write_scope `chapter-report-only`, evidenza richiesta, recovery) | **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "check reale; semantica DAG da lettura file, non da esecuzione."` |
| altri 29/31 | `playbook list` exit 0 (10+ voci viste, checksum per riga) + `lint:playbooks` 31/31 | **ready** (validità batch). `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "lint batch, non show 1:1."` |
| ruolo `toolchain-evaluator` | `agent show toolchain-evaluator` exit 0: playbook `toolchain-readiness-audit`, skills `yano-planner-trace-analysis,yano-cli`, cli `node,git,yano`, teams quality/platform | **ready**. `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "binding ruolo-playbook-capability probato."` |

## Tool-choice matrix (D0 / D1 / AI) + `audit-delegation.mjs`

Output script consumato (giudizio richiesto solo qui):

- comando: `node scripts/audit-delegation.mjs --manifest docs/reports/audit-deep-16-09-26_07-37/audit-manifest-16-09.json` → exit 0, `{summary:{D0:0,D1:0,AI:0}, candidates:[]}` (senza `--manifest`: usage exit 0).
- interpretazione: lo script NON classifica il lavoro di campagna contro questo manifest (mappa vuota), quindi la classificazione sotto è **giudizio specialistico**, non evidenza script. `confidence: 7, evidence_confidence: 7, judgment_confidence: 6, judgment_confidence_rationale: "output script certo ma vuoto; mappatura inevitabilmente interpretativa."`

| Lavoro | Classe | Strumento scelto | Perché (costo/determinismo/latenza/permessi/output) |
|---|---|---|---|
| inventario, parsing, hash/checksum, `help/version`, lint, `docs-check`, `playbook check`, `deps`, conteggi `ls/wc`, `git log/HEAD` | **D0** | script/CLI deterministici già codificati | costo ~zero token, riproducibile, permessi lettura, output machine-readable; sempre preferiti |
| `doctor --json`, `test-all.mjs`, smoke/e2e, `watch`, trace semantica, `yano mcp`→handshake, `gh` autenticato, `deps --auth`, broker pub/sub live | **D1** | script che raccoglie evidenza + interpretazione richiesta | lo script produce fatti (exit/version/JSON) ma il giudizio (pronto? bloccante? per quale capitolo?) resta umano/LLM; molti richiedono broker/creds non toccati qui |
| suitability per capitolo, trade-off tool, priorità gap, UX/prodotto, rischio remediation, sintesi cross-capitolo, stima costi | **AI** | giudizio LLM con evidenza esplicita | semantica e priorità non riducibili a exit code; ogni raccomandazione sotto porta doppia confidenza |

Regole tool-choice per la campagna: D0 prima di tutto; D1 con budget e fallback registrato; AI solo con evidenza citata + confidenza doppia; mai dichiarare "funzionante" senza probe; mai installare senza autorizzazione; mai stampare segreti.

## Missing prerequisites (gap installativi — NESSUNA installazione automatica)

1. `helm` NOT-FOUND — serve solo a capitoli delivery/k8s (`helm version`). Opzione: installazione manuale/approvata. Raccomandazione: rinviare a remediation; intanto evidenza statica da manifest k8s. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "assenza certa; priorità media, non bloccante per audit."`
2. `postman` NOT-FOUND — serve a `api discover` da Postman/OpenAPI. Opzione: installazione approvata. Raccomandazione: usare file `docs/postman/` (3 file, `docs-check` ok) come evidenza statica. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "assenza certa; fallback statico disponibile."`
3. `semgrep` NOT-FOUND — serve a SAST per security-review. Opzione: installazione approvata. Raccomandazione: capitolo security usa `grep/rg` pattern + review manuale; marcare copertura SAST come gap. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "assenza certa; downgrade copertura esplicito."`
4. `kubectl` versione non raccolta (flag errato nel mio probe; canonico `version --client=true` non eseguito). Azione: prossimo probe D0 con flag da catalogo; nessun install. `confidence: 5, evidence_confidence: 5, judgment_confidence: 6, judgment_confidence_rationale: "presenza probabile, versione unknown."`
5. MCP reachability (github oauth, stitch gcloud bearer, chrome-devtools/agentation handshake) — NON verificabile senza credenziali/rete al primo uso. Azione: planner decide se autorizzare handshake D1 per capitolo (con redazione) o accettare fallback. `confidence: 5, evidence_confidence: 5, judgment_confidence: 6, judgment_confidence_rationale: "boundary credenziali del manifest, non limite del probe."`
6. Pinned `provider:model` llmproxy — `PI_MODEL/PI_PROVIDER=llmproxy`, nome esatto non esposto in env (come nel manifest). Impatto: resource ledger senza breakdown modello. Azione: planner legge `yano model-advisor` / config (D1) se serve accounting token. `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "limite env noto e dichiarato."`

## Fallback per ogni capitolo (ogni capability indisponibile ha alternativa o blocker esplicito)

- `test-adequacy-analyst`: `test-all.mjs`/e2e non eseguiti (mutanti) → fallback D0: `lint:playbooks` + `lint:capabilities` + `docs-check` (eseguiti) + conteggi test manifest (149 smoke, 4+16+8); `semgrep` mancante → `rg` pattern. Blocker: nessun pass/fail runtime. `confidence: 7, evidence_confidence: 7, judgment_confidence: 7, judgment_confidence_rationale: "fallback statici reali; giudizio copertura resta AI."`
- `architecture-health-reviewer`: nessun tool mancante bloccante (`node/git/rg` ready) → lavora su evidenza statica; `kubectl/helm` gap solo per seam delivery. `confidence: 8, evidence_confidence: 8, judgment_confidence: 7, judgment_confidence_rationale: "toolchain statica completa."`
- `automation-control-auditor` / `observability-reviewer`: broker TCP `127.0.0.1:1883` REACHABLE (socket python, exit 0) ma pub/sub mai esercitato → fallback: `mosquitto.native.conf` statico + `yano trace --help` + JSONL esistente; trace semantica (ollama) D1 rinviata. `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "reachability socket ≠ routing verificato."`
- `product-ux-analyst` / frontend-browser / design: MCP browser/design `unknown` → fallback: `playwright-cli` (doctor ok) + skill file + `frontend-dash --help` (start mai eseguito). Blocker se serve live DOM. `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "strumenti presenti ma flusso live non probato."`
- `security-review` / `dependency-health`: `semgrep` assente → `rg` + `npm` audit manuale (D1, non eseguito qui); `mongosh` presente per inspection locale. `confidence: 6, evidence_confidence: 6, judgment_confidence: 6, judgment_confidence_rationale: "downgrade esplicito, non silenzio."`
- `deployment-delivery` / `platform-delivery`: `helm`/`kubectl-version` gap → `docker/compose` ready + `compose.yaml` statico; nessuna promozione senza approvazione (regola ruolo). `confidence: 7, evidence_confidence: 7, judgment_confidence: 7, judgment_confidence_rationale: "verificato il possibile senza cluster."`
- `data-api-contract`: `postman` assente → `docs/postman/` + `yano api --help` (show/verify D1 su file locali). `confidence: 7, evidence_confidence: 7, judgment_confidence: 6, judgment_confidence_rationale: "fallback file reale."`
- `repo-cartographer` (a monte): già completo via manifest — non rifare discovery (questo capitolo ha riusato manifest + probe mirati). `confidence: 9, evidence_confidence: 9, judgment_confidence: 8, judgment_confidence_rationale: "nessuna duplicazione eseguita."`
- `audit-synthesizer` / planner DAG: usa questo report + manifest; `audit-resource-ledger` emette schema vuoto finché la campagna non registra eventi. `confidence: 7, evidence_confidence: 7, judgment_confidence: 6, judgment_confidence_rationale: "ledger strutturale, non popolato."`

## Resource ledger (distinguere costo probe vs costo inferenza)

Comandi eseguiti (tutti read-only, bounded, exit registrata):

1. `node --version` → v26.5.0, exit 0
2. `git -C $T log --oneline -3 + rev-parse HEAD` → faed4ad…, exit 0
3. `node $T/bin/yano.mjs --help` → exit 0 (~42 comandi)
4. `node $T/bin/yano.mjs --version` → 1.6.2, exit 0
5. `node $T/bin/yano.mjs playbook --help` / `agent --help` / `deps --help` / `docs-check --help` → exit 0 (deps senza flag: usage, atteso)
6. `node $T/bin/yano.mjs playbook list` → exit 0; `playbook show toolchain-readiness-audit` → exit 0; `playbook check <toolchain>` → valid:true exit 0; `playbook check <audit-campaign>` → valid:true exit 0
7. `node $T/bin/yano.mjs agent list` → exit 0; `agent show toolchain-evaluator` → exit 0
8. `node $T/bin/yano.mjs deps --cli node,git,yano` → 3/3 exit 0
9. `node $T/bin/yano.mjs capabilities show` → exit 0 (frontend/backend false, confidence unknown)
10. `node $T/bin/yano.mjs doctor --json` → exit 0, ok:false (27 ok / 3 FAIL progetto-corrente su MCP)
11. `node scripts/lint-capabilities.mjs` → pass (17 CLI + 5 MCP) exit 0
12. `node scripts/lint-playbooks.mjs` → 31/31 exit 0
13. `node $T/bin/yano.mjs docs-check --project-root $T --json` → ok:true exit 0
14. `node scripts/audit-delegation.mjs [--manifest …]` → usage / candidates:[] exit 0
15. `node scripts/audit-resource-ledger.mjs` → schema + event_count:0 exit 0
16. `node $T/bin/yano.mjs mcp` → exit 0 (9 voci progetto-corrente); `skills status` → sincronizzata exit 0
17. versioni binari: `docker/compose/herdr/gh/rg/pi/cm/curl/npm/npx/mongosh` exit 0; `helm/postman/semgrep` NOT-FOUND; `kubectl --version` flag-error
18. letture: `package.json` (v1.6.2, engines, script audit:*), `capabilities.yaml` (17 CLI + 5 MCP), `.mcp.json` (solo nomi chiavi), 7 `SKILL.md` (lunghezze sopra), `toolchain-readiness-audit.yaml` (intero), `mqtt/*.conf`+`compose.yaml` statici, `test-all.mjs` head-40
19. TCP read-only `127.0.0.1:1883` → REACHABLE (socket python, nessun pacchetto MQTT inviato)

Misure: `node v26.5.0`, `yano 1.6.2`, `HEAD faed4ad`, `playbook` 31, `prompt` 38 (da manifest), `skills` 7 file verificati 1:1. Modello: `llmproxy` (PI_MODEL/PI_PROVIDER env; nome pinnato esatto unknown — come manifest). Budget playbook: max 180 comandi / 500 file / 80 min / 22000 token — questo capitolo: ~19 comandi, ~25 file, ben dentro. Token/inferenza puntuale: UNKNOWN (telemetria provider non esposta; non stimare — marcare unknown per contratto).

## Handoff al planner

1. Preflight toolchain per la DAG: sbloccare capitoli statici subito (architecture, test-adequacy-statica, repo già fatto); capitoli live (e2e, browser, deploy, SAST, MCP-handshake) restano gated su decisione credenziali/install.
2. Decisioni richieste (non prese qui): (a) autorizzare `kubectl version --client=true` + retry `test-all` in sandbox? (b) autorizzare handshake MCP redatto (github oauth / stitch gcloud / chrome-devtools npx)? (c) approvare install `helm/semgrep/postman` o accettare fallback statici? (d) serve breakdown token (`model-advisor`)?
3. Nessun "funzionante" dichiarato senza probe: ogni `ready` sopra ha comando+exit; ogni `unknown/unready/partial` ha motivo+fallback+confidenza doppia.
4. Prossimo owner: `delegation-efficiency-auditor` per `tool-choice-matrix` definitiva (qui bozza D0/D1/AI: script vuoto → giudizio), poi capitoli paralleli da manifest.
5. File: questo report è l'unico artefatto scritto nel target; codice non mutato; altri ticket non toccati.

## Limiti, documenti, file, verifiche

- Limiti: nessun live broker/Herdr/spawn; nessuna credenziale; MCP solo statico+doctor; test mai eseguiti; pinned model unknown; `yano mcp`/`doctor` riflettono progetto corrente (`yano-local-pc`), non solo target — distinzione mantenuta.
- Documenti consultati: `audit-manifest-16-09.json` (per primo), `prompts/audit-confidence-contract.md`, `playbooks/toolchain-readiness-audit.yaml`, `playbooks/audit-campaign.yaml`, `agents/capabilities.yaml`, `package.json`, `.mcp.json.example` (+ nomi `.mcp.json`), 7 `SKILL.md`, `mqtt/*.conf`, `test-all.mjs` head.
- File analizzati: come sopra + `bin/yano.mjs` via help/header (non rilettura integrale: manifest già lo indicizza a 450 righe).
- Approfondimenti aggiuntivi: nessuno oltre perimetro (no full-repo reread, per regola `no_duplicate_reading`).
- Non verificato: handshake MCP, pass/fail test, routing MQTT semantico, `kubectl` versione, token accounting.
- Verifiche rieseguite (exit 0 salvo noted): help/version/deps/playbook list+show+check/agent show/lint×2/docs-check/doctor/mcp/skills status/versioni binari/TCP broker.
