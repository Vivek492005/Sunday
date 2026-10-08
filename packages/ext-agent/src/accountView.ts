// sunday-agent — Sunday Account status bar UI shell (Phase 9.a, minimal).
//
// Owns the "Sunday Account" status bar item and its menu:
//   - Signed OUT → `$(sign-in) Sign in to Sunday` → Google OAuth through the
//     `sunday-google-auth` authentication provider (id `google`).
//   - Signed IN  → `$(account) <email> · <plan>` → quick-pick menu showing the
//     email, the plan badge (from the auth extension's exported Sunday session
//     info when available, otherwise "Basic"), plus "Sign out" / "Close".
//
// Deliberately no upgrade buttons, no billing links — those arrive in a later
// phase. Sign-out goes through the auth extension's `sunday.google.signOut`
// command because `vscode.authentication` has no public session-removal API.
//
// Test boundary: everything that formats or derives UI state from session
// data lives in the pure functions below (unit-tested in accountView.test.ts).
// Only `registerAccountStatusBar` touches the real `vscode` API.
import * as vscode from 'vscode';

/** Authentication provider id registered by the sunday-google-auth extension. */
export const GOOGLE_PROVIDER_ID = 'google';
/** Minimal identity scopes (openid/email/profile only — no Drive, Gmail, Calendar). */
export const GOOGLE_SCOPES: readonly string[] = ['openid', 'email', 'profile'];
/** Command contributed by sunday-google-auth that removes its session(s). */
export const GOOGLE_SIGN_OUT_COMMAND = 'sunday.google.signOut';
/** Extension id of the bundled Google auth provider (may be absent in dev hosts). */
export const GOOGLE_AUTH_EXTENSION_ID = 'sunday.sunday-google-auth';
/** Command id shown on the status bar item / command palette for the account menu. */
export const ACCOUNT_MENU_COMMAND = 'sunday.account.showMenu';
/** Status bar priority — matches the sidecar health item (~100), right side. */
export const ACCOUNT_STATUS_BAR_PRIORITY = 100;
/** Plan shown when no Sunday session info (entitlements) is available yet. */
export const DEFAULT_PLAN = 'Basic';

/**
 * Sunday-side session info, exposed by the sunday-google-auth extension via
 * its exported `getSundaySession()` API. Not exposed today — every read is
 * defensive and falls back to the standard auth API (plan defaults to Basic).
 */
export interface SundaySessionInfo {
  email?: string;
  plan?: string;
  entitlements?: Record<string, unknown>;
}

/** UI state derived from the VS Code auth session (+ optional Sunday session). */
export interface AccountState {
  signedIn: boolean;
  email?: string;
  plan: string;
}

/**
 * Normalize a raw plan string ("basic" | "Basic" | "SMART" | undefined, …)
 * to the badge text. Unknown values are title-cased; empty → "Basic".
 */
export function normalizePlan(raw: string | undefined): string {
  const p = (raw ?? '').trim().toLowerCase();
  if (!p) return DEFAULT_PLAN;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** Derive account UI state from the auth session and the optional Sunday session. */
export function deriveAccountState(
  session: vscode.AuthenticationSession | undefined,
  sundaySession?: SundaySessionInfo | undefined,
): AccountState {
  const email = session?.account?.label || sundaySession?.email;
  return {
    signedIn: Boolean(session),
    ...(email ? { email } : {}),
    plan: normalizePlan(sundaySession?.plan),
  };
}

/** Status bar text for the account state. */
export function accountStatusBarLabel(state: AccountState): string {
  if (!state.signedIn) return '$(sign-in) Sign in to Sunday';
  return `$(account) ${state.email ?? 'Sunday account'} · ${state.plan}`;
}

/** Status bar hover tooltip for the account state. */
export function accountStatusBarTooltip(state: AccountState): string {
  if (!state.signedIn) return 'Sign in to your Sunday account (Google)';
  return `Sunday account — ${state.email ?? 'signed in'} · Plan: ${state.plan}`;
}

/** Discriminant for identifying account quick-pick items (pure + testable). */
export type AccountPickAction = 'sign-in' | 'email-info' | 'sign-out' | 'close';

/** A quick-pick row in the account menu, tagged by kind. */
export interface AccountPickItem extends vscode.QuickPickItem {
  action: AccountPickAction;
}

/** Signed-out menu: a single "Sign in with Google" row. */
export function buildSignedOutPickItems(): AccountPickItem[] {
  return [
    {
      action: 'sign-in',
      label: '$(sign-in) Sign in with Google',
      description: 'Sign in to your Sunday account',
    },
  ];
}

/**
 * Signed-in menu: email row with the plan badge, then "Sign out" and "Close".
 */
export function buildSignedInPickItems(state: AccountState): AccountPickItem[] {
  return [
    {
      action: 'email-info',
      label: `$(account) ${state.email ?? 'Sunday account'}`,
      description: `Plan: ${state.plan}`,
    },
    {
      action: 'sign-out',
      label: '$(sign-out) Sign out',
      description: "Sign out of your Sunday account on this device",
    },
    {
      action: 'close',
      label: '$(close) Close',
    },
  ];
}

/** Action the signed-out menu pick resolves to. */
export function signedOutPickAction(pick: AccountPickItem | undefined): 'signIn' | 'none' {
  return pick?.action === 'sign-in' ? 'signIn' : 'none';
}

/** Action the signed-in menu pick resolves to. */
export function signedInPickAction(pick: AccountPickItem | undefined): 'signOut' | 'close' | 'none' {
  switch (pick?.action) {
    case 'sign-out':
      return 'signOut';
    case 'close':
    case 'email-info':
      return 'close';
    default:
      return 'none';
  }
}

// -- vscode wiring (not unit-tested; keep it a thin shell) ----------------------

export interface AccountViewDeps {
  log?: (msg: string) => void;
}

async function getGoogleSession(
  createIfNone: boolean,
): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(GOOGLE_PROVIDER_ID, [...GOOGLE_SCOPES], {
      createIfNone,
    });
  } catch {
    // Provider not installed/available (e.g. plain upstream VS Code without
    // the bundled auth extension) — treat as signed out.
    return undefined;
  }
}

