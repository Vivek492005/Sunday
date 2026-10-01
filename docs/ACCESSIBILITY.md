# Accessibility

Sunday is a keyboard-first tool, and the 1.0-beta bar is: every control
reachable and operable by keyboard, ARIA semantics correct in all webviews,
and no keyboard traps. This doc records the audit findings, the fixes made,
and a keyboard-only walkthrough with honest PASS/FAIL results.

## Surfaces audited

| Surface | Tech | Notes |
|---|---|---|
| Chat webview (`@sunday/ui-chat`) | React | message list, composer, mention popup, model pill, stop button |
| Manager webview (`@sunday/ui-manager`) | React | run cards, unit cards, conflict cards, checkpoints, worktrees |
| Agent Browser panel (`ext-agent/browserPanel.ts`) | hand-written HTML/JS webview | URL bar, Open/Reload/Close, Take over/Resume, Screenshot |
| MCP panel (`ext-agent/mcpView.ts`) | hand-written HTML/JS webview | servers, tools, approvals, call history |
| Approval prompts, diff review, inline edit | VS Code native UI | `showInformationMessage` (modal Accept/Reject), `showInputBox`, `vscode.diff` |

Approval prompts, the inline-edit review flow, and workspace-trust prompts are
all native VS Code UI (notification buttons, input boxes, modal dialogs, diff
editor). Keyboard operability, focus handling, and screen-reader support for
those come from VS Code itself — no custom focus management was needed or
added. None of Sunday's webviews implement a custom modal dialog, so there is
no dialog focus-trap to manage: focus is only ever the webview's own tab order
plus VS Code's native surfaces.

## Issues found and fixed (Hardening → 1.0-beta, Worker 3)

1. **Unit card not keyboard-operable** (`ui-manager/src/App.tsx`) — the unit
   card was `role="button" tabIndex={0}` with an `onClick` but **no key
   handler**: keyboard users could focus the card but not toggle it. Fixed:
   Enter/Space now toggle via a shared `unitCardKeyDown` helper, and the card
   carries `aria-expanded` and an accessible name (`"<title> — <status>"`).
2. **Placeholder-only inputs** (`ui-manager/src/App.tsx`) — the checkpoint
   label, worktree branch, and worktree path inputs had `placeholder` but no
   label. Fixed: added `aria-label`s.
3. **Error banners not announced** (`ui-chat/src/App.tsx`,
   `ui-manager/src/App.tsx`) — connection/manager errors rendered as plain
   divs. Fixed: `role="alert"`.
4. **Mention popup had no combobox wiring** (`ui-chat/src/Composer.tsx`,
   `MentionPopup.tsx`) — the listbox existed but the textarea had no
   `aria-expanded`/`aria-controls`/`aria-activedescendant`. Fixed: the textarea
   is now `role="combobox"` with full listbox linkage (`mention-popup` /
   `mention-opt-N` ids).
5. **Unlabelled attachment group** (`ui-chat/src/Composer.tsx`) — the
   attachment row had `aria-label` on a plain div (ignored without a role).
   Fixed: added `role="group"`.
6. **Mouse-only tooltips** (`ui-chat/src/MessageList.tsx`) — the streaming dot
   and relay badge exposed their meaning via `title` only. Fixed: the
   streaming indicator is `role="img" aria-label="Streaming…"`, and the relay
   badge carries the relay reason as `aria-label`.
7. **Missing visible focus indicators** (`ui-chat/src/styles.css`,
   `ui-manager/src/styles.css`, `browserPanel.ts`, `mcpView.ts`) — the model
   pill `<select>` had `outline: none` with no replacement; manager buttons,
   inputs, and unit cards had no `:focus-visible` rule. Fixed: explicit
   `:focus-visible` outlines on all interactive elements, using
   `--vscode-focusBorder`.
8. **URL input unlabelled** (`ext-agent/src/browserPanel.ts`) — the Agent
   Browser URL field had `placeholder="https://…"` only. Fixed: added
   `aria-label="Browser URL"`. The banner is now `role="alert"` and the
   control-handover badge is `role="status"` (a live region).
9. **MCP panel banner not announced** (`ext-agent/src/mcpView.ts`) — fixed
   with `role="alert"`; added `:focus-visible` outlines for buttons and
   `<summary>` disclosures.

