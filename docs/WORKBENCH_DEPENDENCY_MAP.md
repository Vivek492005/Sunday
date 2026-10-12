# Workbench Dependency Map — Sunday VS Code Fork

**Purpose:** Before ANY future change to `vscode/src/vs/workbench/` code, consult this map.
It exists because of a real incident: removing `agentSessions.contribution.js` (Beta.4, commit
`2c954f94`) killed the `IAgentSessionsService` registration → `MainThreadChatSessions`
constructor DI failed → extension host threw `Missing proxy instance MainThreadChatSessions` →
**every extension command/view/API died** in the shipped build. Reverted in `fdd2495f`.

**How to use this doc:** Find the area you want to change → check its Danger rating →
follow the Change Checklist (§6) → verify with the grep patterns.

**Source:** vendored VS Code 1.140.0 at `~/workspace/sunday-product/vscode/src/vs/workbench/`.
All paths below are relative to `vs/workbench/` unless stated otherwise.
Items marked **UNVERIFIED** were inferred, not directly exercised.

---

## 0. The failure mechanism (read this first)

Removing workbench code can break the build in **two different ways**:

**A. Extension-host proxy assertion (LOUD, breaks everything).** Every class decorated with
`@extHostNamedCustomer(MainContext.MainThreadX)` in `api/browser/mainThread*.ts` is
instantiated at extension-host startup (`services/extensions/common/extensionHostManager.ts:283-295`).
Then `extensionHostManager.ts:314` runs `rpcProtocol.assertRegistered(mainProxyIdentifiers)`,
where `mainProxyIdentifiers` = **every** identifier in the `MainContext` enum
(`api/browser/mainThreadExtensionService.ts:58`). If ANY named customer's constructor
`@I…Service` dependency is unregistered, instantiation throws (caught → logged as
`Cannot instantiate named customer: '<sid>'`), the proxy is never `set`, and the assertion
throws:

```
Error: Missing proxy instance MainThread<Name>
```

The ext-host start promise rejects → **no extensions activate** → all extension commands,
views, and APIs are dead. This is what happened in Beta.4.

**B. Silent DI miss (QUIET, breaks one area).** Removing a `*.contribution.ts` import from
`workbench.common.main.ts` simply never runs its registrations. There is **no startup
assertion** for missing contribs — `accessor.get(ISomeService)` returns `undefined` and
things fail later as `TypeError: Cannot read properties of undefined`, or UI silently
never appears. Nothing tells you at boot.

**Key rule:** `tsc` compile success does **NOT** prove a removal is safe — the service
*type* still exists in its `*Service.ts` file; only the runtime `registerSingleton` call
is gone.

---

## 1. Contribution inventory

100 folders under `vs/workbench/contrib/`. 96 have `*.contribution.ts` entry files.
176 unique singleton services registered across them. Everything loads **eagerly** via
static imports in `workbench.common.main.ts` (262 imports, zero dynamic `import()`).

Legend: `svcs` = singleton services registered · `vc` = view containers · `actions` = `registerAction2` count.

### High-service-count folders (highest blast radius)

| Folder | Services | Entry file(s) | Notes |
|---|---|---|---|
| `chat` | **73** | `browser/chat.shared.contribution.ts` (+19 more) | THE danger zone. Registers IChatService, IChatWidgetService, ILanguageModelsService, IChatAgentService in ONE file (`chat.shared.contribution.ts:3428-3445`). See §2. |
| `notebook` | 14 | `browser/notebook.contribution.ts` | Notebook editor stack |
| `terminal` | 12 | 5 contrib files | Terminal + agent-host terminal |
| `testing` | 9 | `browser/testing.contribution.ts` | Test explorer (2 view containers) |
| `mcp` | 9 | 3 contrib files | Model Context Protocol |
| `terminalContrib` | 7 | 25 contrib files | Terminal contributions |
| `issue` | 5 | 3 contrib files | Issue reporter |
| `scm` | 4 | 3 contrib files | Source Control (1 view container) |
| `extensions` | 4 | 4 contrib files | Extensions view + gallery (1 view container). See §4. |

### Full folder list (services registered per folder)

