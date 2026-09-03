---
name: yano-observer-dry-run
description: Use whenever a user or Yano agent wants to preview, test, simulate, or run once in dry-run mode what Yano Auto-Improver, feedback, or Architect would recommend for a repository, feature suggestion, or missing playbook. Always use the smallest read-only Yano command and report that no worker, Herdr tab, audit, proposal, ticket, file, or external side effect was created.
---

# Yano observer dry-run

Use this skill to obtain an inspectable single-pass preview of external Yano
observers without turning the preview into real work. The output is evidence
for a planner or user decision, never authorization to modify a project.

## Safety contract

- Resolve the project root explicitly and use `--dry-run`, `--once`, or both.
- Do not call `start`, `resume`, `submit`, `propose`, `promote`, `install`, or
  any command that creates a real worker unless the user separately authorizes
  it after reviewing the preview.
- State the command, project, simulated input and whether the result is a
  deterministic preflight or an LLM recommendation.
- Redact secrets and do not copy raw user credentials or full trace prompts.

## Preview commands

### Auto-improver: repository improvement preview

```text
yano auto-improve start --project-root <dir> --once --dry-run --json
```

Report the evidence sources, detected test/build/lint surfaces, proposed audit
scope and any explicit limitation. It must not create an audit or Herdr tab.

### feedback: feature-request response preview

```text
yano feedback submit --project-root <dir> --title <title> --description <text> --queue-only --once --dry-run --json
```

If the installed CLI does not support a completely non-persistent submit
preview, stop and report that limitation rather than inserting a suggestion.

### Architect: missing-playbook preview

```text
yano architect assess --project-root <dir> --task <request> --json
yano architect propose --project-root <dir> --task <request> --new-playbook --dry-run --json
```

The assessment identifies catalog coverage; the dry-run proposal describes the
ephemeral playbook/roles that would be created. Never provision or promote in
a preview.

## Response format

```text
Preview: auto-improver | feedback | architect
Project: <root>
Input: <sanitized request>
Command: <exact command>
Would produce: <audit / analysis / proposal>
Would not do: no tabs, agents, tickets, project writes or promotion
Evidence and limitations: <short list>
Next decision: <only an explicit user approval can start real work>
```
