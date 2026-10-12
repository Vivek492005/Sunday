# Phase 1 — Branding Audit: Remaining VS Code / Copilot Strings

**Date:** 2026-10-12 | **Source:** vendored VS Code 1.140.0 at `~/workspace/sunday-product/vscode/`
**Goal:** Sunday IDE must show "Sunday" everywhere — never "VS Code", never "Copilot".

## Scale Summary

| Pattern | Files hit (workbench .ts, excl. tests) |
|---|---|
| "VS Code" | **189 files** |
| "Visual Studio Code" | **11 files** |
| "Copilot" (user-visible titles) | ~30 UI strings |
| "HydraFusion" | 5 files (user-visible in 2) |
| "Monaco" (user-visible localize) | 0 |
| product.json leaks | **0 — clean** ✅ |

Top folders by "VS Code" hits: `chat/` (77), `services/` (15), `terminal/` (12), `terminalContrib/` (9), `mcp/` (8), `api/` (7), `issue/` (6), `extensions/` (6), `tasks/` (5), `welcomeGettingStarted/` (4), `agentsVoice/` (4).

> Note: many hits are in comments or setting descriptions. This audit lists only **user-visible** strings.

---

## Classification Legend

- 🟢 **SAFE TO RENAME** — pure display string (button label, menu title, setting description, welcome text). Changing the English text in `localize()` is safe; no identifier changes.
- 🟡 **NEEDS CARE** — display string but tied to a feature/URL/extension ID. Rename text only after checking the link target still works.
- 🔴 **DO NOT TOUCH** — technical identifier, URL, command ID, product key, or extension ID. Renaming breaks functionality.

---

## 1. Chat / Agent Surfaces (highest visibility) 🔴 priority

### 1a. Copilot command titles (user clicks these)

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/chat/browser/actions/chatActions.ts:1260` | "Upgrade GitHub Copilot Plan" | 🟢 rename text → "Upgrade Sunday Plan" |
| `contrib/chat/browser/actions/chatActions.ts:1179` | "Manage Copilot Settings" | 🟢 rename text |
| `contrib/chat/browser/actions/chatActions.ts:1217` | "Show Extensions using Copilot" | 🟢 rename text |
| `contrib/chat/browser/chatSetup/chatSetupContributions.ts:335` | "Sign in to use GitHub Copilot" | 🟢 rename text → "Sign in to use Sunday" |
| `contrib/chat/browser/chatSetup/chatSetupContributions.ts:373` | "Sign in to use GitHub Copilot..." | 🟢 rename text |
| `contrib/chat/browser/chatSetup/chatSetupContributions.ts:457` | "Upgrade to GitHub Copilot Pro" | 🟢 rename text |
| `contrib/chat/browser/chatSetup/chatSetupContributions.ts:525` | "Manage GitHub Copilot Budget" | 🟢 rename text |
| `contrib/chat/browser/agentSessions/agentHost/agentHostAuth.ts:838` | "Sign in to use GitHub Copilot" (dialog title) | 🟢 rename text |
| `contrib/chat/browser/chatSetup/chatSetupGrowthSession.ts:80` | "Try Copilot" (label) | 🟢 rename text |
| `contrib/chat/browser/chatStatus/chatStatusDashboard.ts:175` | "Manage Copilot Settings" | 🟢 rename text |
| `contrib/chat/browser/widget/input/modelPicker/modelPickerItemSections.ts:66,74,78` | "Sign in to use Copilot" / "..." | 🟢 rename text |
| `contrib/chat/browser/electron-browser/agentSessions/agentSessionsActions.ts:277` | "Reset Copilot Harness Introduction" | 🟢 rename text |
| `contrib/chat/common/languageModelStats.ts:49` | "Copilot" (label) | 🟢 rename text |
| `contrib/chat/browser/chatDebug/agentHostLogSources.ts:221` | "Copilot Logs" (label) | 🟢 rename text |

### 1b. Copilot in settings descriptions (Settings UI)

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/chat/browser/chat.shared.contribution.ts:1761` | "Controls whether Copilot Agent Host sessions can use VS Code's semantic workspace search..." | 🟢 rename text (keep setting ID `chat.copilot.semanticSearch.enabled` — 🔴 do not rename the ID) |
| `contrib/chat/browser/chat.shared.contribution.ts:1798` | "...`builtin:<name>` (Copilot runtime tools)... every tool VS Code registers with the SDK..." | 🟢 rename text only |
| `contrib/chat/browser/chat.shared.contribution.ts:1577,1590,1596,1609` | "...Changes may not take full effect until VS Code is restarted." (×4, network domain settings) | 🟢 rename text → "Sunday" |
| `contrib/chat/browser/tools/languageModelToolsService.ts:202` | "Use VS Code features" (`copilot.toolSet.vscode.description`) | 🟢 rename text (keep key ID) |
| `contrib/chat/browser/promptSyntax/hookActions.ts:414,422` | "Local/Copilot Agents", "Copilot Agents" (picker separators) | 🟢 rename text |
| `contrib/chat/browser/feedbackSurvey/chatHarnessSwitchFeedbackSurveyService.ts:147,148` | "Copilot was too slow", "Copilot did not work as expected" | 🟢 rename text |

