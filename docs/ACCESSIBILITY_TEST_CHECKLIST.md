# Accessibility Human Test Checklist — Sunday 1.0-beta

**Gate:** #8 (Accessibility) — human screen-reader pass required to flip from Partial to Green.
**Estimated time:** 30 minutes.
**Prerequisites:**
- Sunday 1.0-beta (or latest main) installed — VSIX + sundayd running
- A test workspace folder open
- Screen reader:
  - **Windows:** [NVDA](https://www.nvaccess.org/download/) (free) — start with `Ctrl+Alt+N`
  - **macOS:** VoiceOver — enable with `Cmd+F5`, navigate with `Ctrl+Option+←/→`

**How to report:** For each step, mark PASS / FAIL / N-A. For FAIL, fill the issue template at the bottom.

---

## Part A — Chat view (10 min)

| # | Step | Keys / Action | Verify (what the screen reader should say/do) | Result |
|---|---|---|---|---|
| A1 | Focus the chat input | `Ctrl+Shift+C`, then `Tab` until the input | Input is announced as "Chat input, edit" (or "combo box"); typing echoes characters | ☐ PASS ☐ FAIL |
| A2 | Open the @-mention popup | Type `@a` in the chat input | Popup announced as listbox; `↓` moves through options, each announced; `Esc` dismisses and returns focus to input | ☐ PASS ☐ FAIL |
| A3 | Send a message | Type "hello", press `Enter` | Message appears in the log; screen reader announces the new message via the live region ("Sunday chat messages") | ☐ PASS ☐ FAIL |
| A4 | Streaming indicator | Send a longer prompt ("write a haiku") | While streaming, a "Streaming…" indicator is announced (not silent, not overly verbose) | ☐ PASS ☐ FAIL |
| A5 | Stop button | While a turn is running, `Tab` to the Stop control | Announced as "Stop the active turn, button"; `Enter` stops the turn | ☐ PASS ☐ FAIL |
| A6 | Model picker | `Tab` to the model dropdown | Announced as "Model, combo box"; `↑`/`↓` changes model, announced | ☐ PASS ☐ FAIL |
| A7 | Voice input (if enabled) | Enable `sunday.voice.inputEnabled`, `Tab` to the mic button | Announced as "Start voice input, button"; when listening, "Stop voice input"; status "Listening…" announced via live region | ☐ PASS ☐ FAIL ☐ N/A |
| A8 | Voice output toggle (if enabled) | Enable `sunday.voice.outputEnabled`, `Tab` to the speaker button | Announced as "Mute spoken responses, toggle button, pressed" / "not pressed"; `Enter` toggles | ☐ PASS ☐ FAIL ☐ N/A |

## Part B — Manager view (8 min)

| # | Step | Keys / Action | Verify | Result |
|---|---|---|---|---|
| B1 | Open Manager | Command palette → "Sunday: Open Agent Manager" | View opens; headings announced ("Orchestration", "Agents", etc.) | ☐ PASS ☐ FAIL |
| B2 | Navigate unit cards | `Tab` through the cards | Each card announced with title + status (e.g. "refactor auth — running"); focus ring visible | ☐ PASS ☐ FAIL |
| B3 | Expand a unit card | `Enter` or `Space` on a card | Card expands; announced as "expanded"; log text readable in DOM order; `Enter` again collapses ("collapsed") | ☐ PASS ☐ FAIL |
| B4 | Stop-all orchestration | `Tab` to "Stop all" button | Announced as "Stop all, button"; disabled state announced when no active run ("dimmed"/"unavailable") | ☐ PASS ☐ FAIL |
| B5 | Conflict resolution (if present) | `Tab` to "Keep …" / "Open diff" buttons | Each button announced with its label; disabled buttons announced as unavailable (not just visually greyed) | ☐ PASS ☐ FAIL ☐ N/A |
| B6 | Error dismissal | (Trigger an error, e.g. invalid action) | Error announced immediately (alert); "Dismiss" button reachable and announced | ☐ PASS ☐ FAIL |

## Part C — Agent Browser panel (5 min)

| # | Step | Keys / Action | Verify | Result |
|---|---|---|---|---|
| C1 | Focus URL bar | Open Agent Browser panel, `Tab` | Announced as "Browser URL, edit"; `Enter` opens the typed URL | ☐ PASS ☐ FAIL |
| C2 | Panel buttons | `Tab` through Open / Reload / Close session / Take over / Resume agent / Screenshot | Each announced with its label; tooltips match the announced purpose | ☐ PASS ☐ FAIL |
| C3 | Control handover | `Tab` to "Take over", `Enter` | Status badge announces the control change (live region, e.g. "you have control") | ☐ PASS ☐ FAIL |
| C4 | Screenshot | `Tab` to "Screenshot", `Enter` | Captured image announced with alt text ("captured screenshot") | ☐ PASS ☐ FAIL |

## Part D — MCP panel (4 min)

| # | Step | Keys / Action | Verify | Result |
|---|---|---|---|---|
| D1 | Server list | Open MCP view, `Tab` through servers | Server names announced; Start/Restart/Stop buttons labelled per server | ☐ PASS ☐ FAIL |
| D2 | Approval button | (Trigger a dangerous tool, or inspect the tools list) | "Approve"/"Revoke" buttons announced with the tool name | ☐ PASS ☐ FAIL |
| D3 | Banner announcement | (Trigger an MCP error, e.g. stop a server) | Error banner announced immediately (alert role) | ☐ PASS ☐ FAIL |

## Part E — Native VS Code flows (3 min)

These use VS Code's native UI — verify they behave as expected with the screen reader:

| # | Step | Verify | Result |
|---|---|---|---|
| E1 | Inline edit (`Ctrl+I`) | Instruction input is a labelled text field; `Esc` cancels; diff view navigable | ☐ PASS ☐ FAIL |
| E2 | Diff accept/reject | Modal dialog announced; `←`/`→` moves between Accept/Reject; `Enter` confirms | ☐ PASS ☐ FAIL |
| E3 | MCP trust prompt | Dialog announced with server name; Approve/Reject buttons clear | ☐ PASS ☐ FAIL |

---

## Issue template

Copy for each FAIL:

```
**Step:** (e.g. A4)
**Screen reader + version:** (e.g. NVDA 2024.4 / VoiceOver macOS 15)
**Expected:** (what should happen)
**Actual:** (what happened instead)
**Repro:** (minimal steps)
**Severity:** blocker / major / minor
```

## Sign-off

- [ ] All applicable steps PASS (or have filed issues above)
- [ ] No keyboard traps found (could `Tab`/`Shift+Tab` through every view and escape)
- [ ] No unlabeled controls found

**Tester:** _________________ **Date:** _____________

**Result:** ☐ GREEN (gate #8 can flip) ☐ NEEDS FIXES (issues filed above)
