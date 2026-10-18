# F11 — Browser-verified UI Loop

The agent's closed loop for frontend tasks. Every UI change ships with machine-checked
visual evidence, not "looks fine to me".

## The loop

```
1. DETECT   browser_verify_ui  → wait for dev server (readyTimeoutMs), open URL,
                                 snapshot, run checks (text_present,
                                 no_console_errors, element_visible,
                                 title_contains), screenshot → pass/fail report
2. BASELINE  browser_screenshot → save the "before" PNG
3. SCAN      browser_accessibility_scan → axe-core violations (id, impact,
                                 description, affected nodes)
             browser_console    → JS errors the change must not introduce
4. CHANGE   agent edits code (normal file tools)
5. VERIFY   browser_screenshot → "after" PNG
             browser_visual_diff(before, after) → changed-pixel count + ratio +
                                 highlighted diff PNG (evidence artifact)
             browser_accessibility_scan → zero serious/critical violations
             browser_console    → zero new errors
6. MATRIX   browser_viewport_matrix → mobile/tablet/desktop captures
                                 (custom viewports up to 8; evidence artifacts)
7. EVIDENCE  attach diff/viewport paths to the F9 Evidence Pack
             (`withVisualProof(pack, paths)`) → visualProof.kind = 'screenshot'
             walkthrough video via browser/recording → kind = 'walkthrough'
```

## When to run it

- Any task that changes rendered UI (components, CSS, layouts, copy).
- Skip only for pure backend/logic changes — record the skip in the pack's
  `unknowns` ("UI not browser-verified: no rendered output changed").

## Reading a diff result

- `diffRatio < 0.1%` on an untouched page → noise (fonts, timestamps); bump
  `threshold` or ignore.
- A focused change (button realigned) shows a **localized** diff: changed pixels
  ≈ 2× the element's footprint (old position + new position). A fullscreen wash
  of red means the layout shifted globally — investigate before shipping.
- Dimension mismatch is a hard error, not a silent rescale: re-capture both
  shots at the same viewport.

## Policy

All three F11 RPCs are observation-only and policy-gated:
- `browser/visual-diff` never touches the network — pure image math.
- `browser/accessibility-scan` injects axe via the driver (CDP), NOT the
  restricted `browser/eval` path, so it works with eval disabled.
- `browser/viewport-matrix` navigates → same origin-approval flow as
  `browser_open` (file:// blocked, private IPs blocked, new origins need
  `approve: true`). Usable during user takeover, like `browser_verify_ui`.

## Acceptance gate (F11)

Seeded UI bug (misaligned button, console error, contrast failure) — the agent
detects all three with evidence and produces a before/after diff artifact.
Covered by `packages/browserd/src/f11-loop.test.ts` (7 tests) and
`packages/browserd/src/visual-diff.test.ts` (6 tests).
