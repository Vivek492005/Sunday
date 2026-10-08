// sunday-agent — engagement: streak status bar, panel, and notifications.
//
// TWO-MODE ENGAGEMENT CONTRACT (founder directive):
//   "Passive mode: never interrupt a user who is just editing files."
//
// What each mode allows:
//   PASSIVE (no AI agent use this session):
//     - silent streak-day tracking (always on)
//     - status bar counter (a number is non-intrusive)
//     - streak MILESTONE celebrations (7/14/30 days) — max 1/day
//     - 8 PM at-risk nudge — max 1/day, dismissible
//     - NO quest prompts, NO XP popups, NO achievement toasts
//   ACTIVE (AI agent used this session):
//     - everything in passive, PLUS future quest/achievement/XP UI
//
// FUTURE MECHANICS (quests, achievements, XP — later phases) MUST check
// isFullEngagementAllowed() before showing anything unsolicited. The streak
// milestone + at-risk notifications below are explicitly allowed in BOTH
// modes and must NOT be gated on active mode.

import * as vscode from 'vscode';
import {
  ActivityStore,
  EditActivityTracker,
  localDayKey,
} from './activity.js';
import {
  StreakStore,
  highestMilestoneReached,
  markMilestoneNotified,
  markRiskNotified,
  nextMilestone,
  refreshStreak,
  setVacationMode,
  type StreakInfo,
} from './streak.js';
import {
  getEngagementMode,
  parseQuietModeSetting,
  type QuietModeSetting,
} from './mode.js';

export const STREAK_STATUS_BAR_PRIORITY = 90;
export const STREAK_SHOW_COMMAND = 'sunday.streak.show';
export const STREAK_VACATION_COMMAND = 'sunday.streak.vacation';
/** How often (ms) the at-risk check runs. */
export const STREAK_RISK_CHECK_MS = 15 * 60_000;

export interface StreakViewDeps {
  activity?: ActivityStore;
  streakStore?: StreakStore;
  editTracker?: EditActivityTracker;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Read an engagement setting. */
  getConfig?: (key: 'streaksEnabled' | 'streakNotifications') => boolean;
  /** Read the quiet-mode setting (auto/passive/active). */
  getQuietMode?: () => QuietModeSetting;
  showWarningMessage?: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  showQuickPick?: <T extends vscode.QuickPickItem>(
    items: T[] | Thenable<T[]>,
    options?: vscode.QuickPickOptions,
  ) => Thenable<T | undefined>;
  showInputBox?: (options?: vscode.InputBoxOptions) => Thenable<string | undefined>;
  showInformationMessage?: (message: string, ...items: string[]) => Thenable<string | undefined>;
}

type BoolKey = 'streaksEnabled' | 'streakNotifications';

function defaultConfig(key: BoolKey): boolean {
  try {
    return vscode.workspace.getConfiguration('sunday.engagement').get<boolean>(key, true);
  } catch {
    return true;
  }
}

function defaultQuietMode(): QuietModeSetting {
  try {
    const raw = vscode.workspace
      .getConfiguration('sunday.engagement')
      .get<unknown>('quietMode', 'auto');
    return parseQuietModeSetting(raw);
  } catch {
    return 'auto';
  }
}

/** Singleton tracker the rest of the extension records activity through. */
let sharedTracker: {
  activity: ActivityStore;
  edits: EditActivityTracker;
} | null = null;

export function getEngagementTracker(): {
  activity: ActivityStore;
  edits: EditActivityTracker;
} {
  if (!sharedTracker) {
    const activity = new ActivityStore();
    sharedTracker = { activity, edits: new EditActivityTracker(activity) };
  }
  return sharedTracker;
}

/** Test seam: replace the singleton. */
export function __setEngagementTracker(
  t: { activity: ActivityStore; edits: EditActivityTracker } | null,
): void {
  sharedTracker = t;
}

function streakLabel(info: StreakInfo): string {
  if (info.current <= 0) return '$(flame) Start a streak!';
  return `$(flame) ${info.current}`;
}

function streakTooltip(info: StreakInfo): string {
  const lines = [
    `Coding streak: ${info.current} day${info.current === 1 ? '' : 's'}`,
    `Longest: ${info.longest} day${info.longest === 1 ? '' : 's'}`,
    `Freezes available: ${info.freezesAvailable}`,
  ];
  const m = info.nextMilestone;
  if (m) {
    lines.push(
      `Next reward: +${m.bonus} AI requests/day in ${m.daysAway} day${m.daysAway === 1 ? '' : 's'} (${m.atDays}-day streak)`,
    );
  } else if (info.current >= 30) {
    lines.push('Max streak bonus active: +500 AI requests/day');
  }
  if (info.onVacation) lines.push(`Vacation mode until ${info.vacationUntil}`);
  lines.push('Click to open your streak panel');
  return lines.join('\n');
}

