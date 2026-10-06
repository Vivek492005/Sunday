# ADR-001: Daemon-per-user process model

**Status:** Accepted

**Context:** Sunday needs a persistent backend (sundayd) that manages sessions, tools, and provider calls. The key question was whether to run one daemon per user (a long-lived process owned by the user) or embed the agent logic directly in the extension host / spawn per-request.

**Decision:** Run `sundayd` as a single long-lived daemon process per user, communicating over JSON-RPC via stdio.

**Alternatives considered:**
- *In-extension-process agent*: Rejected — the extension host is killed/restarted by VS Code unpredictably; long-running orchestrations would lose state.
- *Per-request serverless-style invocation*: Rejected — session state, checkpoints, and tool approvals need a persistent home; cold-start per request would be slow and state management would move to the client.

**Consequences:**
- (+) Sessions survive extension reloads; checkpoints are durable.
- (+) One clear process to monitor, log, and soak-test.
- (−) The daemon must handle crash recovery explicitly (see ADR follow-up / crash-recovery test).
- (−) Windows service/daemon lifecycle needs extra care (Stage 4 revert incident).

**Revisit when:** We ship a hosted/multi-user offering where per-user processes don't map cleanly to containers, or if VS Code's extension host gains a reliable background-task API.
