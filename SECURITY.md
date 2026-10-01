# Security Policy

## Threat model (summary)

Sunday runs an AI agent loop with tool access inside the user's workspace.
The design assumes the **model is untrusted input** and the **user's machine
is the trust boundary**:

- **Workspace confinement.** Every file tool is confined to the workspace
  root; path traversal outside it is rejected. The terminal proxy kills
  process trees on timeout (SIGKILL on the group; `taskkill /T /F` on Windows).
- **Policy gate.** Tools are allow/deny-listed per autonomy level; dangerous
  tools (`browser_*`, terminal) are opt-in and flagged. Approvals are required
  for destructive or out-of-policy actions.
- **Browser isolation.** The agent browser never touches the user's real
  browser profile or passwords. `file://` URLs are blocked, private IPs are
  blocked, and every first navigation to a new origin requires approval.
- **Secrets.** Provider API keys live in the environment / OS secret store and
  are never written to logs, session files, or checkpoints.
- **Checkpoints.** Shadow-git checkpoints live outside the user's repos
  (`~/.sunday/…`) so agent undo never rewrites project history silently;
  merges are `--no-ff` and conflicts abort loudly.
- **Supply chain.** Dependencies are pinned in `pnpm-lock.yaml`. The Windows
  installer is built on GitHub Actions from a tagged commit; verify the
  release tag matches before installing.

## Reporting a vulnerability

Open a GitHub issue titled `[security]` — or, for sensitive reports, open a
blank issue and ask for a private contact channel. Please include:

1. What you did (steps to reproduce),
2. What you expected vs. what happened,
3. The Sunday version (`sunday-agent` extension version / release tag).

We aim to acknowledge within 7 days. Do not open public proof-of-concept
exploits against other users' machines.