/**
 * Register the streak status bar item, panel commands, git-commit watcher,
 * and the at-risk notifier. Returns disposables (plus a `disposeAll`).
 */
export function registerStreakEngagement(
  context: vscode.ExtensionContext,
  deps: StreakViewDeps = {},
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());
  const getConfig = deps.getConfig ?? defaultConfig;
  const getQuietMode = deps.getQuietMode ?? defaultQuietMode;
  const tracker = { activity: deps.activity ?? getEngagementTracker().activity };
  const streakStore = deps.streakStore ?? new StreakStore(undefined, now);
  const showWarningMessage =
    deps.showWarningMessage ?? vscode.window.showWarningMessage;
  const showQuickPick = deps.showQuickPick ?? vscode.window.showQuickPick;
  const showInputBox = deps.showInputBox ?? vscode.window.showInputBox;
  const showInformationMessage =
    deps.showInformationMessage ?? vscode.window.showInformationMessage;

  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    STREAK_STATUS_BAR_PRIORITY,
  );
  item.command = STREAK_SHOW_COMMAND;

  /** Current engagement mode (for documentation/logging; milestones + at-risk
   *  are allowed in BOTH modes, so this is informational here). */
  const mode = (): 'passive' | 'active' => getEngagementMode(getQuietMode());

  const render = (): void => {
    if (!getConfig('streaksEnabled')) {
      item.hide();
      return;
    }
    try {
      const info = refreshStreak(streakStore, tracker.activity, now());
      item.text = streakLabel(info);
      item.tooltip = streakTooltip(info);
      item.show();
      // Milestone celebrations are allowed in BOTH modes (founder directive).
      void checkMilestones(info);
    } catch (err) {
      log(`streak: render failed: ${(err as Error).message}`);
    }
  };

  /**
   * Celebrate streak milestones (7/14/30 days → bonus rate limits).
   * Allowed in BOTH passive and active mode — max one celebration per tier.
   * In passive mode this is the ONLY proactive notification besides the
   * at-risk nudge; keep it to a single dismissible message.
   */
  const checkMilestones = async (info: StreakInfo): Promise<void> => {
    if (!getConfig('streakNotifications')) return;
    const tier = highestMilestoneReached(info.current);
    if (tier === 0 || tier <= info.lastMilestoneNotifiedAt) return;
    markMilestoneNotified(streakStore, tier);
    const bonus = tier === 30 ? 500 : tier === 14 ? 200 : 100;
    // Same quiet toast in both modes for v1: milestones are one of the two
    // notifications explicitly allowed in passive mode.
    const message =
      `🔥 ${tier}-day coding streak! ` +
      `You've unlocked +${bonus} bonus AI requests/day.` +
      (mode() === 'active' ? ' Keep shipping!' : '');
    try {
      await showInformationMessage(message, 'View streak');
    } catch {
      /* never break on notification failure */
    }
  };

  const openPanel = async (): Promise<void> => {
    if (!getConfig('streaksEnabled')) {
      void showInformationMessage(
        'Streaks are disabled. Enable sunday.engagement.streaksEnabled to use them.',
      );
      return;
    }
    const info = refreshStreak(streakStore, tracker.activity, now());
    const m = info.nextMilestone;
    const items: (vscode.QuickPickItem & { action?: string })[] = [
      {
        label: `$(flame) Current streak: ${info.current} day${info.current === 1 ? '' : 's'}`,
        description: info.todayIsActive ? 'today counts!' : 'code today to keep it going',
      },
      {
        label: `$(trophy) Longest streak: ${info.longest}`,
      },
      {
        label: `$(shield) Freezes available: ${info.freezesAvailable}`,
        description: 'a freeze saves your streak when you miss one day',
      },
      ...(m
        ? [
            {
              label: `$(gift) Next reward: +${m.bonus} AI requests/day`,
              description: `${m.daysAway} day${m.daysAway === 1 ? '' : 's'} to go (${m.atDays}-day streak)`,
            },
          ]
        : [
            {
              label: '$(gift) Max reward active: +500 AI requests/day',
              description: '30-day streak',
            },
          ]),
      ...(info.onVacation
        ? [{ label: `$(plane) Vacation mode until ${info.vacationUntil}` }]
        : [
            {
              label: '$(plane) Start vacation mode',
              description: 'pause your streak, up to 14 days/year',
              action: 'vacation',
            },
          ]),
    ];
    const picked = await showQuickPick(items, {
      title: 'Sunday Coding Streak',
      placeHolder: 'Your streak at a glance',
    });
    if (picked?.action === 'vacation') {
      await startVacationFlow();
    }
    render();
  };

  const startVacationFlow = async (): Promise<void> => {
    const raw = await showInputBox({
      title: 'Vacation mode',
      prompt: 'How many days? (1–14 per year, streak pauses — never breaks)',
      validateInput: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 14
          ? null
          : 'Enter a whole number of days (1–14).';
      },
    });
    if (!raw) return;
    const until = setVacationMode(streakStore, Number(raw), now());
    if (!until) {
      void showWarningMessage(
        'Could not start vacation mode — you may have used your 14 days for this year.',
      );
      return;
    }
    void showInformationMessage(`Vacation mode on until ${until}. Enjoy the break!`);
  };

  /**
   * Fire the at-risk nudge at most once per day.
   * Allowed in BOTH modes: it protects the user's streak (founder directive),
   * is dismissible, and can be disabled via sunday.engagement.streakNotifications.
   */
  const checkAtRisk = (): void => {
    if (!getConfig('streaksEnabled') || !getConfig('streakNotifications')) return;
    try {
      const info = refreshStreak(streakStore, tracker.activity, now());
      if (!info.atRisk) return;
      markRiskNotified(streakStore, now());
      void showWarningMessage(
        `Your ${info.current}-day coding streak is at risk! Commit, code for 30 min, or finish an AI task before midnight to keep it alive.`,
        'Open streak panel',
      ).then((choice) => {
        if (choice === 'Open streak panel') void openPanel();
      });
    } catch (err) {
      log(`streak: at-risk check failed: ${(err as Error).message}`);
    }
  };

  const disposables: vscode.Disposable[] = [
    item,
    vscode.commands.registerCommand(STREAK_SHOW_COMMAND, () => void openPanel()),
    vscode.commands.registerCommand(STREAK_VACATION_COMMAND, () => void startVacationFlow()),
  ];

  // Edit activity → streak qualifying minutes.
  try {
    const edits = deps.editTracker ?? getEngagementTracker().edits;
    disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => {
        try {
          edits.noteEdit();
        } catch {
          /* never break typing */
        }
      }),
    );
  } catch {
    /* tests / headless */
  }

  // Initial render + periodic at-risk checks.
  render();
  const timer = setInterval(checkAtRisk, STREAK_RISK_CHECK_MS);
  // Run once shortly after activation (catches the 8 PM window).
  const kickoff = setTimeout(checkAtRisk, 30_000);
  const clearTimers: vscode.Disposable = {
    dispose: () => {
      clearInterval(timer);
      clearTimeout(kickoff);
    },
  };
  disposables.push(clearTimers);

  // Watch git HEAD changes → recordCommit. Best-effort; never throws.
  void watchGitHead(tracker.activity, log).then((d) => {
    if (d) disposables.push(d);
  });

  return vscode.Disposable.from(...disposables);
}

