# Privacy Audit: Telemetry, Updates, Crash Reporting & Third-Party Dependencies

**Date:** 2026-10-07 | **Auditor:** privacy-engineering subagent | **Method:** read-only, code-only (no docs)
**Scope:** `vscode/product.json` + vendored VS Code 1.140.0 source, `packages/ext-agent/src`, `packages/sundayd/src`,
`packages/hosted-gateway/src` (telemetry-relevant parts), bundled `vscode/extensions/`, package manifests,
CI build workflow.

---

## 1. Telemetry: DISABLED (in the packaged build)

**`vscode/product.json` (46 keys total) contains no telemetry configuration:**
- No `enableTelemetry`, no `aiConfig` (App Insights / 1DS key), no `tasConfig` (experiments endpoint),
  no `surveyUrl`, no `msftInternalDomains`. Grep for `"enableTelemetry"|"aiConfig"|"tasConfig"|"surveyUrl"`
  across `product.json` → zero hits.
- The only telemetry-flavored key is `agentsTelemetryAppName: "agents"`. In code it is used exactly once,
  as a string label: `src/vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts:533`
  passes it as `appHost` in telemetry metadata of extension-host events. With no telemetry destination,
  this label goes nowhere. Dead config — recommend removing.

**Why nothing is sent (code path, built/packaged build):**
1. `supportsTelemetry()` — `vscode/src/vs/platform/telemetry/common/telemetryUtils.ts:96-102`:
   for built builds it returns `!(disableTelemetry || !productService.enableTelemetry)`. With
   `enableTelemetry` absent → **false**.
2. `vscode/src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts:338-360`:
   when `supportsTelemetry` is false, the service is replaced with `NullTelemetryService`
   (`telemetryLevel = NONE`, all `publicLog*` no-ops) and `NullAppender`. No network appender exists.
3. The Microsoft OneCollector appender (`https://mobile.events.data.microsoft.com/OneCollector/1.0`,
   `1dsAppender.ts:22`) is only instantiated at `sharedProcessMain.ts:342-343` inside
   `if (!isLoggingOnly(...) && productService.aiConfig?.ariaKey)` — `aiConfig` is absent, so this branch
   never executes. The endpoint URL exists in source but is never fetched.
4. Experiments (TAS): `experimentsEnabled()` in
   `vscode/src/vs/workbench/services/telemetry/common/workbenchTelemetryUtils.ts` requires
   `!!productService.tasConfig` — absent → the TAS client is never constructed, no assignment
   network calls. (Note `assignmentService.ts:493` does `this.productService.tasConfig!` but that
   line is only reachable when `experimentsEnabled` is true, so no crash.)

