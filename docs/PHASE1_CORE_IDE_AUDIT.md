# Phase 1 Audit — Core IDE Modules

**Source:** vendored VS Code 1.140.0 at `vscode/src/vs/workbench/contrib/`.
**Companion docs:** `WORKBENCH_DEPENDENCY_MAP.md` (proxy chains, danger zones) and
`SAFE_CHANGE_GUIDELINES.md` (pre-change checklist). This audit is consistent with both;
it deepens the module-level view for the 15 core-IDE modules Phase 2 (Shell Identity)
will touch.

**Method:** script-extracted `*.contribution.ts` entry files, `registerSingleton` calls,
`@IService` injector counts, and `api/browser/mainThread*.ts` proxy constructor deps.
Items marked **UNVERIFIED** were inferred, not exercised at runtime.

**Danger ratings:**
- 🔴 **DANGER** — removal breaks an ext-host proxy (`Missing proxy instance …`) or kills a
  pillar of daily IDE use. Follow the 6-step checklist in SAFE_CHANGE_GUIDELINES.md before
  touching.
- 🟡 **CAUTION** — proxy-coupled or high-use area; additive changes safe, removals need the
  checklist.
- 🟢 **SAFE** — no services registered or additive-only surface; free to modify, still
  verify in a built artifact.

> **"problems" note:** VS Code's Problems panel lives in `contrib/markers/` (not a
> `problems/` folder). Audited as `markers` below.

---

## 1. `files` — Explorer 🔴 DANGER

- **What:** The file Explorer — sidebar file tree, file actions, save/error handling.
- **Entry files:** `files/browser/files.contribution.ts`, `files/browser/fileActions.contribution.ts`,
  `files/electron-browser/fileActions.contribution.ts`
- **Services:** `IExplorerService` (1; only 5 direct injectors, but see below)
- **Why DANGER:** The dependency map rates Explorer **CRITICAL (9/10)**. `files.contribution.ts`
  also registers 5 `BlockStartup` workbench contributions. Removal is *silent* — no
  MainThread proxy asserts on it — but it kills the entire file UX: Explorer container,
  `workbench.action.files.*` commands, file context menus, save-error handling. There is
  no boot error to warn you; things just never appear.
- **Sunday-fication (safe):** Explorer branding is presentation-layer — custom view title,
  welcome content, Sunday file-icon theme, Explorer toolbar additions. All **SAFE** as
  additive changes. **Never** remove the contribution import or re-home `IExplorerService`
  without the full checklist.

## 2. `search` — Search & Replace 🔴 DANGER

- **What:** Search sidebar, find/replace, search quick-access.
- **Entry files:** `search/browser/search.contribution.ts`, `search/browser/search.common.contribution.ts`,
  `search/browser/searchQuickAccess.contribution.ts`
- **Services:** `INotebookSearchService`, `IReplaceService`, `ISearchHistoryService`,
  `ISearchViewModelWorkbenchService` (4; 1 view container)
- **Why DANGER:** `MainThreadSearch` proxy takes `@ISearchService` (platform service) and
  the contrib's view-model services feed the search UI that extensions drive via
  `vscode.workspace.findFiles`/`findTextInFiles`. `IReplaceService` has 7 injectors across
  refactor/bulk-edit flows. Removing the search view breaks a daily workflow with no loud
  proxy error for the view-model services (silent UI loss).
- **Sunday-fication (safe):** Cosmetic tweaks to the search view (icons, welcome text),
  extra search actions — **SAFE**. Do not touch the replace pipeline.

## 3. `terminal` — Integrated Terminal 🔴 DANGER

- **What:** Integrated terminal, terminal editor, profiles, env-var contributions.
- **Entry files:** `terminal/browser/terminal.contribution.ts`,
  `terminal/browser/terminal.web.contribution.ts`, `terminal/common/environmentVariable.contribution.ts`,
  `terminal/common/terminalExtensionPoints.contribution.ts`,
  `terminal/electron-browser/terminal.contribution.ts`
- **Services:** 12 — `ITerminalService`, `ITerminalGroupService`, `ITerminalInstanceService`,
  `ITerminalEditorService`, `ITerminalProfileService`, `ITerminalProfileResolverService`,
  `ITerminalConfigurationService`, `ITerminalContributionService`, `ITerminalEditingService`,
  `ITerminalLogService`, `IAgentHostTerminalService`, `IEnvironmentVariableService`
  (1 view container)
- **Why DANGER:** Two proxies assert on it — `MainThreadTerminalService` takes
  `@ITerminalService` + `@ITerminalGroupService`, and `MainThreadTerminalShellIntegration`
  takes `@ITerminalService`. 43 files inject `ITerminalService`. Removing any of these
  registrations → `Missing proxy instance MainThreadTerminalService` → extension host dead.
  Second-highest service count in `contrib/` after chat.
