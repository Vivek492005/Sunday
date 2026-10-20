/**
 * Session Replay — F6 session event log, replayed as a timeline (Sunday Ops).
 *
 * Left: the daemon's session list. Right: the selected session's append-only
 * event log with a scrubber — events render IN ORDER up to the cursor, so
 * scrubbing back genuinely un-renders later events (that is the replay).
 * Play advances one event per 900ms. Strictly read-only: no rewind/branch/
 * export controls here (those live in the Sessions tab) — this tab only
 * watches history happen.
 *
 * Honest states: no sessions / empty log / load errors all say so plainly,
 * with the real error text. Styling reuses the Ops classes from ops.css.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  opsService,
  type SessionSummary,
  type SessionLogEntryOut,
} from '../../services/opsService';

const PLAY_STEP_MS = 900;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Chip color by event category; the type label itself carries the detail. */
function badgeClass(type: string): string {
  switch (type) {
    case 'tool_result':
      return 'ok';
    case 'approval':
      return 'danger';
    case 'checkpoint':
      return 'warn';
    default:
      // message, tool_call, session_created, compaction, settings_snapshot,
      // branch, rewind, anything new — neutral.
      return '';
  }
}

function localTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts.slice(11, 19) : d.toLocaleTimeString([], { hour12: false });
}

function updatedLabel(s: SessionSummary): string {
  if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt)) return '';
  return `updated ${new Date(s.updatedAt).toLocaleString()}`;
}

export function SessionReplay() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<SessionLogEntryOut[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  /* Session list — loaded once on mount. */
  useEffect(() => {
    let live = true;
    opsService
      .sessions()
      .then((s) => {
        if (live) setSessions(s);
      })
      .catch((e) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, []);

  /* Event log — (re)loaded whenever the selection changes. A fresh load
     starts with the full log visible; Play rewinds and replays it. */
  useEffect(() => {
    if (!selected) {
      setEntries(null);
      return;
    }
    let live = true;
    setEntries(null);
    setLogError(null);
    setPlaying(false);
    opsService
      .sessionLog(selected)
      .then((es) => {
        if (live) {
          setEntries(es);
          setCursor(es.length);
        }
      })
      .catch((e) => {
        if (live) setLogError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [selected]);

  /* Playback: a timeout chain (not an interval) so each step re-checks the
     end of the log; the cleanup clears the pending step on pause, on
     selection change, and on unmount. */
  useEffect(() => {
    if (!playing || !entries) return;
    if (cursor >= entries.length) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => {
      setCursor((c) => Math.min(c + 1, entries.length));
    }, PLAY_STEP_MS);
    return () => window.clearTimeout(t);
  }, [playing, cursor, entries]);

  /* Keep the newest visible event in view while playing / scrubbing. */
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cursor]);

  const togglePlay = useCallback(() => {
    if (!entries || entries.length === 0) return;
    if (!playing && cursor >= entries.length) setCursor(0); // replay from the top
    setPlaying((p) => !p);
  }, [entries, playing, cursor]);

  const step = useCallback(
    (delta: number) => {
      if (!entries) return;
      setPlaying(false);
      setCursor((c) => Math.min(entries.length, Math.max(0, c + delta)));
    },
    [entries],
  );

  if (error && !sessions) return <div className="ops-error">{error}</div>;
  if (!sessions) return <div className="ops-loading">Loading sessions…</div>;

  return (
    <div className="ops-panel">
      {sessions.length === 0 ? (
        <div className="ops-empty">
          No sessions yet — agent sessions are recorded by the Sunday daemon and will appear here.
        </div>
      ) : (
        <div className="ops-split">
          <div className="ops-list">
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`ops-list-item${selected === s.id ? ' active' : ''}`}
                onClick={() => setSelected(s.id)}
              >
                <div className="ops-list-title">{s.title ?? `${s.id.slice(0, 12)}…`}</div>
                <div className="ops-list-sub dim">
                  {[s.model, updatedLabel(s)].filter(Boolean).join(' · ')}
                </div>
              </button>
            ))}
          </div>
          <div className="ops-detail">
            {!selected ? (
              <div className="ops-empty">Select a session to replay its event timeline.</div>
            ) : logError ? (
              <div className="ops-error">{logError}</div>
            ) : !entries ? (
              <div className="ops-loading">Loading event log…</div>
            ) : entries.length === 0 ? (
              <div className="ops-empty">This session has no recorded events.</div>
            ) : (
              <>
                <div className="ops-note">
                  Event {cursor} of {entries.length} · session{' '}
                  <span className="mono">{selected}</span>
                </div>
                <div className="ops-actions" style={{ alignItems: 'center' }}>
                  <button
                    className="sunday-btn ghost ops-btn"
                    onClick={() => step(-1)}
                    disabled={cursor <= 0}
                    title="Step back one event"
                  >
                    Back
                  </button>
                  <button className="sunday-btn ops-btn" onClick={togglePlay}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <button
                    className="sunday-btn ghost ops-btn"
                    onClick={() => step(1)}
                    disabled={cursor >= entries.length}
                    title="Step forward one event"
                  >
                    Forward
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={entries.length}
                    step={1}
                    value={cursor}
                    aria-label="Replay position"
                    style={{ flex: 1, minWidth: 0 }}
                    onChange={(e) => {
                      setPlaying(false);
                      setCursor(Number(e.target.value));
                    }}
                  />
                </div>
                <div className="ops-timeline" ref={timelineRef}>
                  {entries.slice(0, cursor).map((e) => (
                    <div key={e.id} className="ops-timeline-row">
                      <span className="mono dim">#{e.seq}</span>
                      <span className="mono dim">{localTime(e.ts)}</span>
                      <span className={`ops-chip ${badgeClass(e.type)}`}>{e.type}</span>
                      <span
                        className="mono"
                        style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                      >
                        {e.summary}
                      </span>
                    </div>
                  ))}
                  {cursor === 0 && (
                    <div className="ops-empty">
                      At the start of the recording — press Play or step Forward.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="ops-note">
        Replay is read-only: the daemon's session log is append-only and checksummed, and this view
        never writes to it. Rewind and branch live in the Sessions tab.
      </div>
    </div>
  );
}