```
accessibility: IAccessibleViewInformationService, IAccessibleViewService
accessibilitySignals: IAccessibilitySignalService
agentsVoice: - (2 view containers, 18 actions)
authentication: - (7 actions)
browserView: IBrowserViewCDPService, IBrowserViewWorkbenchService
bulkEdit: - (1 view container)
chat: 73 services (see §2 for the critical 6)
comments: ICommentService
customEditor: ICustomEditorService
debug: IDebugService, IDebugVisualizerService (2 view containers)
editSessions: IEditSessionsLogService, IEditSessionsStorageService (1 view container)
editTelemetry: IAiEditTelemetryService, IRandomService
extensions: IExtensionHostProfileService, IExtensionRecommendationNotificationService, IExtensionRecommendationsService, IExtensionsWorkbenchService (1 view container, 14 actions)
externalUriOpener: IExternalUriOpenerService
files: IExplorerService (CRITICAL — Explorer; see §4)
inlineChat: IInlineChatSessionResolver, IInlineChatSessionService
interactive: IInteractiveDocumentService, IInteractiveHistoryService
issue: IGitHubUploadService, IIssueFormService, IRecordingService, IScreenshotService, IWorkbenchIssueService
markers: - (1 view container, 18 actions)
mcp: IMcpCopilotGlobalConfigurationService, IMcpDevModeDebugging, IMcpElicitationService, IMcpRegistry, IMcpSamplingService, IMcpSandboxService, IMcpService, IMcpWorkbenchService, IWorkbenchMcpGatewayService
mergeEditor: - (27 actions)
multiDiffEditor: IMultiDiffSourceResolverService
notebook: 14 services (INotebookService, INotebookKernelService, …)
onboarding: IOnboardingScenarioService, IOnboardingTryoutHandoffService, IOnboardingTryoutService
output: IOutputService (1 view container)
scm: IQuickDiffModelService, IQuickDiffService, ISCMService, ISCMViewService (1 view container)
search: ISearchHistoryService, ISearchViewModelWorkbenchService (1 view container)
share: IShareService
snippets: ISnippetsService
speech: ISpeechService
splash: ISplashStorageService
terminal: 12 services (ITerminalService, ITerminalGroupService, …) (1 view container)
terminalContrib: 7 services (ITerminalChatService, …)
testing: 9 services (ITestService, ITestResultService, …) (2 view containers)
timeline: ITimelineService
update: - (9 actions — the built-in updater UI)
url: ITrustedDomainService
webview: IWebviewService
webviewPanel: IWebviewWorkbenchService
webviewView: IWebviewViewService
welcomeOnboarding: IOnboardingService
```

Folders with `-` register no singleton services (actions/views only) — lower removal risk,
but their actions/menus vanish if removed.

---

## 2. Service dependency chains

### 2a. Chat/agent services (the incident area)

**Structural warning:** 4 of these 6 services are registered in the SAME file —
`contrib/chat/browser/chat.shared.contribution.ts` (lines 3428–3445), itself imported from
`workbench.common.main.ts:231`. Commenting out that ONE import kills all four at once.

| Service | Registered at | Injectors | Proxies needing it | If removed → first error |
|---|---|---|---|---|
| `IAgentSessionsService` | `contrib/chat/browser/agentSessions/agentSessions.contribution.ts:190` | 21 | `MainThreadChatSessions` (ctor line 704) | `Missing proxy instance MainThreadChatSessions` |
| `IChatService` | `chat.shared.contribution.ts:3428` | 90 | `MainThreadChatSessions`, `MainThreadChatAgents2`, `MainThreadChatDebug` | `Missing proxy instance MainThreadChatSessions` (UNVERIFIED which of the 3 throws first) |
| `IChatSessionsService` | `contrib/chat/browser/chatSessions/chatSessions.contribution.ts:1659` (independent import at `workbench.common.main.ts:242`) | 39 | `MainThreadChatSessions`, `MainThreadChatAgents2` | `Missing proxy instance MainThreadChatSessions` or `MainThreadChatAgents2` (order UNVERIFIED) |
| `IChatWidgetService` | `chat.shared.contribution.ts:3429` | 76 | `MainThreadChatSessions`, `MainThreadChatAgents2` | same as above (order UNVERIFIED) |
| `IChatAgentService` | `chat.shared.contribution.ts:3445` | 34 | `MainThreadChatAgents2` only | `Missing proxy instance MainThreadChatAgents2` |
| `ILanguageModelsService` | `chat.shared.contribution.ts:3442` | 44 | `MainThreadLanguageModels` only | `Missing proxy instance MainThreadLanguageModels` → `vscode.lm` API dead |

**Key injector hotspots** (files that break if these services vanish):
- `api/browser/mainThreadChatSessions.ts`, `mainThreadChatAgents2.ts`, `mainThreadChatDebug.ts`,
  `mainThreadLanguageModels.ts` — the RPC proxies (fatal at startup)
- `contrib/chat/browser/widget/chatWidget.ts`, `widget/input/chatInputPart.ts`,
  `widgetHosts/viewPane/chatViewPane.ts` — chat UI
