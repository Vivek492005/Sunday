# Sunday Agent — JetBrains Plugin

JetBrains frontend for the Sunday agent (Phase 8 "JetBrains/CLI frontends" —
the CLI half shipped as `packages/sunday-cli`; this is the JetBrains half).

Works in IntelliJ IDEA, PyCharm, WebStorm, and other IntelliJ Platform IDEs
(build 241+, i.e. 2024.1 and newer).

## What it does

- **Sunday tool window** (right anchor): streaming chat with the Sunday agent.
- **Open Sunday Chat** action (`Tools` menu, `Ctrl+Alt+S`): opens the tool window.
- **Send Selection to Sunday** (editor popup, `Ctrl+Alt+G`): sends the current
  selection (or current line) to chat as a code block.
- **Explain Code with Sunday** (editor popup): asks Sunday to explain the selection.

All of it is backed by the **shared per-user sundayd daemon** — the same
daemon the VS Code extension and the `sunday` CLI use. The plugin speaks the
existing socket protocol (NDJSON JSON-RPC over `~/.sunday/sundayd.sock`,
Windows named pipe); no new protocol was invented.

## Architecture

```
packages/jetbrains-plugin/src/main/kotlin/com/sunday/agent/
├── daemon/
│   ├── DaemonPaths.kt        # socket path conventions (mirrors @sunday/protocol)
│   ├── JsonRpc.kt            # NDJSON framing + chat/event parsing
│   ├── DaemonTransport.kt    # unix socket (POSIX) / named pipe (Windows)
│   └── SundayDaemonClient.kt # connect (single-flight) + hello + request/notify
├── services/
│   └── SundayProjectService.kt # per-project client + session + chat listeners
├── toolwindow/
│   ├── SundayToolWindowFactory.kt
│   └── ChatPanel.kt            # Swing chat UI (streams text-delta live)
└── actions/
    └── SundayActions.kt        # open chat / send selection / explain code
```

Protocol flow (same as the CLI, `packages/sunday-cli/src/client.ts`):

1. `connect()` — attach to the live daemon socket, or win the lockfile
   mutex (`~/.sunday/sundayd.lock`) and spawn `sundayd --socket`.
2. `sunday/hello` — `{protocolVersion: 1, client: {name, version, os}}`.
3. `daemon/configure` — `{workspaceRoot, trusted}` for the open project.
4. `session/create` → `chat/send` — streams back as `chat/event`
   notifications (`text-delta`, `tool-call`, `turn-end`, …).

## Prerequisites

- JDK 17+ and Gradle 8.x (or use the wrapper once downloaded).
- A `sundayd` daemon binary available as `sundayd` on `PATH`, or set
  `SUNDAY_DAEMON_PATH` to its full path. (The VS Code extension bundles
  sundayd; the JetBrains plugin reuses your existing install.)
- IntelliJ IDEA Community 2024.3+ (or any 241+ JetBrains IDE) to run/debug.

## Build

```bash
cd packages/jetbrains-plugin
./gradlew buildPlugin        # produces build/distributions/sunday-jetbrains-plugin-0.1.0.zip
```

Install in your IDE via **Settings → Plugins → ⚙ → Install Plugin from Disk**,
then restart. Open **Tools → Open Sunday Chat** (or `Ctrl+Alt+S`).

### Run tests

```bash
./gradlew test   # JUnit5: DaemonPathsTest + JsonRpcTest (no IDE needed for these)
```

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `SUNDAY_DAEMON_PATH` env | `sundayd` on `PATH` | Daemon executable to spawn when none is listening |
| Socket | `~/.sunday/sundayd.sock` (POSIX) / `\\.\pipe\sundayd-<user>` (Windows) | Shared per-user daemon socket (same as CLI/VS Code) |

## Limitations (current)

- **Not compiled on this VM** — no JDK/Gradle here; the full source,
  `build.gradle.kts`, `plugin.xml`, tests and docs are in place, but the
  first real compile must happen on a machine with JDK 17 + Gradle
  (or in CI with the IntelliJ plugin).
- **No bundled sundayd** — unlike the VS Code extension (which ships the
  daemon), the plugin expects `sundayd` on `PATH`/`SUNDAY_DAEMON_PATH`.
  Bundling a JRE + node sidecar is future work.
- **Chat UI is Swing text**, not a webview — markdown rendering, diff views
  and inline completions are not ported (VS Code extension only).
- **No MCP / skills UI** — the daemon exposes them; the plugin just doesn't
  surface panels for them yet.
- Voice input/output is not implemented (web-only in the VS Code extension).
- `until-build` is capped at `251.*`; bump when testing newer IDEs.

## Protocol compatibility

`JsonRpc.PROTOCOL_VERSION = 1` must track
`packages/protocol/src/version.ts` (`PROTOCOL_VERSION`). The unit test
`protocol version matches sundayd` pins the current value so a drift fails
loudly.