/**
 * Defensive read of the auth extension's exported Sunday session API.
 * Returns `undefined` (→ plan falls back to "Basic") when the extension is
 * absent, inactive, or the API is not exposed yet.
 */
async function getSundaySessionInfo(): Promise<SundaySessionInfo | undefined> {
  try {
    const ext = vscode.extensions.getExtension<{
      getSundaySession?: () => Promise<SundaySessionInfo | undefined>;
    }>(GOOGLE_AUTH_EXTENSION_ID);
    const fn = ext?.exports?.getSundaySession;
    if (typeof fn === 'function') {
      return (await fn()) ?? undefined;
    }
  } catch {
    // Not available — fall through to the Basic default.
  }
  return undefined;
}

/**
 * Register the Sunday Account status bar item + menu command.
 * Refreshes on activation and whenever the auth provider's sessions change.
 */
export function registerAccountStatusBar(
  context: vscode.ExtensionContext,
  deps: AccountViewDeps = {},
): vscode.Disposable {
  const log = deps.log ?? (() => undefined);
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    ACCOUNT_STATUS_BAR_PRIORITY,
  );
  item.command = ACCOUNT_MENU_COMMAND;

  let state: AccountState = { signedIn: false, plan: DEFAULT_PLAN };

  const render = (): void => {
    item.text = accountStatusBarLabel(state);
    item.tooltip = accountStatusBarTooltip(state);
    item.show();
  };

  const refresh = async (): Promise<void> => {
    try {
      const [session, sunday] = await Promise.all([
        getGoogleSession(false),
        getSundaySessionInfo(),
      ]);
      state = deriveAccountState(session, sunday);
    } catch (err) {
      // Never break activation on auth failures; stay in the signed-out UI.
      log(`account: refresh failed: ${(err as Error).message}`);
      state = { signedIn: false, plan: DEFAULT_PLAN };
    }
    render();
  };

  const signIn = async (): Promise<void> => {
    try {
      await getGoogleSession(true);
      // onDidChangeSessions normally refreshes the UI; refresh here too in
      // case the provider does not fire the event.
      await refresh();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Sunday sign-in failed: ${(err as Error).message}. ` +
          'Make sure the Google authentication provider is installed.',
      );
    }
  };

  const signOut = async (): Promise<void> => {
    try {
      // `vscode.authentication` has no public session-removal API, so sign-out
      // is delegated to the auth extension's own command when present.
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes(GOOGLE_SIGN_OUT_COMMAND)) {
        void vscode.window.showInformationMessage(
          'Sign-out is not available in this build. ' +
            'Use the Accounts menu (bottom-left) to sign out of Google.',
        );
        return;
      }
      await vscode.commands.executeCommand(GOOGLE_SIGN_OUT_COMMAND);
      await refresh();
    } catch (err) {
      void vscode.window.showErrorMessage(`Sunday sign-out failed: ${(err as Error).message}`);
    }
  };

  const showMenu = async (): Promise<void> => {
    if (!state.signedIn) {
      const pick = await vscode.window.showQuickPick<AccountPickItem>(
        buildSignedOutPickItems(),
        { title: 'Sunday Account', placeHolder: 'Sign in to your Sunday account' },
      );
      if (signedOutPickAction(pick) === 'signIn') await signIn();
      return;
    }
    const pick = await vscode.window.showQuickPick<AccountPickItem>(
      buildSignedInPickItems(state),
      { title: 'Sunday Account', placeHolder: state.email },
    );
    if (signedInPickAction(pick) === 'signOut') await signOut();
  };

  const menuSub = vscode.commands.registerCommand(ACCOUNT_MENU_COMMAND, () => {
    void showMenu();
  });
  const sessionSub = vscode.authentication.onDidChangeSessions((e) => {
    if (e.provider.id === GOOGLE_PROVIDER_ID) void refresh();
  });

  render();
  void refresh();

  return {
    dispose: () => {
      menuSub.dispose();
      sessionSub.dispose();
      item.dispose();
    },
  };
}