- `contrib/chat/browser/agentSessions/*` — agent sessions model/viewer/control
- `contrib/chat/common/requestParser/chatRequestParser.ts` — `@agent`/`/command` parsing

### 2b. Core workbench services

| Service | Registered at | Injectors | Danger | Replaceable? |
|---|---|---|---|---|
| `IConfigurationService` | NOT via registerSingleton — `workbench/electron-browser/desktop.main.ts:312` → `serviceCollection.set(IWorkbenchConfigurationService, …)` (`refineServiceDecorator` keeps the same `'configurationService'` ID) | **642** | **CRITICAL** — settings backbone | Technically yes, behaviorally enormous — no |
| `IViewsService` | `workbench/services/views/browser/viewsService.ts:715` (Eager) | 43 | **HIGH** — all sidebar/panel views | Feasible with effort |
| `IEditorService` | `workbench/services/editor/browser/editorService.ts:1135` | 260 | **CRITICAL** — all file open flows | Barely — deep behavioral contract |
| `IEditorGroupsService` | `workbench/browser/parts/editor/editorParts.ts:1042` (Eager — IS the editor layout root) | 87 | **CRITICAL** | No — fused to DOM grid machinery |
| `IExtensionService` | `workbench/services/extensions/{browser,electron-browser}/*extensionService.ts` (Eager, platform-split) | 165 | **CRITICAL** — extension host | No — speaks ext-host RPC protocol |
| `IThemeService` | `workbench/services/themes/browser/workbenchThemeService.ts:934` via `IWorkbenchThemeService` (same `'themeService'` ID) | 200 | **CRITICAL** | **Yes — most feasible**; Sunday already ships custom themes |
| `IViewDescriptorService` | `workbench/services/views/browser/viewDescriptorService.ts:1013` | 74 | **HIGH** | Feasible with effort |
| `IContextKeyService` | `workbench/workbench.common.main.ts:190` | 391 | **CRITICAL** — keybindings, menus, `when`-clauses | Yes — small well-defined interface |
| `ICommandService` | `workbench/services/commands/common/commandService.ts:113` | 211 | **CRITICAL** — command palette, `executeCommand` | Yes — dispatch table; easy to wrap |
| `INotificationService` | `workbench/services/notification/common/notificationService.ts:333` | 194 | **HIGH** (boots without it) | **Yes — easiest**; ideal seam for custom toasts |
| `IStorageService` | NOT via registerSingleton — `desktop.main.ts:320` → `serviceCollection.set(IStorageService, NativeWorkbenchStorageService)` | 346 | **CRITICAL** — layout, mementos, profiles | Technically yes, must honor flush/durability exactly |
| `IWorkbenchEnvironmentService` | NOT via registerSingleton — `desktop.main.ts:198` → `.set(INativeWorkbenchEnvironmentService, …)` (same `'environmentService'` ID) | 173 | **CRITICAL** — user-data paths | Partially — prefer decoration over replacement |

**Note:** 4 of 12 core services bypass `registerSingleton` — they are `.set()` directly into the
`ServiceCollection` in the platform bootstrap (`desktop.main.ts` / `web.main.ts`). Grep for
`registerSingleton(IXxx` alone will MISS them. Always also grep `serviceCollection.set(IXxx`.

**`contrib/chat` dominates injector counts** for 9 of 12 core services — chat refactors have
the highest blast radius of any area.

---

## 3. Proxy map

78 `MainThread*` proxies under `vs/workbench/api/browser/`. Each is a class decorated with
`@extHostNamedCustomer(MainContext.MainThreadX)`; the decorator only runs if the module is
side-effect-imported (all 78 are, via `api/browser/extensionHost.contribution.ts` lines 18–104).
Every one is instantiated at ext-host startup and **asserted** (`extensionHostManager.ts:314`).

Format: `proxy → constructor service deps → breaks if a dep is unregistered`.

**Chat/agent proxies (highest risk):**

