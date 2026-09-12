# Playbook catalog

Every role in `agents/roles.yaml` points to a validated YAML playbook. The
planner binds the selected file before executing the run; the checksum makes
the bound contract immutable. The YAML files intentionally share the runtime
states and differ in gates and failure routes, so a task uses one coherent
workflow instead of launching every specialist.

## Mapping

| Playbook | Roles | Required evidence |
|---|---|---|
| `default.yaml` (`default-orchestration`) | planner | objective, approved `to-tickets` breakdown, team/phase plan, approvals, final evidence |
| `conversation` | planner, optionally one `conversation-researcher` | objective classified as open discussion/no delivery intent yet; when needed, one bounded read-only consultation may initialize the Yano DB but never creates worktree/run/plan/ticket/repository state; on crystallization, the recommended delivery playbook is presented and confirmed or declined before a brand-new run starts — this run never rebinds its own `playbook_bind` |
| `debate` | debater (2+ instances, planner as moderator) | topic framed, explicit user gate on roster/stance/model@provider-id (with revision loop), every opening argument independent, every rebuttal collected, synthesis naming agreement/disagreement per debater/model; watcher rejects conversation-researcher substitution or completion below the minimum roster |
| `get-the-best-from` | repo-benchmarker (2 instances) | reference repo URL confirmed, both analyses independent with file/line citations, side-by-side comparison presented, concrete import candidates with license/attribution flagged when relevant |
| `backend-change` | coder, reviewer | tests, isolated diff, separate Spec/Standards review, classified findings |
| `refactor` | refactoring-specialist, reviewer | baseline full test-suite run before any change, no new feature/behavior change, full test-suite rerun after (not only touched files), reviewer approval, explicit before/after non-regression evidence in report |
| `design-redesign` | design-redesign-specialist (planner-facing), frontend-reviewer when implementation/review is included | discovery of repository/app, Stitch remoto e `.stitch` locale prima delle domande; lo specialista inoltra al planner solo decisioni di design irrisolte; evidenze sincronizzate Stitch/.stitch/codice prima dell'implementazione |
| `clean-repo` | repo-curator, docs-sync, reviewer | itemized removal/relocation list justified per file, dangling-reference scan before and after, user approval before any deletion/move, missing docs created in the canonical categories with real content, reviewer approval; when using a structured `plan_set`, `repo-curator` is the dedicated phase-1 execution role |
| `frontend-browser` | frontend-developer, frontend-reviewer, e2e-simulator, a11y-tester, design-to-code | separate UI Spec/Standards review, mandatory E2E when runnable (or explicit skip evidence), browser snapshot/trace, console/network checks and Agentation gate |
| `full-stack-developer` | full-stack-developer, full-stack-reviewer (or full-stack-developer alone for explicitly justified low-risk work) | one owner for bounded frontend/backend changes, proportional review topology, backend + browser/E2E evidence, docs sync and Agentation gate when UI exists |
| `qa-hardening` | tdd-agent, mutation-tester | baseline tests, mutation/E2E result, reproducible findings |
| `platform-delivery` | dockerizer, k8s-orchestrator, cicd-architect, cost-optimizer | build/manifest/pipeline validation and explicit environment evidence |
| `data-api-contract` | schema-migrator, data-seeder, openapi-writer | detected stack, migration/spec validation, safe fixtures |
| `security-review` | security-evaluator, dependency-health | scanner/audit evidence, concrete finding or clean result |
| `documentation-release` | docs-sync, architecture-diagrammer, release-notes-writer | source-to-doc diff, examples/diagram/changelog verification |
| `performance-observability` | observability-agent, speed-benchmarker | before/after measurements with units, environment and sample context |
| `performance-optimization-loop` | planner + speed-benchmarker, coder, reviewer, qa-functional-verifier, docs-sync | two isolated worktrees, repeated baseline/candidate benchmark, latency/token/context/cost/quality comparison, plateau and stop counters, report for every round and promotion |
| `ai-application-optimization` | ai-optimizer | AI inventory, token/context/latency/cost baseline, task granularity, model routing, quality guardrails and before/after verification |
| `architect-provisioning` | architect | proposal scope, capability readiness, watcher validation, user feedback and explicit promotion evidence |
| `knowledge-authoring` | market-researcher, seo-strategist, website-content-strategist, business-docs-author, business-docs-reviewer | catalog-first intent match, parameterized project context, research evidence, structured deliverables and review; variants `single-author`, `research-and-author`, `full-team` |
| `qa-full-audit` | qa-inventory-analyst, qa-functional-verifier (+ existing QA/security/perf specialists coordinated in parallel) | canonical command/feature matrix with source, PASS/FAIL/BLOCKED verdict and evidence per entry, full matrix re-run after remediation, zero open blocking findings; variants `quick-gate`, `full-audit`, `self-audit` |
| `audit-campaign` | repo-cartographer, toolchain-evaluator, test-adequacy-analyst, architecture-health-reviewer, automation-control-auditor, product-ux-analyst, audit-synthesizer | one shared manifest, chapter DAG, cross-review and separate implementation DAG; variants `standard`, `medium`, `deep`; resource ledger per chapter |
| `architecture-health-audit` | architecture-health-reviewer, maintainability-reviewer, refactor-planner | boundaries, coupling, complexity, duplication, dead-code candidates, oversized files and behavior-preserving refactor seams |
| `test-adequacy-audit` | test-adequacy-analyst, qa-functional-verifier, mutation-tester | use-case-to-test mapping, human expectation, negative paths, persistence/cross-command effects and mutation signal |
| `toolchain-readiness-audit` | repo-cartographer, toolchain-evaluator, delegation-efficiency-auditor | CLI/MCP/skill/script/playbook inventory, safe probes, readiness and fallbacks |
| `automation-control-audit` | automation-control-auditor, observability-reviewer, delegation-efficiency-auditor | retries, timeouts, state propagation, logging, trace correlation and deterministic opportunities |
| `ai-delegation-audit` | delegation-efficiency-auditor, observability-reviewer | D0/D1/AI classification, baseline measurements and guarded script migrations |

