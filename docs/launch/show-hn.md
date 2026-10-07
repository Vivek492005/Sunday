# Show HN draft — Sunday v1.0.0-beta.1

> Post as: **Show HN: Sunday – the agent-first coding IDE**
> Link: https://github.com/Vivek492005/Sunday
> Site: https://vivek492005.github.io/Sunday/
> Timing: weekday morning US time. Reply to every comment.

---

Hi HN, I'm the solo developer behind Sunday. It's an open-source (Apache-2.0),
agent-first coding IDE — currently in public beta (v1.0.0-beta.1) with Windows,
Linux, and macOS installers.

The premise: most AI coding tools are a chatbot bolted onto an editor. Sunday
flips it — the agent *is* the IDE. You hand off tasks; agents plan, edit code,
run commands, run tests, and iterate until done.

What's actually novel (not just marketing):

- **Parallel agents.** One task, multiple agents working at once. Bounded
  execution pool (~3), an `owns_paths` overlap gate so two agents can't silently
  edit the same files, a deferred merge phase with conflict detection, and a
  single final verifier. State is checkpointed so an orchestration survives a
  daemon restart.
- **Hierarchical orchestration.** Tasks are decomposed by *context*, not by job
  title. A coordinator plans, feature agents each get exactly the context they
  need, a verifier reviews. This is what keeps multi-file refactors coherent
  where a single-agent loop drifts.
- **Browser agent.** A real agent that sees the web: live screencast in a
  sidebar panel, takeover mode, recorded sessions. Opt-in, file:// and private
  IPs blocked, approval-once-per-origin.
- **Security as architecture.** Taint tracking on tool results (untrusted output
  escalates state-changing calls to manual approval), credential gating,
  sub-agent policy enforcement. Published STRIDE-lite threat model and a
  CycloneDX SBOM are in the repo — I wanted the security story reviewable, not
  asserted.

Practical stuff: OpenRouter + Groq out of the box (BYOK, keys in env vars only),
Ollama fallback for autocomplete when APIs rate-limit you, MCP servers (stdio +
HTTP), project skills with trust gating. 800+ tests green, 1-hour soak test
passed, ADRs in the repo.

Honest beta caveats: the Windows installer doesn't yet preinstall the agent
extension (one manual VSIX step for now), the JetBrains plugin is paused while
the IDE fork is the focus, and some release gates (screen-reader pass, packet
capture) are still human-pending. It's beta — rough edges included.

Tech: TypeScript monorepo (pnpm), per-user daemon (`sundayd`) over a local
socket speaking JSON-RPC, VS Code 1.140 base for the fork.

I'd genuinely like feedback on the orchestration model — does hierarchical beat
single-agent-loop for your multi-file tasks? And if you try the beta, tell me
what breaks. That's the fastest way to make it better.