| Proxy file | Proxy ID | Constructor service deps | Breaks if… |
|---|---|---|---|
| `mainThreadChatSessions.ts` | `MainThreadChatSessions` | `IAgentSessionsService`, `IChatSessionsService`, `IChatService`, `IChatWidgetService`, `IChatTodoListService`, `IChatArtifactsService`, `IChatDebugService`, `IDialogService`, `IEditorService`, `IEditorGroupsService`, `ILogService`, `IInstantiationService` | ANY of the 4 chat services unregistered → `Missing proxy instance MainThreadChatSessions` |
| `mainThreadChatAgents2.ts` | `MainThreadChatAgents2` | `IChatAgentService`, `IChatSessionsService`, `IChatService`, `ILanguageFeaturesService`, `IChatWidgetService`, … | `Missing proxy instance MainThreadChatAgents2` |
| `mainThreadChatDebug.ts` | `MainThreadChatDebug` | `IChatDebugService`, `IChatService` | `Missing proxy instance MainThreadChatDebug` |
| `mainThreadLanguageModels.ts` | `MainThreadLanguageModels` | `ILanguageModelsService`, `ILogService`, `IProductService`, `IAuthenticationService`, … | `Missing proxy instance MainThreadLanguageModels` → `vscode.lm` dead |
| `mainThreadChatQuota.ts` | `MainThreadChatQuota` | `IChatEntitlementService` | `Missing proxy instance MainThreadChatQuota` |
| `mainThreadChatCodeMapper.ts` | `MainThreadCodeMapper` | `ICodeMapperService` | `Missing proxy instance MainThreadCodeMapper` |

**Other notable proxies** (deps abbreviated; full list in `/tmp/proxy_map.txt` on the build VM):

| Proxy ID | Key service deps |
|---|---|
| `MainThreadAuthentication` | (none — safe) |
| `MainThreadBulkEdits` | `IBulkEditService` |
| `MainThreadBrowsers` | `IBrowserViewCDPService`, `IBrowserViewWorkbenchService` |
| `MainThreadCommands` | `ICommandService` |
| `MainThreadEditors` | `IEditorService`, `IEditorGroupsService` |
| `MainThreadExtensionService` | `IExtensionService` |
| `MainThreadFileSystem` | `IFileService` |
| `MainThreadSearch` | `ISearchService` |
| `MainThreadTerminalService` | `ITerminalService`, `ITerminalGroupService` |
| `MainThreadWebviews` | `IWebviewService`, `IWebviewWorkbenchService` |
| `MainThreadSCM` | `ISCMService` |

**Rule of thumb:** a proxy is only as safe as its MOST fragile constructor dep. Chat proxies
take 4+ chat services each — they are the canaries for any chat-area removal.

---

## 4. Danger zones

### 🔴 NEVER remove/disable without replacing service registrations

1. **`contrib/chat/browser/chat.shared.contribution.ts`** (via `workbench.common.main.ts:231`)
   Registers `IChatService`, `IChatWidgetService`, `ILanguageModelsService`, `IChatAgentService`
   in one file. Removing kills 4 named proxies at once.
   Error: `Missing proxy instance MainThreadChatSessions` (or ChatAgents2/LanguageModels/ChatDebug).

2. **`contrib/chat/browser/agentSessions/agentSessions.contribution.ts`**
   (via `chat.shared.contribution.ts:136`)
   Registers `IAgentSessionsService` (line 190). **This was the Beta.4 incident.**
   Error: `Missing proxy instance MainThreadChatSessions`.

3. **`contrib/chat/browser/chatSessions/chatSessions.contribution.ts`**
   (via `workbench.common.main.ts:242`)
   Registers `IChatSessionsService` (line 1659).
   Error: `Missing proxy instance MainThreadChatSessions` or `MainThreadChatAgents2`.

4. **`api/browser/extensionHost.contribution.ts`**
   Force-loads all 78 `mainThread*.js` modules. Removing ANY import → decorator never runs →
   proxy never registered → `Missing proxy instance MainThread<Name>` at ext-host startup.

5. **`contrib/files/`** (Explorer)
   Registers `IExplorerService` + 5 `BlockStartup` workbench contributions. Removal is silent
   (no proxy assertion) but kills the entire file UX: Explorer container, `workbench.action.files.*`,
   file context menus, save-error handling. Danger: CRITICAL (9/10).

6. **`contrib/extensions/`** (Extensions view + gallery)
   `IExtensionsWorkbenchService` is **Eager**. Corrupting `product.json` `extensionsGallery`
   (UNVERIFIED exact key behavior beyond: `isEnabled()` false → gallery silently dead;
   direct calls throw `Error: No extension gallery service configured.`).

### 🟡 Modify with care (no proxy assertion, but silent breakage)

- Any `*.contribution.ts` import removal from `workbench.common.main.ts`: no boot error;
  downstream `TypeError: Cannot read properties of undefined` or silently-missing UI.
- `product.json`: SAFE keys — `nameShort`, `nameLong`, `reportIssueUrl`, `licenseName`,
  `serverGreeting`. DANGEROUS keys — `extensionsGallery` (kills marketplace),
  `win32*AppId` GUIDs (breaks installer upgrade identity), `dataFolderName` (orphans all
  user data if changed post-release), `commit` (ext-host exits `VersionMismatch` if hand-edited).

---

## 5. Safe zones

