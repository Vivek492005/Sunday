/**
 * StreakPill — the status-bar streak counter (Piece 1: engagement).
 *
 * Presentational: renders the flame + current streak count from a
 * StreakInfoOut, or nothing when info is null (bridge unavailable / not yet
 * loaded — the status bar simply omits the pill, never shows fake numbers).
 *
 * useStreakInfo() is the data hook: fetches on mount, refreshes on the
 * 'sunday:streak:changed' CustomEvent (dispatched by streakService.noteEdit
 * and anything else that records streak activity), and polls every 60s so
 * agent-turn / commit activity recorded in the main process shows up.
 * All timers/listeners are cleaned up on unmount.
 */
import React, { useEffect, useState } from 'react';
import { streakService, type StreakInfoOut } from '../../services/streakService';

function FlameGlyph({ active }: { active: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flex: 'none', opacity: active ? 1 : 0.45 }}
    >
      {/* Outer flame */}
      <path
        d="M12 1.8s6.2 6.9 6.2 11.4a6.2 6.2 0 0 1-12.4 0C5.8 8.7 12 1.8 12 1.8z"
        fill="#e88f2a"
      />
      {/* Inner flame */}
      <path
        d="M12 21.6a3.1 3.1 0 0 1-3.1-3.1c0-2.1 3.1-4.9 3.1-4.9s3.1 2.8 3.1 4.9a3.1 3.1 0 0 1-3.1 3.1z"
        fill="#f5b942"
      />
    </svg>
  );
}

export function StreakPill({ info }: { info: StreakInfoOut | null }) {
  if (!info) return null;
  const title =
    `Longest ${info.longest} · ${info.freezesAvailable} freeze(s) · ` +
    (info.todayIsActive ? 'active today' : 'no streak activity yet today');
  return (
    <span
      className="sb-item"
      title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <FlameGlyph active={info.todayIsActive} />
      {info.current}
    </span>
  );
}

export function useStreakInfo(): StreakInfoOut | null {
  const [info, setInfo] = useState<StreakInfoOut | null>(null);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const next = await streakService.get();
        if (live) setInfo(next);
      } catch {
        // Bridge unavailable or read failed: keep the last known info
        // (null on first load → the pill stays hidden, never fake data).
      }
    };
    void load();
    const onChanged = (): void => {
      void load();
    };
    window.addEventListener('sunday:streak:changed', onChanged);
    const timer = window.setInterval(() => {
      void load();
    }, 60_000);
    return () => {
      live = false;
      window.removeEventListener('sunday:streak:changed', onChanged);
      window.clearInterval(timer);
    };
  }, []);

  return info;
}
