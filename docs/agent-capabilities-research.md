# Agent capability research and roster decision

## Decision

The active core is exactly nine roles: `planner`, `coder`, `reviewer`,
`frontend-developer`, `frontend-reviewer`, `docs-sync`, `tdd-agent`,
`architecture-diagrammer`, and `security-evaluator`.

The remaining sixteen roles are specialists with `activation: lazy`. They are
not members of `core`; the planner selects and launches them only when the
task requires their capability. `postman-collection-creator` was merged into
`openapi-writer`, because an API contract and its executable collection are
one delivery surface. `risk-assessor` was removed: its passive observation
overlapped planner/reviewer and had no deterministic artifact or gate. A
future risk check should be a planner policy/checklist instead.

## Capability policy

`agents/roles.yaml` is the source of truth for each role's `skills`, `cli`, and
`mcp`. Every resolved specialist prompt receives the same capability contract.
`yano init` and `yano doctor` verify only the core prerequisites. When the
planner launches a lazy role through `yano start --role`, the launch gate
installs known missing skills/CLIs, verifies declared MCP servers, and aborts
before any worktree mutation if a prerequisite cannot be satisfied. Unknown
OS-level tools are reported with a manual installation hint rather than
silently guessed or installed with elevated privileges.

## Selected official tooling

| Area | Selection | Why |
|---|---|---|
| Browser workflows | Microsoft Playwright CLI + Playwright Test; Chrome DevTools MCP for deep browser diagnostics | CLI is token-efficient for agent loops; MCP remains useful for console/network/performance inspection. |
| Containers | Docker CLI / Compose | Native build, inspect, compose, and runtime diagnostics. |
| Kubernetes | `kubectl` + Helm | Declarative cluster operations plus chart packaging. |
| GitHub delivery | `gh` + GitHub MCP | Deterministic repository, PR, release, and Actions operations. |
| API contracts | OpenAPI + Redocly CLI; Postman CLI when a collection/run is requested | Contract linting/bundling remains separate from executable collection runs. |
| Database specialists | Stack-native migration CLI; MongoDB MCP only for MongoDB projects | Avoids pretending every project has the same persistence layer. |
| Security | Semgrep where available plus dependency audit and repository checks | SAST and dependency checks complement, rather than duplicate, reviewer checks. |
| Mutation | Stryker (or the project's native mutation runner) | Measures whether tests detect behavioral mutations; distinct from TDD. |

## Official sources

- [Microsoft Playwright CLI](https://github.com/microsoft/playwright-cli)
- [Playwright Test: writing tests](https://playwright.dev/docs/writing-tests)
- [Playwright Test: running/debugging](https://playwright.dev/docs/running-tests)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Docker CLI reference](https://docs.docker.com/reference/cli/docker/)
- [Kubernetes `kubectl` reference](https://kubernetes.io/docs/reference/kubectl/)
- [Helm documentation](https://helm.sh/docs/)
- [GitHub CLI manual](https://cli.github.com/manual/)
- [GitHub Actions reference](https://docs.github.com/en/actions/reference)
- [OpenAPI Specification](https://spec.openapis.org/oas/)
- [Redocly CLI](https://redocly.com/docs/cli)
- [Postman CLI installation](https://learning.postman.com/docs/postman-cli/postman-cli-installation/)
- [MongoDB MCP Server](https://www.mongodb.com/docs/mcp-server/get-started/)
- [Stryker JS getting started](https://stryker-mutator.io/docs/stryker-js/getting-started/)

## Further optimizations

1. Add a capability registry with version constraints and checksums, so a role
   can declare not only a command name but the exact supported version range.
2. Store an installation manifest per project and emit a machine-readable
   capability report in every run; this makes failures explainable and avoids
   repeated network checks.
3. Add a planner budget: at most one specialist per capability family per
   phase, unless the plan explicitly records why two are needed.
4. Turn API and database specialists into stack-conditional roles: do not
   offer MongoDB MCP or Helm when the repository has no MongoDB/Kubernetes
   evidence.
5. Add a final capability audit to `docs-sync`, including the exact commands
   and versions used by each specialist.
