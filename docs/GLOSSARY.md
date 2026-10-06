# Sunday Glossary

Project-specific vocabulary, defined in one place.

| Term | Definition |
|---|---|
| **Feature Agent** | A worker agent spawned by the orchestrator to complete a bounded subtask with its own context bundle. |
| **Orchestrator** | The hierarchical task coordinator that decomposes work by context and manages parallel Feature Agents. |
| **Relay** | The component that routes agent requests across providers (OpenRouter, Groq) for rate-limit resilience. |
| **sundayd** | The per-user daemon process (Node.js) that hosts sessions, the agent loop, tools, and MCP. Speaks JSON-RPC over stdio. |
| **sunday-agent** | The VS Code extension that provides the chat UI, agent manager, and editor integrations. |
| **Verifier** | The final single agent that validates merged results from parallel Feature Agents. |
| **Worktree isolation** | Each Feature Agent works in its own git worktree to avoid file conflicts. |
| **MCP** | Model Context Protocol — a standard for connecting external tools/data to the agent. |
| **Taint tracking** | SEC-09 mechanism: marks untrusted content and escalates state-changing calls to manual approval. |
| **Checkpoint** | An event-sourced snapshot of session state, enabling crash recovery. |
| **Autopilot** | The autonomous mode where the agent plans, acts, and verifies with minimal intervention. |
| **Skill** | A project-scoped capability bundle (prompts, scripts, rules) loaded with trust gating. |
