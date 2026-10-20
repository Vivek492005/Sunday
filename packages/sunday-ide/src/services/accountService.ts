/**
 * Sunday Account service — typed access to the `window.sunday.account` bridge.
 *
 * The main-process side is REAL (electron/accountManager.ts): Google OAuth
 * loopback → hosted-gateway session, persisted at ~/.sunday-ide/session.json.
 * No stubs — every call below hits that backend via IPC.
 *
 * SHARED TYPES: the interfaces in this file are the canonical renderer-side
 * shapes. The coordinator mirrors them in electron/preload.ts
 * (`SundayAPI.account`) and electron/main.ts (IPC handlers
 * `sunday:account:status|sign-in|sign-out|quota`).
 */
import type { SundayAPI } from '../../electron/preload';

export interface AccountUserOut {
  id: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AccountStatusOut {
  signedIn: boolean;
  user?: AccountUserOut;
  /** Plan id from GET /me/entitlements (`basic` | `smart` | `pro`) when known. */
  plan?: string;
  /**
   * `true` when the stored session could not be refreshed because the
   * gateway was unreachable — the UI is showing the last known account.
   */
  stale?: boolean;
  /** Human-readable, token-free error message (sign-in failures). */
  error?: string;
}

export interface QuotaOut {
  requestsUsed: number;
  tokensIn: number;
  tokensOut: number;
  baseQuota: number;
  totalQuota: number;
  quotaRemaining: number;
}

export type QuotaResult = QuotaOut | { error: string };

/** The account slice of the preload bridge (mirrored in preload.ts). */
export interface AccountBridge {
  status(): Promise<AccountStatusOut>;
  signIn(): Promise<AccountStatusOut>;
  signOut(): Promise<void>;
  quota(): Promise<QuotaResult>;
}

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

function bridge(): AccountBridge {
  const api = window.sunday as (SundayAPI & { account?: AccountBridge }) | undefined;
  if (!api?.account) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api.account;
}

export const accountService = {
  status: (): Promise<AccountStatusOut> => bridge().status(),
  signIn: (): Promise<AccountStatusOut> => bridge().signIn(),
  signOut: (): Promise<void> => bridge().signOut(),
  quota: (): Promise<QuotaResult> => bridge().quota(),
};
