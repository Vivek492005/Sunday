# Awesome-list submission targets — Sunday

Status: **drafts — submit after v1.0.0-beta.1 assets are final and the
extension is published** (some lists require a marketplace link or a stable
release). Each entry below gives the repo, where Sunday fits, the exact
markdown line to add, and PR notes.

---

## 1. e2b-dev/awesome-ai-agents

- **Repo:** https://github.com/e2b-dev/awesome-ai-agents
- **Why:** the canonical "awesome" list for AI agents; has coding-agent
  sections. Highest visibility per effort.
- **Section:** the coding/dev-tools agent section (match the list's current
  headings at submission time).
- **Entry format** (follow the list's existing table/bullet style):
  ```markdown
  - [Sunday](https://github.com/Vivek492005/Sunday) - Open-source, agent-first coding IDE (Apache-2.0). Parallel agents with conflict detection, hierarchical orchestration, browser agent, MCP support. Windows/Linux/macOS.
  ```
- **PR notes:** fork → edit README.md → PR titled `Add Sunday`. Keep the
  description to one line like neighboring entries.

## 2. kyrolabs/awesome-agents

- **Repo:** https://github.com/kyrolabs/awesome-agents
- **Why:** explicitly lists "AI agents for terminal, browser, and editor
  tasks" — Sunday covers all three (CLI, browser agent, IDE).
- **Section:** editor/IDE agents (or the closest current heading).
- **Entry format:**
  ```markdown
  - [Sunday](https://github.com/Vivek492005/Sunday) - Agent-first coding IDE with parallel-agent orchestration, browser agent (screencast/takeover), and MCP support. Apache-2.0.
  ```
- **PR notes:** same flow — fork, add under the right heading, one-line
  description, PR titled `Add Sunday`.

## 3. devilking7x/awesome-ai-devtools

- **Repo:** https://github.com/devilking7x/awesome-ai-devtools
- **Why:** curated list of AI-powered developer tools; recently maintained
  (active in 2026). Good fit for the IDE + CLI.
- **Section:** AI coding assistants / IDEs.
- **Entry format:**
  ```markdown
  - [Sunday](https://github.com/Vivek492005/Sunday) — Open-source agent-first coding IDE (Apache-2.0, beta). Hierarchical orchestration, parallel agents, OpenRouter/Groq BYOK + Ollama fallback.
  ```
- **PR notes:** follow the list's bullet style exactly (it uses `—` separators
  in some sections — match the neighbors).

## 4. viatsko/awesome-vscode

- **Repo:** https://github.com/viatsko/awesome-vscode
- **Why:** 28k+ stars, the definitive VS Code list. Sunday ships a
  `sunday-agent` VSIX extension — listable once published.
- **Section:** Uncategorized (or Productivity) — entries are marketplace links.
- **Entry format:**
  ```markdown
  - [Sunday Agent](https://open-vsx.org/extension/sunday/sunday-agent) - The agent itself: parallel agents, orchestration UI, browser panel. (Apache-2.0)
  ```
- **PR notes:** ⚠️ **only after the extension is published to Open VSX**
  (currently pending). The list expects installable extensions; a repo-only
  link will likely be rejected. PR titled `Add Sunday Agent extension`.

---

## Submission checklist (per list)

1. Fork the list repo.
2. Add the entry in the correct section, matching neighboring formatting
   exactly (dashes, casing, trailing periods).
3. Keep it to one line — awesome-list maintainers reject marketing copy.
4. PR title: `Add Sunday` (or `Add Sunday Agent extension` for #4).
5. PR body: one sentence on what it is + link. Nothing more.
6. Don't submit #4 until the OpenVSX publish is live.