### 1c. Copilot survey (pops up for users)

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/surveys/browser/surveyQuestions.ts:59` | "Help Us Improve GitHub Copilot" (title) | 🟢 rename text |
| `contrib/surveys/browser/surveyQuestions.ts:68,81` | "How disappointed would you be if you could no longer use Copilot?", "What has Copilot helped you with most recently?" | 🟢 rename text |

### 1d. HydraFusion (user-visible!)

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/chat/browser/actions/chatAccessibilityHelp.ts:91` | "...HydraFusion, when available, is an alternative routing choice..." (screen-reader help text) | 🟢 rename text — internal codename leaking to users |
| `contrib/chat/browser/widget/chatContentParts/fusionPhasePillActionViewItem.ts:164` | "HydraFusion phase: {0}" (phase pill label) | 🟢 rename text |

### 1e. "VS Code" in chat strings

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/chat/common/model/chatSessionStore.ts:375` | "Please report this issue to the VS Code team:..." (error message) | 🟢 rename text → "Sunday team" |
| `contrib/chat/common/widget/chatColors.ts:133,138` | "Foreground color of the Stable/Insiders VS Code icon in the chat working progress indicator." (color setting description) | 🟢 rename text |

---

## 2. Welcome / Getting Started (first-run visibility) 🔴 priority

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/welcomeGettingStarted/common/gettingStartedContent.ts:260` | "Setup VS Code" (walkthrough page title) | 🟢 rename text → "Setup Sunday" |
| `contrib/welcomeGettingStarted/common/gettingStartedContent.ts:282` | "Watch the first in a series of short & practical video tutorials for VS Code's key features." | 🟢 rename text |
| `contrib/welcomeGettingStarted/common/gettingStartedContent.ts:297` | "Setup VS Code Web" | 🟢 rename text |
| `contrib/welcomeGettingStarted/common/gettingStartedContent.ts:323` | "Extensions are VS Code's power-ups..." | 🟢 rename text |
| `contrib/welcomeGettingStarted/common/gettingStartedContent.ts:351,357,414` | "...accomplish any task in VS Code", "get your files into VS Code" | 🟢 rename text |
| `contrib/welcomeGettingStarted/common/gettingStartedContent.ts:383` | "Setup VS Code Accessibility" | 🟢 rename text |
| `contrib/welcomeGettingStarted/browser/gettingStartedExtensionPoint.ts:162` | "Check off step when a given command is executed anywhere in VS Code." | 🟢 rename text |
| `contrib/welcomeOnboarding/browser/onboardingVariationA.ts` | (contains "Visual Studio Code" — exact string UNVERIFIED) | 🟡 check before renaming |
| `contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts` | walkthrough file (contains "Visual Studio Code") | 🟡 text safe; 🔴 do NOT rename the **file** (walkthrough ID may be referenced) |

---

## 3. Extensions View

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/extensions/browser/extensions.contribution.ts` | (contains "Visual Studio Code" — UNVERIFIED exact string) | 🟡 check |
| `contrib/extensions/browser/extensionsActions.ts:111` | "{0} for the Web" — uses `productService.nameLong`, already branded ✅ | — no action |
| `contrib/extensions/browser/extensionsWorkbenchService.ts` | (contains "Visual Studio Code" — UNVERIFIED) | 🟡 check |
| `contrib/extensions/common/installExtensionsTool.ts` | (contains "Visual Studio Code" — UNVERIFIED) | 🟡 check |
| `contrib/extensions/common/searchExtensionsTool.ts:24` | "Search for VS Code extensions" (tool description) | 🟢 rename text |
| `contrib/extensions/common/extensionsFileTemplate.ts:30` | "List of extensions recommended by VS Code that should not be recommended..." (settings description) | 🟢 rename text |

---

## 4. Terminal

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/terminal/common/terminalConfiguration.ts:335` | "...since VS Code's terminal only supports UTF-8..." | 🟢 rename text |
| `contrib/terminal/common/terminalConfiguration.ts:449` | "...when you want ctrl+k to go to your shell (not VS Code)" | 🟢 rename text |
| `contrib/terminal/common/terminalConfiguration.ts:623` | "The script gives VS Code insight into what is happening within the terminal." | 🟢 rename text |
| `contrib/terminalContrib/autoReplies/common/terminalAutoRepliesConfiguration.ts:20` | "Restart VS Code if new don't apply." | 🟢 rename text |
| `contrib/terminalContrib/voice/browser/terminalVoiceActions.ts:71` | "Would you like to install 'VS Code Speech' extension from 'Microsoft'?" | 🟡 rename text BUT verify: extension ID `ms-vscode.vscode-speech` is 🔴 do not touch — only the prompt text |