/**
 * Subscribe to the built-in git extension's repo state and record a commit
 * whenever HEAD moves to a new SHA. Fully defensive — resolves to undefined
 * when the git extension is absent (tests, web).
 */
async function watchGitHead(
  activity: ActivityStore,
  log: (msg: string) => void,
): Promise<vscode.Disposable | undefined> {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return undefined;
    const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
    const api = exports?.getAPI?.(1);
    if (!api?.repositories) return undefined;
    const disposables: vscode.Disposable[] = [];
    const headByRepo = new Map<string, string>();
    const watchRepo = (repo: {
      rootUri?: { toString(): string };
      state?: { HEAD?: { commit?: string }; onDidChange?: vscode.Event<void> };
    }): void => {
      try {
        const key = repo.rootUri?.toString() ?? `repo-${disposables.length}`;
        headByRepo.set(key, repo.state?.HEAD?.commit ?? '');
        const evt = repo.state?.onDidChange;
        if (typeof evt !== 'function') return;
        disposables.push(
          evt(() => {
            try {
              const sha = repo.state?.HEAD?.commit ?? '';
              const prev = headByRepo.get(key);
              if (sha && prev !== undefined && sha !== prev) {
                activity.recordCommit();
              }
              headByRepo.set(key, sha);
            } catch {
              /* ignore */
            }
          }),
        );
      } catch {
        /* ignore */
      }
    };
    for (const repo of api.repositories ?? []) watchRepo(repo);
    const onDidOpen = api.onDidOpenRepository;
    if (typeof onDidOpen === 'function') {
      disposables.push(onDidOpen(watchRepo));
    }
    return vscode.Disposable.from(...disposables);
  } catch (err) {
    log(`streak: git watch unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

/** Current streak day count for the gateway's X-Sunday-Streak-Days header. */
export function currentStreakDays(
  streakStore?: StreakStore,
  activity?: ActivityStore,
  now: Date = new Date(),
): number {
  try {
    const t = getEngagementTracker();
    const info = refreshStreak(
      streakStore ?? new StreakStore(undefined, () => now),
      activity ?? t.activity,
      now,
    );
    return info.current;
  } catch {
    return 0;
  }
}

/** Today's date key — used by tests. */
export function todayKey(now: Date = new Date()): string {
  return localDayKey(now);
}
