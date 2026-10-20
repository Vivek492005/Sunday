/**
 * Activity / Trace panel — shows the REAL tool calls the daemon's agent
 * loop made during the most recent turn (name, args summary, duration,
 * status), collected by the main process from the daemon's chat/event
 * stream (see electron/agentBackend.ts getAgentTrace). No synthetic data:
 * a turn that made no tool calls shows an honest empty state.
 */
import React, { useEffect, useState } from 'react';
import { agentService, type AgentTraceOut } from '../../services/agentService';

function fmtDuration(ms?: number): string {
  if (ms == null) return '…';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

export function TracePanel() {
  const [trace, setTrace] = useState<AgentTraceOut | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const t = await agentService.trace();
        if (alive) setTrace(t);
      } catch {
        if (alive) setTrace(null); // bridge unavailable — honest empty state
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const turn = trace?.turns[0];
  const totalMs =
    turn?.finishedAt != null ? turn.finishedAt - turn.startedAt : undefined;

  return (
    <div className="sunday-trace">
      <button
        type="button"
        className="sunday-trace-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sunday-trace-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="sunday-trace-title">Activity</span>
        {turn ? (
          <span className="sunday-trace-meta">
            last turn · {turn.status}
            {totalMs != null ? ` · ${fmtDuration(totalMs)}` : ''}
            {turn.usage?.inputTokens != null || turn.usage?.outputTokens != null
              ? ` · ${turn.usage?.inputTokens ?? '?'} in / ${turn.usage?.outputTokens ?? '?'} out tokens`
              : ''}
          </span>
        ) : (
          <span className="sunday-trace-meta">no turns yet</span>
        )}
      </button>
      {open &&
        (!turn || turn.entries.length === 0 ? (
          <div className="sunday-trace-empty">
            {turn
              ? 'The last turn made no tool calls — it answered directly.'
              : 'Tool calls from agent turns will appear here with their real timings.'}
          </div>
        ) : (
          <div className="sunday-trace-list">
            {turn.entries.map((e) => (
              <div key={e.callId} className="sunday-trace-row">
                <span
                  className={`sunday-trace-status ${e.status}`}
                  title={e.status}
                  aria-label={e.status}
                >
                  {e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : '…'}
                </span>
                <span className="sunday-trace-name" title={e.name}>
                  {e.name}
                </span>
                <span className="sunday-trace-args" title={e.argsSummary}>
                  {e.argsSummary}
                </span>
                <span className="sunday-trace-time">
                  {fmtClock(e.startedAt)} · {fmtDuration(e.durationMs)}
                </span>
                {e.resultSummary && (
                  <span className="sunday-trace-result" title={e.resultSummary}>
                    {e.resultSummary}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
