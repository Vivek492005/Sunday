# r/opensource post draft — Sunday

> Title: **Sunday — agent-first coding IDE, Apache-2.0, beta is out**
> Subreddit: r/opensource
> Lead with the license and the open-core philosophy. No marketing fluff.

---

Sunday is an open-source (Apache-2.0) coding IDE built around AI agents instead
of bolting a chatbot onto an editor. v1.0.0-beta.1 is out with Windows, Linux,
and macOS installers.

**The open-core commitment, stated plainly:** the whole product is free and
forkable — full IDE, full agent daemon, full orchestration, BYOK model access,
local Ollama routes. Nothing is crippled. If there's ever a paid layer, it
will sell managed infrastructure (hosted models, priority), never access to
something that's free elsewhere. The architecture already enforces this:
BYOK and local routes work with no account, offline, by design.

**What's actually in the repo** (beyond the code):

- `docs/THREAT_MODEL.md` — STRIDE-lite analysis, 12 findings, all addressed or
  tracked. Security reviewable, not asserted.
- `docs/sbom.json` — CycloneDX SBOM of dependencies.
- `docs/adr/` — Architecture Decision Records (why the daemon is per-user, why
  orchestration decomposes by context, etc.).
- `docs/PROVIDER_SETUP.md`, `SECURITY.md`, `PRIVACY.md`, `ACCESSIBILITY.md` —
  docs treated as a feature, not an afterthought.
- 800+ tests, 1-hour soak test report, CI on all three OSes.

**Technically interesting bits for this crowd:**

- Parallel agent orchestration: bounded pool, `owns_paths` overlap gate,
  deferred merge with conflict detection, single verifier, checkpoint/resume.
- Taint tracking on tool output → untrusted results escalate state-changing
  calls to manual approval (prompt-injection defense at the architecture
  level, not a filter list).
- MCP servers (stdio + Streamable HTTP) with trust gating; project skills with
  secret refusal in memory.
- Ollama fallback for autocomplete — survives provider rate limits locally.

**Status:** beta, solo-maintained, rough edges included (the Windows installer
doesn't preinstall the agent extension yet — one manual VSIX step). JetBrains
plugin is paused while the IDE fork is the focus.

**Contributing:** issues and PRs welcome; `CONTRIBUTING.md` in the repo.
Good first areas: docs, the paused JetBrains plugin, accessibility testing.

- https://github.com/Vivek492005/Sunday
- https://vivek492005.github.io/Sunday/
