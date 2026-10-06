# ADR-005: Context-centric hierarchical orchestration

**Status:** Accepted

**Context:** For multi-file tasks, a single agent loop accumulates too much context and loses coherence. The decomposition strategy matters: by job title ("you're the frontend dev"), by file, or by context ("here's everything needed for this subtask, nothing more").

**Decision:** The parallel orchestrator decomposes work by **context**, not by role or title. Each Feature Agent receives a self-contained context bundle (relevant files, symbols, constraints, acceptance criteria) and owns a set of paths; a deferred merge phase reconciles overlaps with conflict detection.

**Alternatives considered:**
- *Role-based decomposition* ("frontend agent", "backend agent"): Rejected — roles don't map to real task boundaries; agents duplicate exploration.
- *Single-agent with bigger context window*: Rejected — coherence degrades and cost explodes on large tasks.
- *File-per-agent*: Rejected — real tasks cut across files; ownership must be by coherent change-set, not file count.

**Consequences:**
- (+) Measurable: the eval harness can compare orchestration ON vs OFF on identical tasks.
- (+) Bounded blast radius per agent; merge conflicts are explicit, not silent.
- (−) More moving parts: scheduler, checkpointing, conflict resolution.
- (−) The advantage is currently asserted, not yet published as numbers (see Path-to-10 §5).

**Revisit when:** The orchestration benchmark shows no meaningful win on the eval tasks, or a fundamentally better decomposition strategy is demonstrated.
