// sunday-agent — engagement: two-mode engagement (passive vs active).
//
// DESIGN CONTRACT (founder directive):
//   "Passive mode: never interrupt a user who is just editing files."
//
// - PASSIVE MODE (user treats Sunday as plain VS Code — read/write/edit,
//   no AI agents): only silent streak-day tracking runs. The status bar
//   streak counter still shows (a number is non-intrusive). The ONLY
//   notifications allowed are streak-milestone celebrations (7/14/30 days,
//   max 1/day) and the 8 PM at-risk nudge (max 1/day, dismissible).
// - ACTIVE MODE (user has used an AI agent feature this session): full
//   engagement — quests, achievements, XP popups, bonus celebrations.
//   (Quests/achievements/XP land in later phases; they MUST check
//   `isFullEngagementAllowed()` before showing anything.)
//
// Streak tracking itself ALWAYS runs in both modes — it is the foundation
// every other mechanic builds on.

/** Engagement UI mode. */
export type EngagementMode = 'passive' | 'active';

/** Values for the `sunday.engagement.quietMode` setting. */
export type QuietModeSetting = 'auto' | 'passive' | 'active';

/** Module-level session flag. Reset only by tests. */
let agentUsedThisSession = false;

/**
 * Call on the first AI agent interaction of the session (AI task completed,
 * suggestion accepted, agent chat used). Idempotent.
 */
export function markAgentUsed(): void {
  agentUsedThisSession = true;
}

/** Test seam: reset the session flag. */
export function __resetAgentUsedFlag(): void {
  agentUsedThisSession = false;
}

/** Test seam: read the session flag. */
export function hasUsedAgentThisSession(): boolean {
  return agentUsedThisSession;
}

/**
 * Resolve the current engagement mode.
 *
 * - quietMode 'passive' → always passive (user forced quiet).
 * - quietMode 'active'  → always active (user opted into full engagement).
 * - quietMode 'auto' (default) → active only after an AI agent interaction
 *   this session; otherwise passive.
 */
export function getEngagementMode(quietMode: QuietModeSetting = 'auto'): EngagementMode {
  if (quietMode === 'passive') return 'passive';
  if (quietMode === 'active') return 'active';
  return agentUsedThisSession ? 'active' : 'passive';
}

/**
 * Whether quest/achievement/XP UI is allowed right now.
 *
 * FUTURE MECHANICS (quests, achievements, XP toasts) MUST call this before
 * showing anything unsolicited. Streak milestones and the at-risk nudge are
 * governed separately — they are allowed in BOTH modes (see streakView.ts).
 */
export function isFullEngagementAllowed(
  quietMode: QuietModeSetting = 'auto',
): boolean {
  return getEngagementMode(quietMode) === 'active';
}

/** Parse the raw setting value; unknown values fall back to 'auto'. */
export function parseQuietModeSetting(v: unknown): QuietModeSetting {
  return v === 'passive' || v === 'active' || v === 'auto' ? v : 'auto';
}