- **Sunday-fication (safe):** Sunday-branded default terminal profile, custom terminal
  color theme entries, terminal welcome tips — **SAFE** as configuration/additive.
  Never deregister a terminal service.

## 4. `debug` — Run & Debug 🔴 DANGER

- **What:** Debug sidebar, breakpoints, variables/watch/call-stack views, debug console.
- **Entry files:** `debug/browser/debug.contribution.ts`, `debug/browser/debug.service.contribution.ts`
- **Services:** `IDebugService`, `IDebugVisualizerService`, `IExtensionHostDebugService`
  (2 view containers)
- **Why DANGER:** `mainThreadDebugService` proxy takes `@IDebugService` — unregistered →
  `Missing proxy instance` at ext-host startup. 43 files inject `IDebugService`; every
  debug extension (and the built-in JS debugger wiring) flows through it.
- **Sunday-fication (safe):** Debug view icons/titles, extra debug actions — **SAFE**.
  The debug toolbar and breakpoint gutter are presentation; the service layer is untouchable.

## 5. `extensions` — Extensions View & Gallery 🔴 DANGER

- **What:** Extensions sidebar, marketplace gallery client, recommendations, extension host profiling.
- **Entry files:** `extensions/browser/extensions.contribution.ts`,
  `extensions/browser/extensions.web.contribution.ts`,
  `extensions/electron-browser/extensions.contribution.ts`,
  `extensions/electron-browser/devtoolsExtensionHost.contribution.ts`
- **Services:** `IExtensionsWorkbenchService` (Eager), `IExtensionRecommendationsService`,
  `IExtensionRecommendationNotificationService`, `IExtensionHostProfileService`
  (1 view container, 14 actions)
- **Why DANGER:** `mainThreadExtensionService` proxy takes `@IExtensionsWorkbenchService`.
  44 files inject it. Additionally `product.json` `extensionsGallery` is a **DANGEROUS key**
  per the dependency map: misconfiguration → gallery silently dead or
  `Error: No extension gallery service configured.` This is Sunday's Open VSX surface —
  the highest-visibility integration after the agent.
- **Sunday-fication (safe):** Gallery branding (already Open VSX), featured/recommended
  extensions curation, Extensions view welcome text — **SAFE**. Never touch the gallery
  service wiring or `extensionsGallery` keys without the checklist + a gallery smoke test
  in the built IDE.

## 6. `preferences` — Settings & Keybindings 🟡 CAUTION

- **What:** Settings editor UI, keyboard shortcuts editor, preferences search.
- **Entry files:** `preferences/browser/preferences.contribution.ts`
- **Services:** `IPreferencesSearchService` (1; only 1 injector — settings search index)
- **Why CAUTION:** Minimal service coupling — the settings *backbone* is the platform
  `IConfigurationService` (642 injectors, CRITICAL), not this contrib. The risk here is
  UX-level: breaking the settings editor or keybindings UI annoys every user, but there
  is no proxy assertion on this module. Safe to restyle; risky to rewire.
- **Sunday-fication (safe):** Sunday settings defaults (`workbench.colorTheme`, etc.),
  branded settings page headers, Sunday keybinding presets — **SAFE**. The
  `ThemeSettingDefaults` pattern (dependency map §5) is the model: fallback values only,
  nothing asserts them.

## 7. `themes` — Theme Picker 🟢 SAFE

- **What:** Color-theme / icon-theme / product-icon-theme pickers and theme actions
  (`workbench.action.selectColorTheme`, `generateColorTheme`, …).
- **Entry files:** `themes/browser/themes.contribution.ts`, `themes/browser/themes.test.contribution.ts`
- **Services:** **none registered**
- **Why SAFE:** Pure action/menu surface with zero service registrations and zero proxy
  coupling. The actual theme engine is the core `IThemeService` (200 injectors, CRITICAL —
  but the map notes it is the *most feasible* core service to decorate, and Sunday already
  ships custom themes). Nothing in this contrib can break ext-host startup.
- **Sunday-fication (safe):** This is Phase 2's playground — Sunday Dark/Light polish,
  theme auto-migration (Beta.4 work), `sunday.theme.apply` command, curated theme list.
  **All SAFE.** Caveat from the map: a `ThemeSettingDefaults` ID must exist among
  installed themes or the picker silently unpins.

## 8. `output` — Output Panel 🟡 CAUTION

- **What:** Output panel channels (extension logs, tasks, Git output).
- **Entry files:** `output/browser/output.contribution.ts`
- **Services:** `IOutputService` (1 view container; 16 injector files)
- **Why CAUTION:** `mainThreadOutputService` proxy takes `@IOutputService` — removal →
  `Missing proxy instance MainThreadOutputService` → ext-host dead. But the module is
  small and self-contained; additive changes are low-risk.
