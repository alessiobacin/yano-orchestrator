---
name: yano-ai-optimization
description: Evidence-first optimization of AI applications: context, token use, task granularity, model routing, latency, reliability, quality and cost.
---

# Yano AI application optimization

Use this skill when a project embeds LLMs, agents, retrieval, embeddings or
other AI calls and the goal is to improve performance, context efficiency,
quality, reliability or cost. This is an optimization audit and experiment
protocol; it does not replace `yano-auto-improvement` (which is a broad,
read-only project audit) or `yano-model-advisor` (which recommends models from
the available catalog).

## Non-negotiable truthfulness

Be direct. Do not invent metrics, prices, model capabilities, test results,
file contents or improvements. Mark each conclusion FACT, INFERENCE or
HYPOTHESIS and attach a source, command or limitation. Give every finding and
recommendation a score X/10, a short rationale and confidence X/10.

## Sequential protocol

1. Read the short project memory and linked `docs/` documents first. Query
   code-mem for orientation before opening broad source trees. Read source only
   when the current question needs it; expand the scope incrementally.
2. Inventory AI entry points, providers, prompts, context assembly, retrieval,
   tools, retries, caches, streaming, tests and observability. Record absent
   evidence as unknown.
3. Establish a reproducible baseline. Prefer the project's existing tests and
   fixtures. Capture input/output tokens, context size, latency (p50/p95 when
   possible), errors/retries, estimated cost and a quality/golden-set result.
   State sample size, environment and units.
4. Evaluate context reduction without semantic loss: project-memory-first
   retrieval, relevant-file selection, deduplication, summarization boundaries,
   prompt caching and tool output limits. Never recommend truncation solely
   because it saves tokens.
5. Evaluate task granularity: identify oversized prompts, independent work,
   unnecessary round trips and missing checkpoints. Compare orchestration cost
   and quality, not just number of calls.
6. Evaluate model routing using `yano model-advisor` and the live catalog when
   available. Compare capability, latency, quality, context window and price.
   Do not assume a cheaper model is adequate; recommend a fallback and a
   measurable acceptance threshold.
7. Evaluate runtime controls: concurrency, retries, timeouts, caching,
   batching, streaming and observability. Check privacy, rate limits and
   failure behavior.
8. Propose bounded experiments. Each experiment has hypothesis, exact change,
   baseline, success threshold, rollback, affected commands/workflows and
   score/confidence. Ask the planner for approval before provider, dependency,
   budget or production changes.
9. After implementation, repeat the same benchmark and affected cross-command
   workflows. Accept only a verified improvement with no unapproved quality or
   reliability regression. Hand the planner a concise report and update
   applicable docs through the normal documentation-sync gate.

## Report shape

Use: executive summary; AI surface inventory; baseline; scored findings;
experiments; before/after table; quality and safety guardrails; cost model;
limitations; exact next tasks for the planner. Keep raw traces out of the
prompt unless needed; point to their paths instead.