| Area | Why safe | Files |
|---|---|---|
| New view container in activity bar | Additive via extension `package.json` `contributes.viewsContainers`; per-extension processing, can't break others. Proven: `93a9d952` (Sunday IDE Agent). | extension `package.json`; handler `api/browser/viewsExtensionPoint.ts:252` |
| New commands/menus via extension | Additive to `CommandRegistry`/`MenuRegistry`; malformed entry rejected per-extension only. | extension `package.json`; `api/common/extHostCommands.ts` |
| `ThemeSettingDefaults` | Fallback IDs only; nothing asserts their values. Caveat: ID must exist among installed themes or picker silently unpins. Changed in-fork already. | `workbench/services/themes/common/workbenchThemeService.ts:42-52` |
| `product.json` `nameShort`/`nameLong` | Runtime-read cosmetic strings; doesn't move `dataFolderName`. | `vscode/product.json` |
| New MainThread\* + ExtHost pair | Both `assertRegistered` checks fail LOUDLY at startup if mis-wired — mistakes are caught immediately, not silently. | `api/common/extHost.protocol.ts` (identifiers); `api/browser/extensionHost.contribution.ts`; `api/common/extHost.api.impl.ts` |
| Titlebar contents | Pure presentation (title text, command center, menus). Boundary: do NOT remove the part slot from layout (`Parts.TITLEBAR_PART`). | `workbench/browser/parts/titlebar/` |
| New webview panels/views | Extension-contributed; isolated. | extension code |

---

## 6. Change checklist (run BEFORE removing/disabling any workbench contribution)

Run from `~/workspace/sunday-product/vscode/`. Steps 1–3 would have caught the Beta.4 incident.

**Step 1 — List every service the target file registers; find external consumers.**
```bash
F=src/vs/workbench/contrib/chat/browser/agentSessions/agentSessions.contribution.ts
grep -n "registerSingleton" $F
# → note each IXxxService + line number
grep -rn "@IAgentSessionsService" src/vs/workbench --include="*.ts" | grep -v "contrib/chat/browser/agentSessions/"
# → if ANY hit outside the removed dir: STOP. Keep or re-home the registration.
```

**Step 2 — Check RPC proxy coupling.**
```bash
grep -rn "extHostNamedCustomer" src/vs/workbench/api/browser/mainThreadChatSessions.ts
grep -n "MainThreadChatSessions" src/vs/workbench/api/common/extHost.protocol.ts
# → identifier in MainContext enum ⇒ assertRegistered DEMANDS it at startup (extensionHostManager.ts:314)
```

**Step 3 — Prove the import is the sole load path.**
```bash
grep -rn "agentSessions.contribution.js" src/vs/workbench --include="*.ts"
# → single hit = deleting the import deletes the module and ALL its side effects
```

**Step 4 — Check for non-registerSingleton registrations.**
```bash
grep -rn "serviceCollection.set(I<Name>" src/vs/workbench/electron-browser/desktop.main.ts src/vs/workbench/browser/web.main.ts
# → 4 core services bypass registerSingleton; grep alone for registerSingleton MISSES them
```

**Step 5 — Static simulation of both startup assertions.**
```bash
for f in $(grep -l "extHostNamedCustomer" src/vs/workbench/api/browser/mainThread*.ts); do
  mod=$(basename "$f" .ts)
  grep -q "import './$mod.js'" src/vs/workbench/api/browser/extensionHost.contribution.ts || echo "MISSING IMPORT: $mod"
done
```

**Step 6 — Runtime log check on the built IDE (tsc is NOT sufficient).**
```bash
grep -rn "Cannot instantiate named customer\|Missing proxy instance" <user-data-dir>/logs/*/*.log
# → both strings must be ABSENT from startup logs. tsc passes while runtime registration is gone.
```

---

## Appendix: data sources

- Per-folder inventory (100 folders, services/view-containers/actions): generated
  `2026-10-12` via script over `*.contribution.ts` (maxdepth 2).
- Proxy map (78 `MainThread*` → constructor `@I…Service` deps): generated `2026-10-12`
  via `@extHostNamedCustomer` + constructor regex over `api/browser/mainThread*.ts`.
- 176 unique `registerSingleton` services enumerated across `contrib/`.
- Chat/agent chains (§2a) and core services (§2b) verified by targeted subagent traces
  against the vendored 1.140.0 source, with file:line references.
- `workbench.common.main.ts`: 262 static imports, zero dynamic `import()` — all eager.
  Chat chain loads at lines 231–243 (early); `opener` contribution is last.

*Last updated: 2026-10-12. Regenerate the script-derived tables after any upstream VS Code
version bump.*