The `architect` role is global rather than project-scoped. It stages generated
playbooks and roles under `<YANO_DATA_DIR>/architect/proposals/`, validates every declared
skill/CLI/MCP before operation, and promotes immutable versions only into the
global `<YANO_DATA_DIR>/catalog/` after a healthy watcher round and positive planner/user
feedback. See [`yano-architect.md`](../quick-guides/yano-architect.md).

### Audit campaign composition

`audit-campaign` è il playbook parent quando la richiesta attraversa due o più
assi. Esegue una discovery una sola volta, condivide `audit-manifest.json`,
esegue i capitoli indipendenti in parallelo solo dopo approvazione, sblocca i
capitoli dipendenti quando gli input esistono e crea una implementation DAG solo
dopo la cross-review. I playbook specialistici restano riusabili singolarmente
con le varianti `standard`, `medium` e `deep`. Ogni relazione distingue
`evidence_confidence` dalla `judgment_confidence` dell'LLM e conserva una
motivazione breve della seconda; `confidence` resta l'alias retrocompatibile
della confidenza nelle evidenze.

```text
node scripts/audit-manifest.mjs --project-root <dir> --output audit-manifest.json
node scripts/audit-delegation.mjs --manifest audit-manifest.json --output delegation.json
node scripts/audit-resource-ledger.mjs --trace-root <YANO_DATA_DIR>/traces --project <name>
```

Il ledger conserva modello/provider, turni, inference round, tempi, token,
chiamate deterministiche e retry per capitolo; valori non esposti restano
`unknown` e non vengono inventati.

## Universal gates

Every playbook also declares a machine-validated `contract`: sequential
execution, checkpoint cadence, evidence fields, report sections, bounded
budgets, verification mode and recovery strategy. Missing prerequisites stop
the phase; they are never silently substituted. The human-readable companion
documents live under [`docs/guides/playbooks/`](./playbooks/); they are usage
guides, not agent skills. Skills remain under `skills-vendor/`.

### Parallel execution gate

Parallel task/team execution is always opt-in. When the Planner detects
independent work, it must present the candidate tasks, collision check,
separate instances/worktrees, models and the applicable concurrency limit in
the same proposal as the team/model confirmation, then ask separately for
explicit approval to run in parallel. Confirming the team or models alone is
not approval for parallelism. Without that approval the Planner runs the work
serially; it must not spawn the additional planner/team or create its
worktree/tickets. The current operational limit is two parallel tasks per
hour, unless the user explicitly changes it.

## User REST APIs

REST API esterne o interne registrate dall’utente sono capability configurabili,
non default Yano. `yano api` mantiene un registro globale e uno per progetto;
il runtime espone agli agenti solo la vista effective del progetto. Le chiamate
passano dal tool `api_request`, che limita origin, metodi, path e credenziali.
La descrizione aiuta l’agente a decidere la pertinenza, ma non autorizza
endpoint inventati o modifiche non approvate.

