# Sunday Daemon (`sundayd`) — Lifecycle

`sundayd` is the per-user Sunday sidecar daemon: it owns agent sessions,
the model router, tool execution, MCP hubs, and orchestration runs, and
speaks JSON-RPC over stdio (extension-owned) or a per-user socket
(shared multi-window mode).

This document covers the daemon lifecycle: how it starts, when it stops,
and how to make it start automatically at login.

## Startup

### On demand (default)

The VS Code extension spawns `sundayd` automatically when it activates
(`sunday.sidecar.autoStart`, default `true`):

- **Single window / stdio mode** — the extension spawns `sundayd` over
  stdio pipes and owns its lifecycle. When the last VS Code window closes,
  stdin closes and the daemon exits.
- **Multi-window / socket mode** — the first window wins a per-user
  lockfile mutex (`~/.sunday/sundayd.lock`) and spawns one *shared*
  daemon on the well-known socket (`~/.sunday/sundayd.sock` on POSIX,
  `\\.\pipe\sundayd-<user>` on Windows). Later windows attach to the
  same daemon instead of spawning their own (single-flight).

The CLI also starts a daemon directly:

```bash
sundayd                          # stdio mode (extension-style)
sundayd --socket /tmp/sundayd.sock  # socket mode
```

### Autostart at login (Stage 4)

`--install-autostart` writes a platform autostart entry that launches the
shared per-user daemon at login. `--uninstall-autostart` removes it.
Nothing is ever installed implicitly — this is strictly opt-in.

```bash
sundayd --install-autostart
sundayd --uninstall-autostart
```

| Platform | Entry | Location |
|----------|-------|----------|
| Linux | systemd user unit | `~/.config/systemd/user/sundayd.service` |
| macOS | launchd agent | `~/Library/LaunchAgents/com.sunday.sundayd.plist` |
| Windows | scheduled-task XML | `~/.sunday/sundayd-autostart.xml` (import with `schtasks`) |

After installing, follow the printed enable command:

```bash
# Linux
systemctl --user daemon-reload && systemctl --user enable --now sundayd.service
# macOS
launchctl load ~/Library/LaunchAgents/com.sunday.sundayd.plist
# Windows (PowerShell, as your user)
schtasks /Create /TN "Sunday sundayd" /XML "$HOME\.sunday\sundayd-autostart.xml" /F
```

**Windows alternative — registry Run key:** instead of the scheduled
task, add a `REG_SZ` value (e.g. `SundayDaemon`) under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` with data
`"<node.exe>" "<path\to\sundayd\dist\cli.js>" --socket "\\.\pipe\sundayd-<user>"`.
The scheduled-task XML is preferred because it supports
`MultipleInstancesPolicy=IgnoreNew` (never double-starts after a crash +
respawn race).

**Crash recovery:** the systemd unit uses `Restart=on-failure` and the
launchd agent uses `KeepAlive` with `SuccessfulExit=false` — crashes
restart the daemon, but a *clean* exit (including the idle shutdown
below) is never restarted.

## Shutdown

### Idle shutdown (Stage 4)

In socket mode the daemon exits cleanly (exit 0) after a configurable
period of inactivity — but only when there is genuinely nothing to do:

- zero connected socket clients, **and**
- zero active (in-memory, un-closed) sessions.

Any JSON-RPC request resets the idle clock. The shutdown reason is logged
to stderr (`[sundayd] idle shutdown: idle for 31 min (timeout 30 min, …)`).

| Setting | Default | Effect |
|---------|---------|--------|
| `sunday.daemon.idleTimeoutMinutes` | `30` | Minutes of inactivity before exit. `0` = disabled. |

The extension stamps the value as `SUNDAY_DAEMON_IDLE_TIMEOUT_MINUTES`
at spawn (applies on the next sidecar restart). The CLI flag
`--idle-timeout-minutes <n>` overrides both for manual runs.

In stdio mode the single client is the owning parent, so the timer can
never fire there — the parent owns the lifecycle.

`daemon/status` reports live idle state for observability:

```json
{ "idle": { "idleMs": 12345, "clients": 2, "activeSessions": 1 } }
```

### Explicit shutdown

- `sunday/shutdown` RPC → graceful exit (drains session persists first).
- `SIGTERM` / `SIGINT` in socket mode → graceful exit.
- stdin close in stdio mode → graceful exit.

All paths drain in-flight session writes before exiting, so a shutdown
can never truncate a session file.

## Notifications

The daemon emits server→client notifications over the transport:

| Method | Contents |
|--------|----------|
| `chat/event` | Per-turn agent events (`text-delta`, `tool-call`, `tool-result`, `turn-end`, `turn-error`), plus `via: 'relay'` on provider failover |
| `orchestrate/event` | Orchestration run lifecycle |
| `background/event` | Background agent progress / PR creation |

In socket mode notifications fan out to every connected client.

### Per-workspace routing (Stage 4)

`chat/event` notifications carry an optional `workspaceRoot` (the
session's `cwd`). Each VS Code window runs its own extension host, so the
extension uses it to decide whether a *popup* belongs to the current
window: events for other workspaces still update their session's chat
view, but don't pop up here.

### Notification level (Stage 4)

| Setting | Default | Effect |
|---------|---------|--------|
| `sunday.notifications.level` | `"all"` | Which daemon notifications surface as VS Code popups: `all` = everything; `important` = turn errors and provider-relay failovers only; `none` = suppress popups (the chat view still updates). |

## Files

| Path | Purpose |
|------|---------|
| `~/.sunday/sundayd.sock` | Well-known per-user socket (POSIX) |
| `\\.\pipe\sundayd-<user>` | Well-known per-user named pipe (Windows) |
| `~/.sunday/sundayd.lock` | Single-flight spawn mutex (0600) |
| `~/.sunday/sessions/` | Session files, one JSON per session (0600) |
| `~/.sunday/sundayd.log` | launchd stdout/stderr capture (macOS autostart) |