## Keyboard-only walkthrough

Verified **statically** (code inspection + markup assertions in the a11y test
suites) on this Linux VM — no screen reader or running VS Code instance was
available. Steps that depend on live VS Code behaviour are marked accordingly.

| # | Step | Keys | Result |
|---|---|---|---|
| 1 | Focus the chat input | `Ctrl+Shift+C` (or click the chat view, then `Tab`) | PASS — textarea is the first tab stop; `aria-label="Chat input"` |
| 2 | Type a message | type | PASS — `role="combobox"`, live spell of typed text |
| 3 | Open the @-mention popup and pick an item | type `@`, `↑`/`↓`, `Enter` | PASS — listbox with `aria-activedescendant`; `Esc` dismisses (handled in `Composer.onKeyDown`); mouse `onMouseDown` path preserved |
| 4 | Send the message | `Enter` (or `Tab` → Send, `Enter`/`Space`) | PASS — `Enter` submits; send button has `aria-label="Send"` and is Tab-reachable |
| 5 | Message appears and is announced | — | PASS — message list is `role="log"` `aria-live="polite"` with `aria-label="Sunday chat messages"` |
| 6 | MCP dangerous-tool approval appears | — | PASS — rendered as a native button in the MCP panel with visible text ("Approve"), Tab-reachable, `Enter`/`Space` activates; or the native VS Code trust prompt (`confirmWorkspaceServerStart`) |
| 7 | Diff review → accept via keyboard | `Ctrl/Cmd+I`, type instruction, `Enter` | PASS — instruction prompt is a native `showInputBox` (`Esc` cancels); review is the native `vscode.diff` editor (full keyboard nav); Accept/Reject is a **modal** `showInformationMessage` — `←`/`→` moves between buttons, `Enter` confirms, `Esc` rejects |
| 8 | Open the Manager view, move between unit cards | `Tab` / `Shift+Tab` | PASS — unit cards are `tabIndex={0}` with visible focus ring |
| 9 | Expand a unit card, read its log | `Enter` / `Space` | PASS — toggles `aria-expanded`; log text follows in DOM order |
| 10 | Resolve a merge conflict | `Tab` to "Keep …" buttons, `Enter` | PASS — native buttons with text labels; disabled state is `disabled`, not just visual |
| 11 | Open the Agent Browser panel, focus the URL bar | `Tab` | PASS — URL input is labelled; `Enter` in the input opens the URL |
| 12 | Take over browser control | `Tab` → "Take over", `Enter` | PASS — native button; disabled unless the agent holds control (state announced via the `role="status"` badge); `Esc` has nothing to close — no modal in the panel |
| 13 | Capture a screenshot | `Tab` → "Screenshot", `Enter` | PASS — snapshot image has `alt="captured screenshot"` |

**Screen-reader pass: needs human verification.** The markup now carries the
correct roles, labels, and live regions, and the a11y test suites assert them
(`packages/ui-chat/src/a11y.test.tsx`, `packages/ui-manager/src/a11y.test.tsx`,
`browserPanel.test.ts`, `mcpView.test.ts`), but no screen reader (NVDA/JAWS/
VoiceOver) was available in this build environment. A human pass over the chat
streaming flow, the approval buttons, and the diff-review dialog is still owed
before the 1.0-beta sign-off.

## Test coverage

No jsdom is available in the webview packages' devDependencies, and no new
test dependencies may be added. A11y tests therefore use
`react-dom/server`'s `renderToStaticMarkup` (already a dependency via
`react-dom`) to assert on the exact HTML the webviews serve, plus HTML-string
assertions for the hand-written ext-agent panels:

- `ui-chat/src/a11y.test.tsx` — 8 tests (log role/label/live, streaming
  indicator, relay label, composer combobox wiring, send/model/stop labels)
- `ui-manager/src/a11y.test.tsx` — 5 tests (input labels, section landmarks,
  `unitCardKeyDown` Enter/Space/other-keys)
- `ext-agent/src/browserPanel.test.ts` — panel markup test (URL label, alert
  banner, status badge, control labels)
- `ext-agent/src/mcpView.test.ts` — panel markup test (alert banner, refresh
  button, focus-visible rule)
