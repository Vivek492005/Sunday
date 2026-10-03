# Phase 8 Plan — P-030 Agent Manager Part/Window

**Status:** Planning only. No `vscode/` modifications made.
**Date:** 2026-10-03
**Design refs:** `~/workspace/user/files/merged_step1.md` §20.4, §28 (Phase 8), P-030 register (§8, line 547)

---

## 1. What P-030 is

P-030: **"Agent Manager part (Phase 6+) — New workbench part/window — High"** (upstream divergence risk).

Design doc §20.4 specifies two phases:
- **Phase 1** = editor-area webview (no core patch)
- **Phase 2 (optional)** = dedicated window/part

§28 (Phase 8 backlog) lists P-030 first, alongside: per-user agent daemon,
cloud/background agents + PR creation, next-edit suggestions, voice,
JetBrains/CLI frontends reusing sundayd, optional hosted gateway.

**This plan covers P-030 only.** The other Phase 8 items need separate plans.

---

## 2. Current state (what exists today)

| Layer | Location | Notes |
|---|---|---|
| React UI | `packages/ui-manager/src/` | `App.tsx` (452 lines), `managerClient.ts` (state/reducer), `vscode.ts` (postMessage bridge). Renders agents list, selected-agent detail, inbox, orchestration runs, conflicts. |
| Extension host | `packages/ext-agent/src/managerView.ts` | `ManagerViewProvider implements vscode.WebviewViewProvider`, view type `sunday.managerView`. Serves built `ui-manager/dist`, routes messages to HostBridge/sundayd. |
| Contribution | `packages/ext-agent/package.json` | Registered under `views.explorer` as "Sunday Manager" (sidebar). Command `sunday.manager.open` → focuses `sunday.managerView`. |

**Gap vs design:** §20.2 specifies Agent Manager as an *editor-area webview panel*
(`createWebviewPanel`), but the implementation is a *sidebar WebviewView*.
Even "Phase 1" of the design is not yet matched.

---

## 3. VS Code workbench part API — research findings

Vendored tree: `~/workspace/sunday-product/vscode/` (upstream tag 1.140.0).

### 3.1 How parts are defined

`vscode/src/vs/workbench/services/layout/browser/layoutService.ts` (line 21):

```ts
export const enum Parts {
  TITLEBAR_PART = 'workbench.parts.titlebar',
  BANNER_PART = 'workbench.parts.banner',
  ACTIVITYBAR_PART = 'workbench.parts.activitybar',
  SIDEBAR_PART = 'workbench.parts.sidebar',
  PANEL_PART = 'workbench.parts.panel',
  AUXILIARYBAR_PART = 'workbench.parts.auxiliarybar',
  SESSIONS_PART = 'workbench.parts.sessions',
  CUSTOM_VIEW_GRID_PART = 'workbench.parts.customViewGrid',
  EDITOR_PART = 'workbench.parts.editor',
  STATUSBAR_PART = 'workbench.parts.statusbar'
}
```

### 3.2 How parts are implemented

Parts live in `vscode/src/vs/workbench/browser/parts/` (20 entries). Each part:
- Extends the `Part` base class (`vscode/src/vs/workbench/browser/part.ts`) or
  a composite variant (e.g. `PanelPart extends AbstractPaneCompositePart`
  in `parts/panel/panelPart.ts`).
- Is instantiated and laid out by the workbench grid in
  `vscode/src/vs/workbench/browser/workbench.ts`.
- Participates in serialization (layout persistence), Zen mode, context keys,
  and the `IWorkbenchLayoutService`.

### 3.3 What a native P-030 part would require

1. New `Parts.AGENTMANAGER_PART` enum entry in `layoutService.ts`.
2. New `AgentManagerPart extends Part` class under
   `vscode/src/vs/workbench/browser/parts/agentManager/` (render, layout,
   serialization, theming, context keys).
3. Registration in the workbench grid (`workbench.ts`) — position, sizing,
   show/hide commands, keybindings.