**Custom Sunday code:** grep of `packages/ext-agent/src` and `packages/sundayd/src` for
`telemetry|analytics|track(|trackEvent|amplitude|segment|mixpanel|posthog` → **no hits**
(the only matches were false positives like "path segment" in `browser-media.ts` and "prefix on a
segment boundary" in `trust.ts`).

**Hosted gateway (first-party operational logging, not third-party telemetry):**
`packages/hosted-gateway/src/audit.ts` writes one JSON line per request (to a file or stdout on
Sunday's own infra): timestamp, request id, **truncated SHA-256 key fingerprint (never the secret)**,
**client IP**, method, path, model, status, latency, estimated token counts. Message content is never
logged — only sizes. OAuth endpoints used by `social-auth.ts` are the standard user-info endpoints:
`api.github.com`, `www.googleapis.com`, `graph.microsoft.com` (user-initiated sign-in only).
Retention/deletion of this log is the gateway-retention auditor's scope — but note it contains client IPs.

**Residual UI:** the Settings UI still exposes `telemetry.telemetryLevel` and
`telemetry.enableCrashReporter`. They control a telemetry pipeline with no destination — the settings
imply a working control that does nothing externally. Recommend hiding/removing them.

---

## 2. Update mechanism: DISABLED — no phone-home

- `vscode/product.json` has **no `updateUrl`** (and no `commit` injection found in the build workflow).
- `vscode/src/vs/platform/update/electron-main/abstractUpdateService.ts:206-208`: constructor checks
  `if (!this.productService.updateUrl || !this.productService.commit)` → permanently disables the
  service ("updates are disabled as there is no update URL"). No update check is ever scheduled;
  the IDE never phones home for updates.
- What *would* be sent if an `updateUrl` were added (for reference, `createUpdateURL` + `getUpdateRequestHeaders`,
  abstractUpdateService.ts:40-71): `GET <updateUrl>/api/update/<platform>/<quality>/<commit>?bg=true&u=<internalOrg>`
  with `User-Agent: Code/<version> Darwin/<kernel>` or `Windows NT <release>`. No machine id in the URL itself.
- `packages/sunday-cli/src`, `sundayd/src`, `ext-agent/src`: no update-check code found.
- Trade-off to flag: users currently get **zero** automatic or even manual in-app updates — new releases
  require manual download. Either add a Sunday-owned `updateUrl` (then audit what that endpoint collects)
  or document the manual-update process clearly.

---

## 3. Crash reporting: INERT — no destination configured

- `vscode/product.json` has **no `crashReporter` block** (the supported shape is `{companyName, productName}` per
  `src/vs/base/common/product.ts:196`).
- A tree-wide grep for `crashReporter.start(` across `vscode/src/vs/` → **no calls**. A grep for `submitURL` →
  **no hits anywhere**. Electron's crash reporter therefore has no upload destination and cannot submit anything.
- Residual: `app.ts` `updateCrashReporterEnablement()` (line 1871) still generates a `crash-reporter-id` UUID and
  writes `enable-crash-reporter` into `argv.json` based on `telemetry.telemetryLevel >= CRASH`, but with no
  reporter started and telemetry nulled, this ID is never transmitted.
- Recommend: remove/hide `telemetry.enableCrashReporter` from the settings UI so the product doesn't imply
  a crash pipeline that doesn't exist; if crash reporting is wanted, wire an explicit Sunday-owned endpoint.

---

## 4. Third-party dependencies & hardcoded network calls

**npm deps:** scanned `dependencies`/`devDependencies` of all 16 `packages/*/package.json` for
analytics/telemetry/updater SDK names (`analytics`, `telemetry`, `amplitude`, `segment`, `mixpanel`,
`posthog`, `sentry`, `bugsnag`, `update-notifier`, `latest-version`, …) → **none found**.
Build workflow `sunday-ide.yml` injects no telemetry keys into `product.json` at packaging time.

**Hardcoded URLs in Sunday package sources** (swept `ext-agent`, `sundayd`, `browserd`, `mcp`, `skills`,
`orchestrator`, `sunday-cli`, `gateway`, `tools`, `protocol`, `ui-manager`, `ui-chat`, `context`, `eval`,
`hosted-gateway`): every match is one of — provider APIs (`openrouter.ai`, `groq`, OpenAI-compatible),
OAuth endpoints, `localhost`/private IPs, or test fixtures. **No analytics SDKs, no tracking pixels,
no CDN script loads in webview bundles.**

One deliberate first-party endpoint: `SUNDAY_DEFAULT_API_URL = 'https://api.sunday.dev'`
(`packages/gateway/src/providers.ts:272`) — the Sunday-hosted gateway. Inference prompts route here by
default (zero-config free tier; BYOK also supported). This is the product's main data flow, not hidden
telemetry, but it should be disclosed in the privacy docs.

**Bundled extensions:** the only Sunday-added extension is `vscode/extensions/sunday-google-auth`
(Google OAuth provider). Its network surface is exactly the standard Google OAuth flow:
`https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`,
`https://oauth2.googleapis.com/revoke`, `https://www.googleapis.com/oauth2/v3/userinfo` — user-initiated
sign-in only, no background calls. (`clientId` comes from the user's own `sunday.google.clientId` setting;
no embedded secret.)
`product.json`'s built-in Microsoft extensions (`ms-vscode.js-debug` 1.140.0, `js-debug-companion` 1.1.3,
`vscode-js-profile-table` 1.0.11) were not audited for their own network behavior — they are stock
Microsoft artifacts, out of this audit's scope.

---

## 5. `webviewContentExternalBaseUrlTemplate`: POINTS TO MICROSOFT'S CDN ⚠️

```json
"webviewContentExternalBaseUrlTemplate": "https://{{uuid}}.vscode-cdn.net/insider/ef65ac1ba57f57f2a3961bfe94aa20481caca4c6/out/vs/workbench/contrib/webview/browser/pre/"
```
- `vscode-cdn.net` is **Microsoft-owned infrastructure**. Loading webview resources performs DNS + TLS
  handshakes to Microsoft, exposing the user's IP on every webview load. The `{{uuid}}` subdomain is
  random per session (limited correlation value), but the static path embeds the exact upstream VS Code
  commit (`insider/ef65ac1ba57f57f2a3961bfe94aa20481caca4c6`), leaking the fork's upstream provenance.
- **This is the single clearest live leak to Microsoft in the shipped product.** Recommend replacing with
  a Sunday-controlled CDN/host, self-hosting the prebuilt webview assets, or restricting webviews to
  local content only.

---

## 6. Extension gallery (Open VSX): what data leaves the machine

- `product.json` `extensionsGallery` → `https://open-vsx.org/vscode/gallery` (service),
  `/vscode/item` (browse), asset template `https://open-vsx.org/vscode/asset/...`. `controlUrl` and
  `nlsBaseUrl` are empty. Gallery is **Open VSX (Eclipse Foundation), not Microsoft** — good.
- Data sent per gallery request (`extensionGalleryService.ts`, and `resolveMarketplaceHeaders` in
  `src/vs/platform/externalServices/common/marketplace.ts`):
  - Always: `X-Market-Client-Id: VSCode <version>`, `User-Agent: VSCode <version> (Sunday)`,
    search query text, installed/queried extension IDs + versions, target platform/arch, plus a random
    per-search `X-Market-Search-Activity-Id` UUID header.
  - **Not sent in the packaged build:** `X-Market-User-Id` (service-machine UUID) and `VSCode-SessionId`
    (telemetry machineId) are gated on `supportsTelemetry(...) && telemetryLevel == USAGE` — both false
    here, so neither header is attached.
- A stable service-machine UUID is still generated and persisted to the user-data dir
  (`serviceMachineId.ts` `getServiceMachineId`) even though nothing currently exfiltrates it — harmless
  but unnecessary; consider removing the persistence.
- `extensions.autoUpdate` defaults to `'on'` (`extensions.contribution.ts:139-150`) → periodic Open VSX
  version checks with the installed-extension list. Expected editor behavior; destination is Open VSX.
  (Note: the setting's description text still says "fetched from a Microsoft online service" — stale copy,
  should be reworded.)

---

## Concerns (rated)

| # | Rating | Concern | Evidence |
|---|--------|---------|----------|
| 1 | **HIGH** | Webview content base URL points to Microsoft's CDN (`vscode-cdn.net`); every webview load contacts Microsoft infra; commit-hash path leaks upstream provenance | `vscode/product.json` → `webviewContentExternalBaseUrlTemplate` |
| 2 | MEDIUM | Telemetry & crash-reporter settings remain in Settings UI, implying controls/pipelines that don't exist | `telemetry.telemetryLevel`, `telemetry.enableCrashReporter` still registered; `updateCrashReporterEnablement` in `app.ts:1871` |
| 3 | MEDIUM | Hosted gateway audit log records client IP + per-request model/token/latency server-side — needs a documented retention/deletion policy | `packages/hosted-gateway/src/audit.ts` |
| 4 | MEDIUM | No update mechanism at all — users never learn about security updates in-app | No `updateUrl` in `product.json`; `abstractUpdateService.ts:206` permanent disable |
| 5 | LOW | `agentsTelemetryAppName: "agents"` is dead config in an otherwise stripped telemetry surface | `product.json`; sole use at `localProcessExtensionHost.ts:533` (label on events that go nowhere) |
| 6 | LOW | Stable service-machine UUID generated/persisted locally although never transmitted | `serviceMachineId.ts` `getServiceMachineId` |
| 7 | LOW | `extensions.autoUpdate` description text still says "Microsoft online service" though gallery is Open VSX | `extensions.contribution.ts:146` |
| 8 | INFO | `SUNDAY_DEFAULT_API_URL=https://api.sunday.dev` — inference traffic routes through Sunday's gateway by default; ensure this is disclosed in privacy docs | `packages/gateway/src/providers.ts:272` |

## Recommendations (concrete, code-level)

1. **Replace `webviewContentExternalBaseUrlTemplate`** in `vscode/product.json` with a Sunday-controlled
   host (or self-host the `out/vs/workbench/contrib/webview/browser/pre/` assets and point the template
   there). Retest webview resource loading after the change.
2. **Remove `agentsTelemetryAppName`** from `product.json` (and its one use) to eliminate dead telemetry
   surface — or document why it stays.
3. **Hide/disable the telemetry settings UI**: remove or suppress `telemetry.telemetryLevel`,
   `telemetry.enableCrashReporter`, and related configuration registrations so users aren't shown
   non-functional controls; optionally add explicit `"enableTelemetry": false` to `product.json` for
   defense-in-depth (behavior today already relies on its absence).
4. **Decide the update story**: either add a Sunday-owned `updateUrl` (and audit what that endpoint
   collects — note the `?u=<internalOrg>` param and OS-version User-Agent) or keep updates disabled and
   document manual upgrade prominently in `INSTALL.md`/`UPGRADE.md`.
5. **Fix the stale "Microsoft online service" copy** on `extensions.autoUpdate` to say Open VSX.
6. **Document the hosted-gateway data flow** (`api.sunday.dev` default, key fingerprint + client IP in
   audit logs, retention period) in `PRIVACY.md` — cross-reference the gateway-retention auditor's findings.
7. **Remove `getServiceMachineId` persistence** if no feature will ever transmit it (minor hygiene).
8. **Re-run this audit after any change** that adds keys to `product.json` (`aiConfig`, `tasConfig`,
   `updateUrl`, `crashReporter`) — each one re-arms a currently-dead network path.

## What was NOT verified

- Runtime network capture of the packaged IDE (would confirm no unexpected egress; recommended as a follow-up).
- The Microsoft built-in extensions' own network behavior (`js-debug` etc.) — treated as out of scope (stock MSFT artifacts).
- Whether the shipped installers are built from exactly this source tree (build provenance — the 1.0.0-beta.1 release process).
- Hosted-gateway log retention policy (delegated to the gateway-retention auditor).
