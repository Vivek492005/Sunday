# Troubleshooting

Organized by symptom. All fixes reference the actual code/config keys —
no generic advice.

## Sidecar won't start

**Symptom:** "Sunday sidecar is not running" / "could not start sundayd" /
"SidecarNotFoundError: sundayd not found".

The extension resolves the launch command in this order
(`packages/ext-agent/src/sidecar.ts` → `resolveSidecarCommand`):

1. `sunday.sidecar.path` setting (explicit override — point it at your
   `sundayd.mjs` / `cli.js` if the bundle layout is custom).
2. Bundled next to the extension: `<ext>/sundayd/sundayd.mjs`
   (this is where `scripts/package-vsix.mjs` puts it).
3. Dev workspace: `packages/sundayd/dist/cli.js` (requires
   `pnpm -r build` first).
4. `sundayd` on PATH.

**Fixes:**

- If `sunday.sidecar.autoStart` is `false`, the sidecar never starts on
  its own — run `Sunday: Restart Sidecar` from the command palette.
- If you installed from a stale `.vsix`, reinstall; the staged layout
  must contain `sundayd/sundayd.mjs` (vsce packaging step).
- Dev: run `pnpm -r --workspace-concurrency=1 build` (sequential — the
  parallel build OOMs small machines), then restart the sidecar.
- Crash loop: the extension shows "Sunday sidecar crashed repeatedly"
  with a **Restart Sidecar** button. Check the *Sunday* output channel
  for the spawn error (ENOENT/EACCES point at the discovery order above).

## protocol mismatch

**Symptom:** `ProtocolMismatchError` on connect.

The extension and `sundayd` negotiate `PROTOCOL_VERSION` in `sunday/hello`
(`@sunday/protocol`). This means the extension bundle and the sidecar
bundle are from different builds (e.g. `sunday.sidecar.path` pointing at
an old checkout while the extension updated). Rebuild both from the same
commit, or clear the `sunday.sidecar.path` override to use the bundled
sidecar.

## Provider 401 / missing key

**Symptom:** `missing API key: set OPENROUTER_API_KEY in the environment`
(or `GROQ_API_KEY`).

Provider keys are read from the **process environment** only
(`packages/gateway/src/providers.ts`). Settings/SecretStorage are not
consulted for provider keys.

**Fixes:**

- Windows: set the **user** env var (`OPENROUTER_API_KEY` /
  `GROQ_API_KEY`) and **fully re-launch VS Code** — a running VS Code
  will not see a variable added afterwards. Then `Sunday: Restart
  Sidecar` (the sidecar inherits env at spawn time).
- Verify the key itself in the provider console (OpenRouter:
  openrouter.ai/settings/keys; Groq: console.groq.com → API Keys).
- A pasted key with trailing whitespace is trimmed by the code; a key
  wrapped in quotes (`"sk-or-..."`) is not — paste it bare.

## Provider 429 / Relay marker

**Symptom:** chat shows a **Relay** fallback marker, requests pause, then
resume.

This is the designed free-tier behavior, not a bug:
`packages/gateway/src/router.ts` fails over to the next provider in
registry order on 429/5xx, and `scheduler.ts` parks the rate-limited
provider+model in cooldown (honoring `Retry-After`). When all providers
are exhausted you see the Relay marker with auto-resume.

**Fixes:** wait for the cooldown, add a key for the second provider so
failover has somewhere to go, or switch to a paid model with higher
limits. To reproduce deterministically, the eval harness has a fake
provider that forces 429s.

## MCP server fails to start

**Symptom:** MCP panel shows the server red; tools never appear.

- `Sunday MCP: Start Server…` spawns the configured command. Check the
  server command/args in your `mcp.json` — the #1 cause is a bad path or
  a missing `npx`/`node` on PATH in the VS Code-spawned environment.
- Secret references `secret:<key>` in `mcp.json` resolve from VS Code
  **SecretStorage**; a missing key fails with `secret "<key>" is not in
  SecretStorage — store it with the "MCP: Store Secret" command`. Run
  `Sunday MCP: Store Secret…`, then restart the sidecar (secrets are
  passed as `SUNDAY_MCP_SECRET_*` env at spawn).
- `mcp.json` lives per workspace; MCP/skill loading requires workspace
  trust — run `Sunday: Trust Workspace for MCP/Skills` if the server
  list is empty on an untrusted folder.
- Tool names are namespaced `mcp__server__tool`; the per-server tool cap
  may hide tools on very large servers (use `tool_search`-style listing
  in the MCP panel).

## Browser: "browser is disabled"

**Symptom:** `browser_*` tools or the Agent Browser panel report
`browser is disabled — set sunday.browser.enabled to true to opt in`.

The browser is **opt-in and off by default**
(`packages/sundayd/src/browserd.ts`, `browser-tools.ts`):

1. Set `sunday.browser.enabled: true` in VS Code settings.
2. **Restart the sidecar** — the setting is read at spawn time into
   `SUNDAY_BROWSER_ENABLED=1` (`packages/ext-agent/src/extension.ts`
   `extraEnv()`).
3. While a user has taken over the browser (`Take over` in the panel),
   agent `browser_*` actions throw `BrowserTakeover (-32006)` — click
   **Resume** in the panel to hand control back.
4. `file://` URLs and private IP ranges are blocked by policy and will
   stay blocked — that is not a configuration problem.

## Orchestration: "unknown run" after restart

**Symptom:** `orchestrate/*` or `resolveConflict` throws `RunNotFound
(-32005)` / "unknown run".

Known gap (documented in the parallel-agents phase): orchestration state
lives in `~/.sunday/orchestrations/` and is restart-safe for listing, but
`orchestrate`/`resolveConflict` against a run from a previous daemon
session throws unknown-run. Fix: re-run the orchestration from the
current session; conflict resolution must happen before a sidecar
restart.

## Ghost-text autocomplete not appearing

**Symptom:** no inline suggestions.

- Check `sunday.completion.enabled` (default on) and
  `sunday.completion.model` (default: fast/cheap mirror of the sundayd
  default).
- Autocomplete needs a provider key like everything else (401s surface
  in the chat panel, not as ghost text).
- Only models with FIM support give native infill
  (`qwen/qwen-2.5-coder-32b-instruct` on OpenRouter); other models fall
  back to a prefix-only chat continuation, which is slower and may look
  like nothing is happening on a rate-limited free tier.

## Webview shows "Sunday chat UI not found"

**Symptom:** `Sunday chat UI not found. Looked for index.html in: …`
(`chatView.ts` / `managerView.ts`).

The extension looks for `ui-chat/dist/index.html` and
`ui-manager/dist/index.html` relative to the extension dir. In dev this
means `pnpm -r build` hasn't produced the webview bundles; in a packaged
`.vsix` it means the staging step dropped them. Re-run the build /
re-package with `scripts/package-vsix.mjs`.

## Getting logs

- **Extension:** the *Sunday* output channel (View → Output → Sunday).
- **Sidecar:** spawned with piped stdio; JSON-RPC traffic and daemon
  errors surface in the same output channel.
- **Smoke test (no VS Code):**
  `printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' |
  node <stage>/sundayd/sundayd.mjs`
