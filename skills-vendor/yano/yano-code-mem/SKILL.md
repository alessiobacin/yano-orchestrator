---
name: yano-code-mem
description: Use Code Mem as Yano's required local project-memory layer. Recall the current project's durable context, search captured conversations, and record evidence-backed outcomes without leaking secrets.
---

# Yano Code Mem

Every project initialized by Yano has Code Mem under `memory/` and a local Pi
hook. Use this skill for project context before rediscovering prior work.

## Read first

At the beginning of planning, recovery, debugging, or a substantial task:

```bash
cm recall "<goal, incident, bug, or ticket>" --level 2 --mode hybrid
cm plan "<goal>"                         # optional: inspect retrieved context
cm sq "<exact phrase>"                   # only when locating prior conversation text
cm recent 12                             # recent durable records
```

`cm recall` is supplemental evidence: verify source files, tests, Yano tickets,
and current trace data before acting. It is scoped to the current project's
root, so never run it from a different project or from a task worktree.

## Record durable outcomes

```bash
cm save --kind decision --title "<decision>" "<reason, consequence, evidence>"
cm save --kind issue --title "<incident>" "<symptom, root cause, fix/next check>"
cm save --kind procedure --title "<procedure>" "<repeatable verified steps>"
```

- Include paths, test commands, ticket/run IDs, and observable evidence.
- Use `--global` only for knowledge that is genuinely valid across projects.
- Never save credentials, tokens, personal data, unverified guesses, or routine
  progress chatter.
- `MEMORY.md` and `USER.md` are generated projections; do not edit them as
  authoritative sources.

## Lifecycle

`yano init` runs `cm init pi`, which creates the memory store, installs the
project-local Pi skill/hook, and performs the first repository scan. The hook
is best-effort: a Code Mem failure must never prevent a Pi/Yano agent from
starting. Run `cm consolidate` after a completed debugging or implementation
cycle to keep recalled context compact.