---

## 5. Tasks

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/tasks/common/jsonSchemaCommon.ts:194,248`, `jsonSchema_v2.ts:440` | "Whether the user is prompted when VS Code closes with a running task." (×3) | 🟢 rename text |
| `contrib/tasks/browser/abstractTaskService.ts:3489` | "...exiting VS Code might result in orphaned processes." (notification) | 🟢 rename text |
| `contrib/tasks/electron-browser/taskService.ts:223` | "...exiting VS Code might result in orphaned processes..." (notification) | 🟢 rename text |
| `contrib/tasks/common/taskDefinitionRegistry.ts:30` | "Used by VS Code to associate a `tasks.json` entry..." | 🟢 rename text |

---

## 6. Issue Reporter (Help → Report Issue)

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/issue/browser/baseIssueReporterService.ts:1057` | "A VS Code extension" (dropdown option) | 🟢 rename text |
| `contrib/issue/browser/issueReporterOverlay.ts:760,1070` | "A VS Code extension" (dropdown) | 🟢 rename text |
| `contrib/issue/browser/issueReporterOverlay.ts:263` | "Navigate VS Code and choose when to capture." | 🟢 rename text |
| `contrib/issue/browser/issueReporterPage.ts:15` | "I acknowledge that my VS Code version is not updated..." (checkbox) | 🟢 rename text |
| `contrib/issue/browser/issueReporterOverlay.ts:1570,2229,2250` | "VS Code" / "VS Code Version" (diagnostics table labels) | 🟡 rename label text only — 🔴 do NOT touch `vscodeVersion` field names or `modelData.versionInfo.vscodeVersion` identifiers |
| `contrib/issue/browser/baseIssueReporterService.ts:1160` | "This extension handles issues outside of VS Code" | 🟢 rename text |

---

## 7. Update / Release Notes

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/update/browser/update.ts:421-422` | "Press the reload button to switch to the Insiders/Stable version of VS Code." | 🟢 rename text |
| `contrib/update/browser/update.ts:457` | "The Insiders version of VS Code will synchronize your settings..." | 🟢 rename text |
| `contrib/update/browser/releaseNotesEditor.ts:772-775` | "Content shown in VS Code (both Stable and Insiders)" etc. (comments only, not user-visible) | — skip (code comments) |
| `contrib/update/browser/releaseNotesTryouts.ts:114,144,240` | "This example is not available in this version of VS Code." | 🟢 rename text |

---

## 8. MCP

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/mcp/browser/mcpCommandsAddConfiguration.ts:198` | "Model-Assisted" (separator for `mcp.serverType.copilot`) | 🟢 rename text (keep `copilot` ID — 🔴 do not rename the config key) |
| `contrib/mcp/browser/mcpCommandsAddConfiguration.ts:374` | "Copilot Global" (`mcp.target.copilotGlobal`) | 🟢 rename text (keep ID) |

---

## 9. Agents Voice

| File:line | String user sees | Verdict |
|---|---|---|
| `contrib/agentsVoice/browser/components/confirmationComponent.ts:48` | "Open in VS Code" (button) | 🟢 rename text → "Open in Sunday" |
| `contrib/agentsVoice/browser/components/sessionListComponent.ts:197` | "Open in VS Code" (button) | 🟢 rename text |
| `contrib/agentsVoice/browser/components/onboardingComponent.ts:99` | "...to multitask while VS Code is not in the foreground." | 🟢 rename text |

---

## 10. Platform (settings/policy descriptions)

