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
| `clean-repo` | repo-curator, docs-sync, reviewer | itemized removal/relocation list justified per file, dangling-reference scan before and after, user approval before any deletion/move, missing docs created in the canonical categories with real content, reviewer approval; when using a structured `plan_set`, `repo-curator` is the dedicated phase-1 execution role |
| `frontend-browser` | frontend-developer, frontend-reviewer, e2e-simulator, a11y-tester, design-to-code | separate UI Spec/Standards review, mandatory E2E when runnable (or explicit skip evidence), browser snapshot/trace, console/network checks and Agentation gate |
| `qa-hardening` | tdd-agent, mutation-tester | baseline tests, mutation/E2E result, reproducible findings |
| `platform-delivery` | dockerizer, k8s-orchestrator, cicd-architect, cost-optimizer | build/manifest/pipeline validation and explicit environment evidence |
| `data-api-contract` | schema-migrator, data-seeder, openapi-writer | detected stack, migration/spec validation, safe fixtures |
| `security-review` | security-evaluator, dependency-health | scanner/audit evidence, concrete finding or clean result |
| `documentation-release` | docs-sync, architecture-diagrammer, release-notes-writer | source-to-doc diff, examples/diagram/changelog verification |
| `performance-observability` | observability-agent, speed-benchmarker | before/after measurements with units, environment and sample context |
| `ai-application-optimization` | ai-optimizer | AI inventory, token/context/latency/cost baseline, task granularity, model routing, quality guardrails and before/after verification |
| `architect-provisioning` | architect | proposal scope, capability readiness, watcher validation, user feedback and explicit promotion evidence |
| `knowledge-authoring` | market-researcher, seo-strategist, website-content-strategist, business-docs-author, business-docs-reviewer | catalog-first intent match, parameterized project context, research evidence, structured deliverables and review; variants `single-author`, `research-and-author`, `full-team` |
| `qa-full-audit` | qa-inventory-analyst, qa-functional-verifier (+ existing QA/security/perf specialists coordinated in parallel) | canonical command/feature matrix with source, PASS/FAIL/BLOCKED verdict and evidence per entry, full matrix re-run after remediation, zero open blocking findings; variants `quick-gate`, `full-audit`, `self-audit` |

The `architect` role is global rather than project-scoped. It stages generated
playbooks and roles under `<YANO_DATA_DIR>/architect/proposals/`, validates every declared
skill/CLI/MCP before operation, and promotes immutable versions only into the
global `<YANO_DATA_DIR>/catalog/` after a healthy watcher round and positive planner/user
feedback. See [`yano-architect.md`](../quick-guides/yano-architect.md).

## Universal gates

Every playbook also declares a machine-validated `contract`: sequential
execution, checkpoint cadence, evidence fields, report sections, bounded
budgets, verification mode and recovery strategy. Missing prerequisites stop
the phase; they are never silently substituted. The human-readable companion
documents live under [`docs/guides/playbooks/`](./playbooks/); they are usage
guides, not agent skills. Skills remain under `skills-vendor/`.

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
