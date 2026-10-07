# Why hierarchical orchestration?

*The problem single-agent loops can't solve, and how Sunday decomposes work
by context instead of job titles.*

---

## The wall every agent hits

Give a single AI agent a one-file task — "add validation to this form" — and
it does fine. Give it a real task — "split the auth module into per-route
middleware, update the callers, keep the tests green" — and something
predictable happens. It starts strong, then the context window fills with
half-read files, tool outputs, and its own earlier reasoning. By step 30 it's
making edits based on a stale mental model of the codebase. By step 50 it's
confidently wrong.

This isn't a model-quality problem. It's an architecture problem. A single
agent loop has one context budget, one thread of attention, and no division of
labor. Multi-file work is *inherently* parallelizable — different files,
different concerns, different expertise — but the single loop forces it all
through one bottleneck. The usual patches (bigger context windows, better
prompting, "just let it run longer") treat the symptom. The bottleneck is
structural.

## Decompose by context, not by job title

Most multi-agent designs decompose by role: a "planner", a "coder", a
"reviewer". That's org-chart thinking, and it has the same failure mode as the
single loop — the "coder" still ends up holding the entire task in one context.

Sunday's orchestrator decomposes by **context** instead. The question isn't
"who does what" but "what does each unit of work need to know?" A coordinator
breaks the goal into work units, and each unit is defined by the slice of the
codebase it touches and the information required to change it. A feature agent
working on the middleware extraction gets the auth module, the route
definitions, and the test expectations — not the billing code, not the UI
strings, not the coordinator's full plan. Narrow context is the whole point:
small, focused contexts stay coherent far longer than one giant one.

## The machinery

Concretely, an orchestration run looks like this:

1. **Plan.** The coordinator produces a plan: a set of work units, each with
   its inputs, expected outputs, and the paths it owns.
2. **Bounded pool.** Feature agents run in a bounded pool (around three). Not
   thirty — parallelism has a coordination cost, and the pool size is the
   throttle that keeps it manageable. Each unit gets its own abort controller,
   so one stuck agent doesn't wedge the run.
3. **The overlap gate.** Before a unit starts, its `owns_paths` are checked
   against every running unit. Overlap means conflict risk, so overlapping
   units don't run concurrently — they're sequenced. This is the single most
   important piece: it converts the hardest class of multi-agent bug (two
   agents silently editing the same file) into a scheduling decision.
4. **Deferred merge.** Agents don't merge as they finish. Completed units wait
   in a merge phase, where their changes are combined and conflict-checked as
   a batch. Merging one-at-a-time lets later merges invalidate earlier
   assumptions; batching the merge makes conflicts visible together, when
   they're cheapest to resolve.
5. **One verifier.** A single final verifier reviews the merged result
   against the original goal. One pair of eyes, full context of the *goal*
   (not the implementation details), accept or request fixes. No
   verifier-committee, no diffusion of responsibility.
6. **Checkpoint and resume.** Orchestration state is persisted
   (`~/.sunday/orchestrations/`), so a daemon restart doesn't lose the run —
   it reconciles and continues. Long-running multi-agent work that dies with
   the process is a toy; this is the difference.

The daemon exposes this over JSON-RPC (`orchestrate/run|stop|status|merge|
resolveConflict`), and the UI shows per-unit cards with live status plus
conflict cards when the merge phase needs a human decision.

## How this differs from the dominant paradigm

The dominant paradigm today — the one in Cursor, Copilot-style assistants,
and most agent harnesses — is the **single-agent loop**: one agent, one
conversation, one context, iterating tool calls until the task is done or the
user intervenes. It's excellent for the "help me with this function" shape of
work, because there's almost no coordination overhead. But it has no answer
for division of labor. When the task genuinely spans subsystems, the single
loop either serializes the work (slow, and context decays across the run) or
relies on the user to manually split it into subtasks (which is just making
the human the orchestrator).

Hierarchical orchestration inverts the default: parallelism and decomposition
are the primitive, and the single-agent case is just an orchestration with one
unit. The cost is coordination machinery — the overlap gate, the merge phase,
the verifier — and the honest tradeoff is that for small tasks this machinery
is overhead. That's why the coordinator is allowed to produce single-unit
plans: orchestration should *degrade* to a single agent gracefully, not force
a committee onto a typo fix.

There's also a philosophical difference worth naming. Single-loop tools tend to
optimize for *responsiveness* — keep the user in the loop, stream progress,
ask often. Orchestration optimizes for *autonomy* — hand off the goal, get
back a verified result. Different shapes of work want different defaults, and
an IDE should offer both rather than pretending one loop fits all.

## "Why not just a bigger context window?"

It's the obvious objection, so let's take it seriously. Context windows keep
growing — 200K, 1M tokens — so why not pour the whole repo into one agent and
skip the machinery? Three reasons.

First, **retrieval isn't comprehension.** A model that *can* see a million
tokens doesn't *attend* to them equally. The well-documented "lost in the
middle" effect means attention concentrates at the start and end of the
context; the auth module you read 40 steps ago is effectively gone. Bigger
windows delay the decay, they don't remove it. Narrow contexts sidestep the
problem entirely: the agent's whole world is the slice it owns, so nothing
important is ever "in the middle."

Second, **cost scales with context.** Every tool call in a bloated context
re-sends the whole thing. Ten agents with 8K contexts each are dramatically
cheaper per step than one agent dragging 200K tokens through fifty turns —
and the bill for agentic coding is per-token, not per-task. Orchestration is,
among other things, a cost-control strategy.

Third, **coherence is about structure, not size.** Human teams don't put the
entire company in one meeting to fix a bug; they form a small team with a
clear scope and a reviewer. The coordinator/agent/verifier split mirrors what
actually works in human engineering organizations. Bigger whiteboards never
fixed bad meeting structure.

## Limits, honestly stated

This is beta software, so here's what the model doesn't yet do: the merge
phase's conflict detection is structural (overlapping paths, conflicting
edits), not semantic — two agents can still make logically incompatible
changes to *different* files, and that's what the verifier is for. The pool
size is a static default, not yet adaptive to task shape. And orchestration
across a daemon restart reconciles known runs; truly arbitrary crash recovery
is still on the roadmap.

But the core claim has held up in testing: for multi-file tasks, narrow
contexts plus a real merge phase beat one giant context every time. The
benchmark harness (`@sunday/eval`) includes parallel-vs-single comparisons,
and the plan is to publish those numbers rather than assert them.

---

*Sunday is open source (Apache-2.0). The orchestrator lives in
`packages/orchestrator`, the daemon RPCs in `packages/sundayd`, and the
design decisions in `docs/adr/`. Try the beta and tell us where the model
breaks: https://github.com/Vivek492005/Sunday*
