/**
 * Stage 4: notification routing refinements for the Sunday extension.
 *
 * Two concerns, one module:
 *
 * 1. **Level filtering** (`sunday.notifications.level`): `all` surfaces
 *    every daemon notification; `important` only surfaces errors, relay
 *    failovers, and turn failures; `none` suppresses all daemon-driven UI
 *    notifications (the chat view still updates — this only gates the
 *    `vscode.window.show*` popups).
 *
 * 2. **Per-workspace routing**: the daemon stamps `chat/event`
 *    notifications with the session's `workspaceRoot`. Each VS Code window
 *    runs its own extension host, so "routing to the right window" means:
 *    only surface a UI notification when the event's workspace matches a
 *    workspace folder open in *this* window. Events for other workspaces
 *    are still delivered to the chat view (session-scoped), just not as
 *    popups here.
 */

export type NotificationLevel = 'all' | 'important' | 'none';

/** Parse the `sunday.notifications.level` setting value. Defaults to 'all'. */
export function parseNotificationLevel(raw: unknown): NotificationLevel {
  return raw === 'important' || raw === 'none' ? raw : 'all';
}

/** Event types that always count as "important". */
const IMPORTANT_EVENT_TYPES = new Set([
  'turn-error', // agent turn failed
]);

export interface RoutedNotification {
  /** chat/event notification params (or any daemon notification params). */
  params: {
    event?: { type?: string };
    via?: string;
    workspaceRoot?: string;
    [key: string]: unknown;
  };
  /** Daemon notification method, e.g. 'chat/event'. */
  method: string;
}

/**
 * Decide whether a daemon notification should surface as a VS Code UI
 * popup at the given level.
 *
 * - `none` → never.
 * - `important` → turn errors and relay failovers only.
 * - `all` → everything.
 */
export function shouldSurfaceNotification(n: RoutedNotification, level: NotificationLevel): boolean {
  if (level === 'none') return false;
  if (level === 'all') return true;
  // 'important'
  const eventType = n.params.event?.type;
  if (eventType && IMPORTANT_EVENT_TYPES.has(eventType)) return true;
  if (n.params.via === 'relay') return true;
  return false;
}

/**
 * Decide whether a notification belongs to *this* window. The daemon
 * stamps `workspaceRoot` on chat/event notifications; when it is absent
 * (older daemon, non-session notifications) we surface it — fail open
 * toward visibility, since the chat view is session-scoped anyway.
 *
 * `windowRoots` is the list of workspace folder paths open in this window
 * (already normalized by the caller).
 */
export function isForThisWindow(workspaceRoot: string | undefined, windowRoots: string[]): boolean {
  if (!workspaceRoot) return true;
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = norm(workspaceRoot);
  return windowRoots.some((r) => {
    const root = norm(r);
    return target === root || target.startsWith(root + '/');
  });
}