## Catalog-first rule

Architect must run `yano architect assess` before proposing a new playbook. An
exact match is reused without copying artifacts into the project. A missing
match becomes a global, project-agnostic proposal. The user interview is
mandatory for a new proposal and records whether the first operational variant
is single-agent, multi-agent or selected by the Planner. The Architect owns
the generic team contract; the Planner owns the task-specific variant,
parallelism and instance count.

Before creating any capability, Architect also performs documented online
research through configured open-source MCPs. The preferred pairing is
[`mcp-searxng`](https://github.com/mcp/ihor-sokoliuk/mcp-searxng) for search and
the [official MCP Fetch server](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)
for page extraction. SearXNG needs a configured SearXNG instance; Fetch must be
restricted to approved external URLs because its upstream documentation warns
about access to local/internal addresses. Missing research MCPs produce a
blocked/pending record, never an invented conclusion.

For development and mixed tasks, the planner's `to-spec` → `to-tickets` output
is the required human planning boundary. The approved Markdown tickets are
imported once into SQLite/DAG; runtime scheduling never reads the Markdown
files directly.

## Specialist checklists

- Backend/TDD: failing tests first where TDD is selected; cover nominal,
  error, boundary and authorization cases; refactor only with a green suite;
  reviewer approval is mandatory. Reviewer reports `Spec` and `Standards`
  separately and treats Fowler smell findings as heuristics unless a repository
  rule or concrete regression makes them blocking.
- Frontend: use role/label/test-id locators, web-first assertions, no arbitrary
  sleeps, headless CI execution, and collect trace/screenshot on failure.
  Frontend reviewer compares the requested UI behavior with the real browser
  result under separate `Spec` and `Standards` sections.
- QA/mutation: distinguish killed, survived, timeout and no-coverage mutants;
  do not delete tests to improve a score; classify flaky tests explicitly.
- Platform: validate Docker builds/scans, non-root images, immutable tags,
  Kubernetes dry-run/rollout and Helm lint/template; never apply production
  changes without approval.
- API/data: detect the actual stack, validate OpenAPI and breaking changes,
  keep collections generated or synchronized, test migration rollback or its
  compensating strategy, and never use real PII in fixtures.
- Security: check auth boundaries, injection, secrets, dependency CVEs and
  sensitive logging; critical findings block release and secrets are never
  printed.
- Documentation/release: verify commands and examples against current code,
  distinguish breaking changes, and publish only after user confirmation.
- Performance/observability: record baseline, units, dataset, cold/warm state,
  p50/p95/p99 or frontend web vitals where applicable; never claim an
  improvement without a numeric comparison.
- Quality gate: map every documented command/flag/endpoint before testing;
  never guess an expected result without a traceable source; classify
  BLOCKED (missing prerequisite/capability) separately from FAIL (real
  defect); route every blocking finding through the normal coder/reviewer or
  frontend-developer/frontend-reviewer cycle — this playbook never
  implements fixes itself; re-run the full matrix (not only the fixed
  items) before declaring the gate clean; when the reference project is
  Yano itself, run its existing internal test/lint suite first
  (`npm test`, `npm run lint:capabilities`, `npm run lint:playbooks`,
  `npm run check-skill-isolation`, `npm run check-syntax`, `yano doctor`)
  and use the matrix only to close the gaps that suite does not cover
  (documentation-vs-behavior drift, untested flag combinations). Testing a
  command in isolation is not enough: for every command that mutates
  persistent or shared state, the matrix declares which other commands'
  expected output changes as a consequence (e.g. `yano init` must change
  what `yano projects`/`yano fleet` report), and verification snapshots
  those downstream commands before and after, in an isolated deterministic
  sandbox, comparing the observed delta against the declared one — a
  correct direct result with a missing or wrong downstream propagation is
  a FAIL, not a pass with a caveat.

The detailed source research is maintained in
`docs/notes/agent-capabilities-research.md`; the gates are based on first-party
documentation for [Playwright](https://playwright.dev/docs/running-tests),
[Docker](https://docs.docker.com/reference/cli/docker/),
[Kubernetes](https://kubernetes.io/docs/reference/kubectl/),
[GitHub Actions](https://docs.github.com/en/actions/reference),
[OpenAPI](https://spec.openapis.org/oas/latest.html), and
[OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/).