4. Layout persistence entries (so the part's visibility/size survives restart).
5. A bridge from the part's DOM into the existing `ui-manager` React bundle
   (or a rewrite of the UI against workbench widgets).

**Divergence estimate:** touches `layoutService.ts`, `workbench.ts`, plus
~5–10 new files. Every upstream upgrade that refactors the layout grid
(which happens regularly) risks conflicts. This is why the design marks
P-030 as **High** upstream risk. It would also consume a large share of the
divergence budget (currently: <25 patches, <1500 lines, <60 files).

### 3.4 The auxiliary-window alternative

`vscode/src/vs/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.ts`
provides `createAuxiliaryWindow()` — used today for floating editor windows.
A dedicated Agent Manager window could host the existing `ui-manager` React
bundle inside a webview in a separate window, driven by the same
`ManagerViewProvider` message protocol. Divergence: near zero (extension-side
only, no `vscode/` core changes).

---

## 4. Recommended approach (staged)

### Stage 1 — Match the design's Phase 1 (no core patch) ✅ RECOMMENDED FIRST

Move the Agent Manager from the Explorer sidebar (`WebviewView`) to an
editor-area panel (`vscode.window.createWebviewPanel`), exactly as §20.2
specifies. This is pure extension-API work:

**Files to modify (all in `packages/ext-agent/`, zero `vscode/` changes):**
- `src/managerView.ts`: replace `WebviewViewProvider` with a
  `WebviewPanel` manager — `createWebviewPanel('sunday.managerPanel', ...)`,
  reuse the existing HTML-serving and message-routing code verbatim.
- `package.json`: move the `sunday.managerView` contribution out of
  `views.explorer`; keep the `sunday.manager.open` command but have it
  reveal the panel instead of focusing the sidebar view.
- `src/extension.ts`: update the `sunday.manager.open` handler (currently
  `executeCommand('sunday.managerView.focus')`).

**Tests:** extend `managerView.test.ts` (mocked `vscode` module already exists).

**Why first:** closes the gap between implementation and the design doc's
Phase 1, costs no divergence budget, and is the prerequisite surface for
either Stage 2 option.

### Stage 2 — Dedicated window (low divergence)

Add a `sunday.manager.openWindow` command that opens the ui-manager bundle
in an auxiliary window (or, simpler still, a second webview panel in a new
window group via `ViewColumn.Beside` + `vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')`).

All extension-side. No `vscode/` core changes. Satisfies the "window" half
of P-030's "part/window" wording.

### Stage 3 — Native workbench part (high divergence, defer)

Only if Stage 1+2 prove insufficient (e.g. users demand a persistent,
layout-integrated dock). Requires the full item list in §3.3. Recommend
re-evaluating after 1.0-beta with real usage data. If undertaken, keep all
new code under `vscode/src/vs/workbench/browser/parts/agentManager/` and
mark every touched upstream file with `// SUNDAY(P-030)` per `patches/PATCHES.md`.

---

## 5. Divergence risk summary

| Stage | `vscode/` files touched | Budget impact | Upgrade risk |
|---|---|---|---|
| Stage 1 (editor panel) | 0 | none | none |
| Stage 2 (window) | 0 | none | none |
| Stage 3 (native part) | ~3 modified + ~8 new | ~10–15% of line budget | High (layout grid churn) |

---

## 6. Recommended first implementation step

**Implement Stage 1:** convert `ManagerViewProvider` from a sidebar
`WebviewView` to an editor-area `WebviewPanel`.

Concrete first commit:
1. In `packages/ext-agent/src/managerView.ts`, add a `ManagerPanelManager`
   class (or extend the provider) that calls `vscode.window.createWebviewPanel`
   with the same webview options, HTML, and `onDidReceiveMessage` routing
   as `resolveWebviewView` uses today.
2. Rewire `sunday.manager.open` in `src/extension.ts` to reveal the panel.
3. Remove the `views.explorer` contribution from `package.json`
   (keep the view registration until the panel is verified, then delete).
4. Update/extend `managerView.test.ts`.

No `vscode/` changes. No PAT needed (local work; push when convenient).