| File:line | String user sees | Verdict |
|---|---|---|
| `platform/agentHost/common/agentHostEnablementService.ts:21,64,78,85` | "Whether existing Agent Host sessions in the main VS Code window...", "Configure whether VS Code uses the Agent Host Copilot SDK...", "shows the VS Code local chat harness..." | 🟢 rename text (keep context-key/policy IDs) |
| `platform/agentHost/common/agentHostSchema.ts:838,864` | "Whether VS Code's global auto-approve setting is enabled...", "Whether VS Code's auto-reply setting is enabled..." | 🟢 rename text |
| `platform/agentHost/common/agentHostStarter.config.contribution.ts:274,308` | "Enable Claude Agent sessions in VS Code... Uses your existing Copilot subscription.", "Enable Codex Agent sessions in VS Code... routed through GitHub Copilot..." | 🟢 rename text |
| `platform/agentHost/common/copilotCliConfig.ts:212,269` | "When enabled, Copilot SDK sessions defer MCP and non-core VS Code tools..." | 🟢 rename text |
| `platform/agentHost/node/devContainerAgentHostService.ts:895` | "Unable to check active VS Code sessions in Dev Container..." (error) | 🟢 rename text |
| `platform/agentHost/node/sshRemoteAgentHostService.ts:2188` | "Installing VS Code CLI on remote..." (progress) | 🟡 rename text BUT the actual CLI binary name is 🔴 do not touch |
| `platform/contextkey/common/contextkeys.ts:21` | "Quality type of VS Code" (context key description) | 🟢 rename text (keep `productQualityType` key) |
| `platform/product/common/product.ts:81-82` | `nameShort: 'Code - OSS Dev'`, `nameLong: 'Code - OSS Dev'` | 🔴 **DO NOT TOUCH** — dev fallback defaults; real values come from product.json at build. Changing these is unnecessary. |

---

## 11. Built-in Extensions

| Extension | Finding | Verdict |
|---|---|---|
| `extensions/copilot/package.json` | `displayName: "GitHub Copilot"`, `description: "AI chat features powered by Copilot"` — shows in Extensions view | 🟡 **Decision needed:** this is the Copilot extension itself. Options: (a) remove from build, (b) keep but rename display. Renaming displayName to "Sunday Agent" is misleading since it's Copilot's code. Recommend: **remove from built-in extensions list** if Sunday agent replaces it, else hide. Needs parent decision. |
| `extensions/copilot/chat-lib/package.json` | `description: "Chat and inline editing SDK extracted from VS Code Copilot Chat"` | 🟡 internal SDK; only visible if extension listed |
| `extensions/github`, `extensions/github-authentication` | displayName/description use `%placeholders%` (localized, no hardcoded brand leak in manifest) | — no action |

---

## 12. product.json — ✅ CLEAN

No "VS Code", "Visual Studio Code", "Code - OSS", "Microsoft", or "vscode.com" found in any string value. Branding already done.

---

## 13. packages/ext-agent (our extension)

Most "VS Code" hits are **code comments** (not user-visible) — skip. User-visible leaks:

| File:line | String user sees | Verdict |
|---|---|---|
| `src/userGuide.ts:130` | "VS Code ke apne Chat panel me `@sunday`..." (guide HTML) | 🟢 rename → "Sunday ke Chat panel me" |
| `src/userGuide.ts:183` | "Screen reader support VS Code ke saath built-in hai" (guide HTML) | 🟢 rename → "Sunday me built-in hai" |
| `src/extension.ts:487` | "Value for ... (stored in VS Code SecretStorage...)" (input prompt) | 🟢 rename → "Sunday SecretStorage" |

---

## 🎯 Prioritized Fix List (highest user visibility first)

### P0 — User sees on every session
1. **Chat command titles** (§1a, 14 strings) — "Sign in to use GitHub Copilot", "Upgrade GitHub Copilot Plan", etc. appear in Command Palette and menus.
2. **Model picker** (§1a) — "Sign in to use Copilot" appears when picking a chat model.
3. **agentsVoice "Open in VS Code"** (§9) — button text.
4. **ext-agent userGuide.ts** (§13) — our own guide says "VS Code".

### P1 — User sees in Settings / Welcome
5. **Welcome walkthrough titles** (§2) — "Setup VS Code" on first run.
6. **Settings descriptions** (§1b, §4, §5, §10) — dozens of "VS Code" in setting descriptions.
7. **Copilot survey** (§1c) — pops up asking about Copilot.
8. **HydraFusion strings** (§1d) — internal codename in user-facing help.

### P2 — Occasional surfaces
9. **Issue reporter** (§6) — "A VS Code extension" dropdown.
10. **Update notifications** (§7) — "Insiders version of VS Code".
11. **Terminal voice prompt** (§4) — "install 'VS Code Speech' extension".

### P3 — Decision needed
12. **Built-in `copilot` extension** (§11) — remove, hide, or keep? Needs parent/user decision.

---

## Rules Applied (from dependency map)

- Never rename: setting IDs (`chat.copilot.*`, `github.copilot.*`), context keys (`productQualityType`), config keys (`mcp.serverType.copilot`), extension IDs (`ms-vscode.vscode-speech`), field names (`vscodeVersion`), file names (`vs_code_editor_walkthrough.ts`), product.ts dev defaults.
- Only the **English display text** inside `localize()` / `nls.localize()` calls changes — the key (first arg) stays.
- `tsc` must still pass after renames (text-only changes can't break types, but verify).
- Items marked UNVERIFIED need a human to open the file and confirm the exact string before renaming.
