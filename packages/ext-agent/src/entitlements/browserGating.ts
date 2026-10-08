// sunday-agent — browser-agent entitlement gate (Task 7).
//
// When the cached entitlements deny the browser agent, the panel shows a
// disabled state with the upsell message below and browserd is never
// started. Fail open: unknown entitlements (no provider / no cache yet)
// allow the browser, and the daemon re-checks before doing anything.

import { canUseBrowserAgent, type EntitlementsView } from './types.js';

/**
 * Product-specified upsell copy shown on the disabled browser panel
 * (tooltip + notice). This is a static UI string, not a plan-name branch —
 * the actual decision is the `browser_agent.enabled` entitlement check in
 * `browserAllowedByView()`.
 */
export const BROWSER_PLAN_MESSAGE = 'Browser agent requires a Smart plan or higher';

/**
 * True when the browser agent may run. Returns true (fail open) when the
 * view is unknown — the `sunday.browser.enabled` opt-in and the daemon's
 * own gate still apply.
 */
export function browserAllowedByView(view: EntitlementsView | undefined): boolean {
  if (!view) return true;
  return canUseBrowserAgent(view);
}
