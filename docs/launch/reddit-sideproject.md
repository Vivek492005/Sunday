# r/SideProject post draft — Sunday

> Title: **I built Sunday — an open-source, agent-first coding IDE (beta)**
> Subreddit: r/SideProject
> Link the repo + site in the body. Flair: "Project" if available.

---

**What I built:** Sunday — a coding IDE where the AI agent isn't a sidebar
chatbot, it's the core of the whole product. You hand off a task ("refactor the
auth module"), and agents plan, edit code, run commands, and run tests until
it's done. v1.0.0-beta.1 is out now with installers for Windows, Linux, and
macOS. Free and open source (Apache-2.0).

**Why I built it:** I kept hitting the same wall with AI coding assistants — a
single agent loop loses coherence the moment a task spans multiple files. It
forgets context, drifts, and I end up babysitting. I wanted an IDE designed
around *orchestration*: a coordinator that decomposes work by context, parallel
agents with conflict detection, and one final verifier. Plus a browser agent
that can actually see the web (live screencast, takeover mode), because so much
of real dev work ends in a browser.

**Tech stack:** TypeScript monorepo (pnpm workspaces), a per-user daemon
(`sundayd`) communicating over a local socket via JSON-RPC, VS Code 1.140 as
the editor base. Models via OpenRouter + Groq (bring your own key), with an
Ollama fallback for autocomplete when APIs rate-limit. MCP servers, project
skills, 800+ tests, published threat model + SBOM.

**Hardest part:** the orchestration merge phase — letting parallel agents work
on overlapping code without producing garbage. The `owns_paths` overlap gate +
deferred merge with conflict detection took several iterations. Also: Windows.
So much Windows. (There's a saga in the commit history.)

**What's next:** finish the human release gates (screen-reader pass, packet
capture), publish the CLI to npm and the extension to Open VSX, then a Show HN.
Longer term: local-model chat, not just autocomplete.

**Links:**
- Site/download: https://vivek492005.github.io/Sunday/
- GitHub: https://github.com/Vivek492005/Sunday

Happy to answer anything — especially skeptical questions about the
orchestration model. Try the beta and tell me what breaks. 🙏
