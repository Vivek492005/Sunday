# Sunday — agent-first coding IDE

Sunday is a VS Code-based, agent-first coding IDE. A built-in extension
(`sunday-agent`) talks to a TypeScript sidecar (`sundayd`) over JSON-RPC;
`sundayd` runs the agent loop against open models through a provider router
with a visible Relay fallback, and scales to hierarchical multi-agent work
(Orchestrator → Feature Agents → Verifier) with shadow-git checkpoints.

**Status: 0.1.0 dev preview.** See [CHANGELOG.md](CHANGELOG.md).

## Phase 8 features

Seven features built on the dev preview — see [docs/PHASE8.md](docs/PHASE8.md)
for details. Most are experimental and off by default.

- **Agent Manager part** — the ui-manager now opens as an editor-area panel
  (`sunday.manager.open`) or in a dedicated window (`sunday.manager.openWindow`).
- **Per-user daemon** — one `sundayd` per OS user on a shared socket
  (`~/.sunday/sundayd.sock`); single-flight startup via lockfile; per-workspace
  trust, MCP hubs, and secret namespaces (fail-closed).
- **Next-edit suggestions** (`sunday.nextEdit.enabled`) — after a rename,
  offers the next occurrence as a CodeLens.
- **Background agents** (`sunday.backgroundAgents.enabled`) — detached runs
  that survive editor close and deliver results as GitHub PRs (never
  auto-merged).
- **Voice** (`sunday.voice.inputEnabled` / `sunday.voice.outputEnabled`) —
  mic input and spoken responses via browser Web Speech APIs; no audio
  touches Sunday servers.
- **CLI** — `sunday chat|status|sessions` terminal frontend sharing the same
  daemon (`packages/sunday-cli`).
- **Hosted gateway** — optional OpenAI-compatible text-chat server with abuse
  controls (API-key auth, rate limits, audit logging) for users without their
  own provider keys (`packages/hosted-gateway`).

## Install (Windows)

1. Download `Sunday-Agent-Setup-0.1.0.exe` from the
   [releases page](https://github.com/Vivek492005/Sunday/releases).
2. Run it — it installs the `sunday-agent` extension into VS Code.
3. Open VS Code, set your provider keys (`OPENROUTER_API_KEY` /
   `GROQ_API_KEY`), and open the Sunday Chat view.

Or install the `.vsix` directly:
`code --install-extension sunday-agent-0.1.0.vsix`

## Layout

| Dir | What |
|---|---|
| `packages/protocol` | Shared types + JSON-RPC schemas (zod), versioned |
| `packages/gateway` | Provider adapters (OpenRouter, Groq), registry, router, relay, rate-limit scheduler |
| `packages/sundayd` | Sidecar: sessions, agent loop, policy, checkpoints, orchestration host, artifacts |
| `packages/tools` | Tool implementations: fs, search, edit, terminal-proxy, git |
| `packages/context` | Repo map, chunker, TF-IDF retrieval, `context/*` methods |
| `packages/browserd` | Managed browser child (FakeDriver / lazy Playwright) + `browser_*` tools |
| `packages/orchestrator` | Hierarchical orchestration: plan validation, budget, verifier |
| `packages/ext-agent` | Built-in VS Code extension (esbuild bundle) |
| `packages/ui-chat` | React chat webview |
| `packages/ui-manager` | React Agent Manager webview |
| `packages/sunday-cli` | `sunday` terminal frontend for the per-user daemon (Phase 8) |
| `packages/hosted-gateway` | Optional OpenAI-compatible chat server with abuse controls (Phase 8) |
| `packages/eval` | Benchmark harness + fixtures (`sunday-eval run`) |
| `patches/` | PATCHES.md — register of every upstream VS Code edit |
| `packaging/` | Windows NSIS installer script |
| `scripts/` | `package-vsix.mjs`, `sync-builtin.sh` |
| `docs/` | Architecture, eval, packaging, naming |

## Develop

Requires Node ≥ 22 and pnpm.

```sh
pnpm install
pnpm -r --workspace-concurrency=1 build   # sequential: parallel tsc OOMs on small VMs
pnpm -r --workspace-concurrency=1 test
```

Run the benchmark: `pnpm --filter @sunday/eval eval`

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[SECURITY.md](SECURITY.md).

## Naming

The project was renamed AURORA → SUNDAY. Mapping: [docs/NAMING.md](docs/NAMING.md).
