---
name: yano-code-review
description: "Yano adapter for Matt Pocock's two-axis code review: review Spec and Standards separately inside the existing worktree, report evidence, and preserve Yano's reviewer-to-planner workflow."
---

Use this checklist on every assigned Yano code review. It incorporates the
useful analysis model of Matt Pocock's `/code-review` without creating a second
orchestrator or nested reviewer agents.

## Required review axes

Review the change independently on both axes and keep the findings separate:

- **Spec**: ticket, originating request, specification, acceptance criteria,
  actual behavior, missing/partial requirements, wrong implementation and
  scope creep.
- **Standards**: repository instructions (`AGENTS.md`, `CONTRIBUTING.md`,
  architecture/domain docs, local lint/test configuration and established
  conventions), maintainability and relevant Fowler smell heuristics.

The smell baseline is: Mysterious Name, Duplicated Code, Feature Envy, Data
Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent
Change, Speculative Generality, Message Chains, Middle Man and Refused Bequest.
These are labelled, non-blocking heuristics. A documented repository rule wins;
a smell blocks only when it also causes a concrete behavior, security,
regression or maintainability failure.

## Fixed point and evidence

Yano already supplies an isolated `worktree_path`, so never ask the user for a
fixed point and never invent one. Resolve it in this order:

1. `base_commit` or `base_branch` in the assignment/report;
2. the worktree's recorded task base or merge-base against its integration
   branch;
3. a documented task branch/ref in the report.

Record the resolved ref/hash and the exact `git diff`/`git log` command in the
report. If no reliable base exists, say so and perform the Spec review against
the task contract and the Standards review against the current worktree; do not
pretend that a complete diff review was possible.

Do not spawn parallel sub-agents for the two axes. The dedicated reviewer,
MQTT messages and append-only report are Yano's traceable unit of work. Do not
commit, merge or call `worktree_finalize`; only the planner does that.

## Report contract

Append, never replace, the current round with these headings:

```markdown
## Spec
- Requirement/criterion:
- Evidence (file, function, test or observed behavior):
- Result: PASS / PARTIAL / FAIL
- Missing, incorrect or out-of-scope behavior:

## Standards
- Source consulted:
- Finding or smell heuristic:
- Severity: blocking / non-blocking
- Evidence and recommendation:

## Review baseline
- Fixed point/ref and diff commands, or why unavailable

## Verification
- Tests, commands, trace context and browser evidence

## Verdict
APPROVED / REJECTED
```

Route a rejection to the correct implementer with file/function,
expected-versus-observed behavior and reproducible evidence. Notify the
planner only after approval or when the retry/review loop is genuinely blocked.
