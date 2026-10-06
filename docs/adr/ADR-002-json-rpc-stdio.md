# ADR-002: JSON-RPC over stdio as the transport

**Status:** Accepted

**Context:** `sundayd` and its clients (VS Code extension, CLI, JetBrains plugin) need a language-agnostic RPC protocol. Candidates were JSON-RPC over stdio, gRPC, WebSockets, and a custom binary protocol.

**Decision:** JSON-RPC 2.0 over stdio (newline-delimited JSON frames).

**Alternatives considered:**
- *gRPC*: Rejected — heavier toolchain (protoc, codegen) for marginal benefit at our message sizes; harder to debug by hand.
- *WebSocket*: Rejected — requires port management and firewall exceptions; overkill for a local single-user daemon.
- *Custom binary*: Rejected — no tooling ecosystem, harder to inspect, no schema story.

**Consequences:**
- (+) Every language can speak it; debugging is `echo | jq`.
- (+) No ports, no firewall prompts, no TLS needed locally.
- (−) Stdio framing must be implemented carefully (see fuzz tests for the parser).
- (−) Throughput ceiling is lower than binary — acceptable for agent workloads.

**Revisit when:** Message throughput becomes a measured bottleneck (profile first), or we need browser-based clients that can't do stdio.
