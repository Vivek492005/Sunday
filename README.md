# Sunday — product workspace

An agent-first coding IDE, forked from VS Code (Code-OSS), powered by an
open-model router and a hierarchical multi-agent orchestration layer.

This directory is the **product workspace**. In the final layout it lives at
`sunday/` inside the fork of `microsoft/vscode` (see `docs/NAMING.md`).
Full design: `../user/files/merged_step1.md` (product name there reads AURORA —
see `docs/NAMING.md` for the rename mapping).

## Layout

| Dir | What |
|---|---|
| `packages/protocol` | Shared types + JSON-RPC schemas (zod), versioned (§23) |
| `packages/gateway` | Provider adapters, registry, router, relay, rate-limit scheduler (§10) |
| `packages/sundayd` | Sidecar: sessions, agent loop, policy, checkpoints, artifacts (§9) |
| `packages/tools` | Tool implementations: fs, search, edit, terminal-proxy, git, web, mcp (§12) |
| `packages/context` | Repo map (tree-sitter), indexer, retrieval, compaction (§11) |
| `packages/browserd` | Playwright/CDP controller (Phase 6, §18) |
| `packages/ext-agent` | Built-in extension, prebuilt with esbuild (§6.3) |
| `packages/ui-chat` | React app for the chat webview (§20.3) |
| `packages/ui-manager` | React app for the Agent Manager (§20.4) |
| `packages/eval` | Benchmark harness + fixtures (§24.2) |
| `patches/` | PATCHES.md — register of every upstream edit (§26) |
| `scripts/` | sync-builtin, packaging/release helpers |

## Build

Requires Node ≥ 22 and pnpm. `pnpm install && pnpm -r build`.
