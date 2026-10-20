/**
 * Sunday IDE — streakService.ts (engagement: streaks in the IDE shell)
 *
 * Thin, crash-proof wrapper over the vscode-free streak engine that already
 * ships in packages/ext-agent/src/engagement/:
 *   - StreakStore / refreshStreak — streak state (~/.sunday/engagement/streak.json)
 *   - ActivityStore / EditActivityTracker — qualifying activity
 *     (~/.sunday/engagement/activity.json)
 *
 * A day qualifies via commit OR completed AI task OR 30+ min active editing
 * OR merged PR (test runs are recorded but never qualify alone — that bar is
 * the engine's own `isStreakDay`, unchanged here).
 *
 * SAFETY CONTRACT: engagement is decorative. No export of this module may
 * ever throw into a caller — every body is wrapped, and getStreakInfo falls
 * back to the engine's own zero state on error.
 */
import {
  StreakStore,
  refreshStreak,
  defaultStreakState,
  type StreakInfo,
} from '../../ext-agent/src/engagement/streak.js';
import {
  ActivityStore,
  EditActivityTracker,
} from '../../ext-agent/src/engagement/activity.js';

export type { StreakInfo };

export interface StreakService {
  getStreakInfo(): StreakInfo;
  recordAgentTaskCompleted(): void;
  recordCommitMade(): void;
  recordTestsRan(): void;
  noteEditActivity(atMs?: number): void;
  resetEditActivity(): void;
}

/**
 * Error-path fallback ONLY: the engine's own zero state (defaultStreakState)
 * plus the StreakInfo view fields at their empty values. These are not
 * fabricated counts — they are exactly what refreshStreak returns for a
 * brand-new user, used solely when the real read unexpectedly throws.
 */
function zeroStreakInfo(): StreakInfo {
  return {
    ...defaultStreakState(new Date().getFullYear()),
    todayKey: '',
    todayIsActive: false,
    onVacation: false,
    atRisk: false,
    nextMilestone: null,
  };
}

/**
 * Build a streak service over one StreakStore + one ActivityStore + one
 * EditActivityTracker fed by that store. `baseDir` is forwarded to both
 * stores (their constructor arg — tests point it at a temp dir; production
 * passes nothing and gets ~/.sunday/engagement).
 */
export function createStreakService(baseDir?: string): StreakService {
  const streakStore = new StreakStore(baseDir);
  const activityStore = new ActivityStore(baseDir);
  const editTracker = new EditActivityTracker(activityStore);

  return {
    getStreakInfo(): StreakInfo {
      try {
        // refreshStreak is idempotent — safe to call on every read.
        return refreshStreak(streakStore, activityStore);
      } catch {
        return zeroStreakInfo();
      }
    },
    recordAgentTaskCompleted(): void {
      try {
        activityStore.recordAITaskCompleted();
      } catch {
        // Engagement must never break an agent turn.
      }
    },
    recordCommitMade(): void {
      try {
        activityStore.recordCommit();
      } catch {
        // Engagement must never break a commit.
      }
    },
    recordTestsRan(): void {
      try {
        activityStore.recordTestRun();
      } catch {
        // Engagement must never break a test run.
      }
    },
    noteEditActivity(atMs?: number): void {
      try {
        if (atMs === undefined) editTracker.noteEdit();
        else editTracker.noteEdit(atMs);
      } catch {
        // Engagement must never break editing.
      }
    },
    resetEditActivity(): void {
      try {
        editTracker.reset();
      } catch {
        // Engagement must never break the editor.
      }
    },
  };
}

/** Production singletons — one store set for the whole main process. */
const singleton = createStreakService();

export const getStreakInfo: StreakService['getStreakInfo'] = singleton.getStreakInfo;
export const recordAgentTaskCompleted: StreakService['recordAgentTaskCompleted'] =
  singleton.recordAgentTaskCompleted;
export const recordCommitMade: StreakService['recordCommitMade'] = singleton.recordCommitMade;
export const recordTestsRan: StreakService['recordTestsRan'] = singleton.recordTestsRan;
export const noteEditActivity: StreakService['noteEditActivity'] = singleton.noteEditActivity;
export const resetEditActivity: StreakService['resetEditActivity'] = singleton.resetEditActivity;
