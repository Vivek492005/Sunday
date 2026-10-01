# Sunday Sandbox Execution

Agent-run shell commands (`run_terminal`: builds, tests, scripts) execute on
the host by default. Sandbox mode runs them inside a disposable, restricted
environment instead. This is a v1: the goal is to blunt the two cheapest
attacks — exfiltration over the network and accidental host damage — while
staying dependency-free (we shell out to the `docker` / `bwrap` CLIs).

## Modes

| Mode | Value of `sunday.sandbox.mode` | Isolation |
|---|---|---|
| `off` (default) | host | None — current behavior, unchanged. |
| `docker` | disposable container | Container filesystem (only the workspace is mounted, at `/work`); **network fully disabled** (`--network none`); container removed after each run (`--rm`). |
| `bubblewrap` | Linux `bwrap` | Unshared network namespace (`--unshare-net`); host root mounted **read-only**; only the workspace is writable (bound at `/work`); dies with the parent. |

### What is isolated in v1

- **Network**: off in both sandboxed modes. `docker` uses `--network none`;
  `bubblewrap` uses `--unshare-net`. There is no per-command network
  allowlist yet — a command that needs the network must run with mode `off`.
- **Filesystem (docker)**: the container sees only its image plus the
  workspace bind-mount. Host files outside the workspace are invisible.
- **Filesystem (bubblewrap)**: the host root is visible but **read-only**;
  only the workspace bind-mount (and `/tmp`, `/dev`, `/proc`) is writable.
  This is weaker than docker — treat it as "accident containment", not a
  security boundary against a motivated attacker.
- **Processes**: bwrap gets `--die-with-parent`; docker containers are
  `--rm` and are best-effort `docker kill`-ed on timeout/abort.

### What is NOT isolated in v1 (limitations)

- No CPU/memory limits are set on either mode.
- `docker` mode always disables networking — even for commands the user
  explicitly approved for network access. (Per-command network approval is
  future work.)
- No macOS seatbelt profile yet — macOS users should use `docker` mode.
- `bubblewrap` is Linux-only.
- In `docker` mode the image must already exist locally: we pass
  `--pull never` so a missing image fails fast instead of pulling over the
  network. Run `docker pull <image>` once on the host.
- Environment variables are not passed into the container (v1); commands
  run with the image's default environment.

## Enabling

VS Code settings (applied on the next sidecar restart):

```jsonc
{
  "sunday.sandbox.mode": "docker",          // "off" | "docker" | "bubblewrap"
  "sunday.sandbox.dockerImage": "node:22-alpine"  // default: "alpine:latest"
}
```

The extension stamps `SUNDAY_SANDBOX_MODE` / `SUNDAY_SANDBOX_DOCKER_IMAGE`
into the sundayd child's environment; sundayd parses them in
`sandboxConfigFromEnv()` (`packages/sundayd/src/sandbox.ts`) and the agent
loop stamps the resulting config on every tool context. `run_terminal`
(`packages/tools/src/terminal.ts`) is the single decision point: when the
mode isn't `off` the command is routed to `runSandboxed()`
(`packages/tools/src/sandbox.ts`).

An invalid mode value fails closed: sundayd throws at startup rather than
silently running unsandboxed.

## Requirements per mode

- **docker**: Docker Desktop (or Docker Engine) installed, `docker` on PATH,
  and the configured image pulled locally. Verify: `docker --version` and
  `docker images`.
- **bubblewrap**: Linux with `bwrap` installed
  (e.g. `sudo apt install bubblewrap` on Debian/Ubuntu). Verify:
  `bwrap --version`. Unprivileged user namespaces must be enabled
  (default on most distros).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `sandbox mode "docker" is enabled but the docker CLI was not found` | Install Docker Desktop, ensure `docker` is on PATH, restart the sidecar (or the window). |
| `docker run failed (exit 125)` + `docker pull <image>` hint | Image not present locally — `docker pull <image>` once on the host. |
| `sandbox mode "bubblewrap" is enabled but \`bwrap\` was not found` | `sudo apt install bubblewrap` (Debian/Ubuntu), restart the sidecar. |
| `bwrap: Failed to mount …` / namespace errors | Kernel blocks unprivileged user namespaces — enable them (distro-specific) or use `docker` mode. |
| `sandbox mode "bubblewrap" is only supported on Linux` | On macOS/Windows use `docker` mode. |
| `invalid SUNDAY_SANDBOX_MODE="…"` at daemon startup | Typo in `sunday.sandbox.mode`; valid values: `off`, `docker`, `bubblewrap`. |

## Testing

`packages/tools/src/sandbox.test.ts` covers flag construction (pure
functions, no docker/bwrap needed), availability detection with an injected
probe, fallback error messages, and the `run_terminal` decision point.
`packages/sundayd/src/sandbox.test.ts` covers env parsing (including the
fail-closed invalid-mode behavior).
