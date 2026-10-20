/**
 * Sunday Account chip — TitleBar right side (before the window controls).
 *
 * Signed out: a "Sign in" button running the real Google OAuth loopback →
 * hosted-gateway flow (electron/accountManager.ts via accountService).
 * Signed in: avatar (initial-letter fallback), display name / email, plan
 * badge, and a click menu with today's quota + Sign out.
 *
 * Refreshes on mount and whenever `sunday:account:changed` fires anywhere
 * in the app; it dispatches that same event after its own sign-in/out so
 * other surfaces can react too.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  accountService,
  type AccountStatusOut,
  type QuotaOut,
} from '../../services/accountService';
import './account.css';

export function AccountChip() {
  const [status, setStatus] = useState<AccountStatusOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [quota, setQuota] = useState<QuotaOut | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await accountService.status();
      setStatus(s);
      if (!s.signedIn) {
        setQuota(null);
        setMenuOpen(false);
      }
    } catch {
      // Bridge unavailable (plain browser dev) — show signed-out silently.
      setStatus({ signedIn: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener('sunday:account:changed', onChanged);
    return () => window.removeEventListener('sunday:account:changed', onChanged);
  }, [refresh]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !status?.signedIn) return;
    let live = true;
    setQuotaLoading(true);
    accountService
      .quota()
      .then((q) => {
        if (!live) return;
        setQuota('error' in q ? null : q);
      })
      .catch(() => {
        if (live) setQuota(null);
      })
      .finally(() => {
        if (live) setQuotaLoading(false);
      });
    return () => {
      live = false;
    };
  }, [menuOpen, status?.signedIn]);

  const onSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await accountService.signIn();
      if (s.signedIn) {
        setStatus(s);
        window.dispatchEvent(new CustomEvent('sunday:account:changed'));
      } else {
        setError(s.error ?? 'Sign-in failed. Please try again.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setBusy(true);
    try {
      await accountService.signOut();
    } catch {
      // Main-process sign-out never throws; a bridge failure still means
      // we should drop the local signed-in view and re-read status.
    } finally {
      setBusy(false);
      setMenuOpen(false);
      setQuota(null);
      await refresh();
      window.dispatchEvent(new CustomEvent('sunday:account:changed'));
    }
  };

  if (!status?.signedIn) {
    return (
      <div className="sunday-account" ref={rootRef}>
        <button
          className="sunday-account-signin"
          disabled={busy}
          onClick={() => void onSignIn()}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && (
          <span className="sunday-account-error" title={error}>
            {error}
          </span>
        )}
      </div>
    );
  }

  const user = status.user;
  const label = user?.displayName || user?.email || 'Sunday account';
  const initial = (label.trim().charAt(0) || 'S').toUpperCase();

  return (
    <div className="sunday-account" ref={rootRef}>
      <button className="sunday-account-chip" onClick={() => setMenuOpen(!menuOpen)}>
        {user?.avatarUrl ? (
          <img
            className="sunday-account-avatar"
            src={user.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span className="sunday-account-avatar-fallback">{initial}</span>
        )}
        <span className="sunday-account-name">{label}</span>
        {status.plan && <span className="sunday-account-plan">{status.plan}</span>}
        {status.stale && <span className="sunday-account-stale">offline</span>}
      </button>
      {menuOpen && (
        <div className="sunday-account-menu">
          {user?.email && user.email !== label && <div className="acct-email">{user.email}</div>}
          <div className="acct-quota">
            {quotaLoading ? (
              <span className="dim">Loading quota…</span>
            ) : quota ? (
              <>
                {quota.requestsUsed} / {quota.totalQuota} requests today
                <span className="dim">
                  {' '}
                  · {quota.quotaRemaining} left
                </span>
              </>
            ) : (
              <span className="dim">— / — requests today</span>
            )}
          </div>
          <button className="signout" disabled={busy} onClick={() => void onSignOut()}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