- **Sunday-fication (safe):** Sunday log channel, output panel styling — **SAFE**.
  Do not deregister `IOutputService`.

## 9. `scm` — Source Control 🔴 DANGER

- **What:** Source Control sidebar (Git), quick-diff gutter indicators, SCM view service.
- **Entry files:** `scm/browser/scm.contribution.ts`, `scm/browser/scm.service.contribution.ts`,
  `scm/browser/quickDiff.contribution.ts`
- **Services:** `ISCMService`, `ISCMViewService`, `IQuickDiffService`, `IQuickDiffModelService`
  (4; 1 view container)
- **Why DANGER:** `mainThreadSCM` proxy takes `@ISCMService`. 19 files inject it; the
  built-in Git extension and every SCM provider flow through it. Quick-diff touches the
  editor gutter on every file open.
- **Sunday-fication (safe):** SCM view icons/titles, Sunday-flavored welcome —
  **SAFE**. The provider API surface is untouchable.

## 10. `notebook` — Notebooks 🔴 DANGER

- **What:** Notebook editor stack (`.ipynb`), kernels, renderers, execution.
- **Entry files:** `notebook/browser/notebook.contribution.ts`
- **Services:** 14 — `INotebookService`, `INotebookKernelService`, `INotebookExecutionService`,
  `INotebookExecutionStateService`, `INotebookEditorService`, `INotebookEditorModelResolverService`,
  `INotebookEditorWorkerService`, `INotebookKernelHistoryService`, `INotebookKeymapService`,
  `INotebookLoggingService`, `INotebookCellStatusBarService`, `INotebookCellOutlineDataSourceFactory`,
  `INotebookOriginalCellModelFactory`, `INotebookOriginalModelReferenceFactory`,
  `INotebookOutlineEntryFactory`, `INotebookRendererMessagingService`
- **Why DANGER:** Highest service count after chat. **Three** proxies assert on it:
  `mainThreadNotebook`, `mainThreadNotebookDocumentsAndEditors`, and
  `mainThreadNotebookKernels` all take `@INotebookService`. 40 files inject it.
  Any registration removal → one of three `Missing proxy instance` errors → ext-host dead.
- **Sunday-fication (safe):** Notebook toolbar additions, Sunday notebook welcome —
  **SAFE** additive only. This module is configuration-dense; read before touching.

## 11. `timeline` — Timeline View 🟡 CAUTION

- **What:** Timeline view (file history: Git commits, saves, local history).
- **Entry files:** `timeline/browser/timeline.contribution.ts`,
  `timeline/browser/timeline.service.contribution.ts`
- **Services:** `ITimelineService` (1; only 3 injector files)
- **Why CAUTION:** `mainThreadTimeline` proxy takes `@ITimelineService` — proxy-coupled,
  so removal is fatal to ext-host startup. But the injector surface is tiny (3 files),
  making it the *smallest* proxy-coupled module in this audit.
- **Sunday-fication (safe):** Timeline is low-visibility; minimal Sunday-fication needed.
  Additive providers are **SAFE**.

## 12. `comments` — Code Comments 🟡 CAUTION

- **What:** Comment threads (code review), comment controllers, Reactions.
- **Entry files:** `comments/browser/comments.contribution.ts`
- **Services:** `ICommentService` (1; 11 injector files)
- **Why CAUTION:** `mainThreadComments` proxy takes `@ICommentService`. PR-review
  extensions (including the built-in GitHub PR flow) depend on it.
- **Sunday-fication (safe):** Comment UI styling — **SAFE**. Service untouched.

## 13. `tasks` — Tasks 🔴 DANGER

- **What:** Task runner (build/test/lint tasks), `tasks.json`, task quick-picks.
- **Entry files:** `tasks/browser/task.contribution.ts`
- **Services:** `ITaskService` (1; 12 injector files)
- **Why DANGER:** `mainThreadTask` proxy takes `@ITaskService` — removal kills ext-host
  startup. Tasks are a daily workflow for developers (npm scripts, build tasks); silent
  breakage here erodes the "100% VS Code" promise.
- **Sunday-fication (safe):** Sunday task templates, task UI polish — **SAFE** additive.
  The task execution engine is untouchable.

## 14. `remote` — Remote Development 🟡 CAUTION

- **What:** Remote window indicators, remote start entry, WSL/SSH/tunnel UX wiring.
- **Entry files:** `remote/browser/remote.contribution.ts`,
  `remote/browser/remoteStartEntry.contribution.ts`, `remote/common/remote.contribution.ts`,
  `remote/electron-browser/remote.contribution.ts`
- **Services:** **none registered in this contrib** (remote agent machinery —
  `IRemoteAgentService`, 75 injectors — is registered in platform/workbench services,
  not here)
