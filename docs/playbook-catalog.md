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
| `backend-change` | coder, reviewer, refactoring-specialist | tests, isolated diff, separate Spec/Standards review, classified findings |
| `frontend-browser` | frontend-developer, frontend-reviewer, e2e-simulator, a11y-tester, design-to-code | separate UI Spec/Standards review, Playwright run, browser snapshot/trace, console/network checks |
| `qa-hardening` | tdd-agent, mutation-tester | baseline tests, mutation/E2E result, reproducible findings |
| `platform-delivery` | dockerizer, k8s-orchestrator, cicd-architect, cost-optimizer | build/manifest/pipeline validation and explicit environment evidence |
| `data-api-contract` | schema-migrator, data-seeder, openapi-writer | detected stack, migration/spec validation, safe fixtures |
| `security-review` | security-evaluator, dependency-health | scanner/audit evidence, concrete finding or clean result |
| `documentation-release` | docs-sync, architecture-diagrammer, release-notes-writer | source-to-doc diff, examples/diagram/changelog verification |
| `performance-observability` | observability-agent, speed-benchmarker | before/after measurements with units, environment and sample context |
| `architect-provisioning` | architect | proposal scope, capability readiness, watcher validation, user feedback and explicit promotion evidence |

The `architect` role is global rather than project-scoped. It stages generated
playbooks and roles under `temp/architect/proposals/`, validates every declared
skill/CLI/MCP before operation, and promotes immutable versions only into the
global `temp/catalog/` after a healthy watcher round and positive planner/user
feedback. See [`yano-architect.md`](yano-architect.md).

## Universal gates

Every playbook requires: declared scope, verified starting state, reproducible
evidence, automated checks, classified errors, a recoverable change, and a
report artifact. Missing prerequisites stop the phase; they are never silently
substituted.

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

The detailed source research is maintained in
`docs/agent-capabilities-research.md`; the gates are based on first-party
documentation for [Playwright](https://playwright.dev/docs/running-tests),
[Docker](https://docs.docker.com/reference/cli/docker/),
[Kubernetes](https://kubernetes.io/docs/reference/kubectl/),
[GitHub Actions](https://docs.github.com/en/actions/reference),
[OpenAPI](https://spec.openapis.org/oas/latest.html), and
[OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/).