- **Why CAUTION:** No service registrations here, so no proxy assertion originates from
  this folder — but it wires the remote UX around `IRemoteAgentService`, and remote
  breakage is hard to test (needs a remote target). Changes here fail silently in the
  common case (no remote configured).
- **Sunday-fication (safe):** Remote indicator branding — **SAFE**. Sunday's current
  scope is local-first; keep changes cosmetic.

## 15. `markers` — Problems Panel 🟢 SAFE

- **What:** Problems view (errors/warnings/info aggregation).
- **Entry files:** `markers/browser/markers.contribution.ts`
- **Services:** **none registered** (1 view container, 18 actions)
- **Why SAFE:** No singleton services, no proxy coupling. The problem *data* comes from
  the platform `IMarkerService`, which this contrib only displays. Worst case of a bad
  change here: the Problems view looks wrong — nothing breaks at startup.
- **Sunday-fication (safe):** Problems view styling, filters, welcome text —
  **SAFE**. Good Phase 2 candidate for visible polish with zero risk.

---

## Summary table

| # | Module | Services | Proxy-coupled? | Injectors (top svc) | Rating | Phase 2 Sunday-fication posture |
|---|---|---|---|---|---|---|
| 1 | files (Explorer) | 1 | No (silent kill) | 5 | 🔴 DANGER | Cosmetic only; never deregister |
| 2 | search | 4 | Indirect (MainThreadSearch) | 7 | 🔴 DANGER | Cosmetic only |
| 3 | terminal | 12 | **Yes ×2** | 43 | 🔴 DANGER | Config/additive only |
| 4 | debug | 3 | **Yes** | 43 | 🔴 DANGER | Cosmetic only |
| 5 | extensions | 4 | **Yes** (Eager) | 44 | 🔴 DANGER | Gallery curation; never rewire |
| 6 | preferences | 1 | No | 1 | 🟡 CAUTION | Defaults/branding — safe |
| 7 | themes | 0 | No | — | 🟢 SAFE | **Phase 2 playground** |
| 8 | output | 1 | **Yes** | 16 | 🟡 CAUTION | Additive only |
| 9 | scm | 4 | **Yes** | 19 | 🔴 DANGER | Cosmetic only |
| 10 | notebook | 14 | **Yes ×3** | 40 | 🔴 DANGER | Additive only |
| 11 | timeline | 1 | **Yes** | 3 | 🟡 CAUTION | Minimal; additive safe |
| 12 | comments | 1 | **Yes** | 11 | 🟡 CAUTION | Cosmetic only |
| 13 | tasks | 1 | **Yes** | 12 | 🔴 DANGER | Templates; engine untouched |
| 14 | remote | 0 | No (wires platform svc) | — | 🟡 CAUTION | Cosmetic; local-first scope |
| 15 | markers (Problems) | 0 | No | — | 🟢 SAFE | **Safe polish candidate** |

## Gaps / flags vs the companion docs

1. **Dependency map §4 already covers** `files` (CRITICAL 9/10) and `extensions`
   (gallery-key danger) — consistent with the DANGER ratings above.
2. **New finding not in the map:** `notebook` has **three** asserting proxies
   (`mainThreadNotebook`, `mainThreadNotebookDocumentsAndEditors`,
   `mainThreadNotebookKernels`) — the map's proxy table lists them individually but
   doesn't call out that one service removal trips three proxies. Treat notebook
   removals as triple-fatal.
3. **New finding:** `terminal` is the only non-chat module with **two** asserting
   proxies (`MainThreadTerminalService` + `MainThreadTerminalShellIntegration`).
4. **New finding:** `preferences` and `themes` are the lowest-coupling UI modules in
   core IDE — they are the natural Phase 2 entry points alongside `markers`.
5. **UNVERIFIED:** exact `BlockStartup` contribution semantics in `files.contribution.ts`
   (5 registrations) — confirmed present by grep, behavioral impact of reordering not tested.
6. **UNVERIFIED:** whether `ISearchService` (platform) has any registration path through
   `search` contrib files — grep shows it registered in platform services; contrib only
   adds view-model/history services. Treat platform `ISearchService` as untouchable.

## Recommended Phase 2 order (lowest risk first)

1. `themes` — zero services; Sunday Dark/Light already the pattern. **Start here.**
2. `markers` (Problems) — zero services; visible polish, zero risk.
3. `preferences` — defaults + branding; 1 low-coupling service.
4. `files` / `search` / `terminal` / `debug` / `extensions` / `scm` / `notebook` /
   `tasks` / `output` / `comments` / `timeline` — **cosmetic/additive only**,
   checklist-mandatory for anything deeper.
5. `remote` — cosmetic; defer (local-first scope).

*Audit date: 2026-10-12. Regenerate after any upstream VS Code version bump.*
