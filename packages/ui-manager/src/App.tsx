import { useEffect, useReducer, useState } from 'react';
import {
  addWorktree,
  applyManagerError,
  applyManagerState,
  applyOrchestrationState,
  activeOrchestrationRun,
  clearError,
  createCheckpoint,
  createInitialState,
  mergeWorktree,
  openConflictDiff,
  removeWorktree,
  requestRefresh,
  resolveConflict,
  restoreCheckpoint,
  setRefreshing,
  shortSha,
  stopAllOrchestration,
  stopTurn,
  type InboundMessage,
  type ManagerState,
  type MergeConflictView,
  type OrchestrationRunView,
  type UnitRunView,
} from './managerClient.js';
import { postToExtension } from './vscode.js';

type Action =
  | { kind: 'state'; snap: Extract<InboundMessage, { type: 'sunday/manager/state' }> }
  | { kind: 'orchestration'; runs: OrchestrationRunView[] }
  | { kind: 'error'; message: string }
  | { kind: 'refreshing' }
  | { kind: 'clear-error' };

function reducer(state: ManagerState, action: Action): ManagerState {
  switch (action.kind) {
    case 'state':
      return applyManagerState(state, action.snap);
    case 'orchestration':
      return applyOrchestrationState(state, action.runs);
    case 'error':
      return applyManagerError(state, action.message);
    case 'refreshing':
      return setRefreshing(state, true);
    case 'clear-error':
      return clearError(state);
  }
}

const host = { postMessage: postToExtension };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, createInitialState());
  const [ckptLabel, setCkptLabel] = useState('');
  const [wtBranch, setWtBranch] = useState('');
  const [wtPath, setWtPath] = useState('');

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const m = e.data as InboundMessage | undefined;
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'sunday/manager/state') dispatch({ kind: 'state', snap: m });
      else if (m.type === 'sunday/manager/orchestration') dispatch({ kind: 'orchestration', runs: m.runs });
      else if (m.type === 'sunday/manager/error') dispatch({ kind: 'error', message: m.message });
    };
    window.addEventListener('message', onMessage);
    requestRefresh(host);
    const timer = window.setInterval(() => requestRefresh(host), 5000);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
  }, []);

  const refresh = (): void => {
    dispatch({ kind: 'refreshing' });
    requestRefresh(host);
  };

  const activeRun = activeOrchestrationRun(state);

  return (
    <div className="mgr-root">
      <header className="mgr-header">
        <span className="mgr-title">Sunday Manager</span>
        <div className="mgr-row">
          <button
            className="mgr-btn mgr-btn-danger"
            onClick={() => stopAllOrchestration(host)}
            disabled={!activeRun}
            title={
              activeRun
                ? `Stop all units of orchestration run ${activeRun.runId}`
                : 'No active orchestration run'
            }
          >
            Stop all
          </button>
          <button className="mgr-btn" onClick={refresh} disabled={state.refreshing}>
            {state.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>
      {(state.workspaceRoot || state.repoRoot) && (
        <div className="mgr-roots">
          {state.workspaceRoot && <div className="mgr-root-line">workspace: {state.workspaceRoot}</div>}
          {state.repoRoot && <div className="mgr-root-line">repo: {state.repoRoot}</div>}
        </div>
      )}
      {state.error && (
        <div className="mgr-error" role="alert">
          {state.error}
          <button className="mgr-btn mgr-btn-sm" onClick={() => dispatch({ kind: 'clear-error' })}>
            Dismiss
          </button>
        </div>
      )}

      <section className="mgr-section">
        <h2>Orchestration ({state.orchestration.length})</h2>
        {state.orchestration.length === 0 && (
          <div className="mgr-empty">
            No orchestration runs yet. Run "Sunday: Run Orchestration…" from the command palette.
          </div>
        )}
        {state.orchestration.map((run) => (
          <OrchestrationRunCard key={run.runId} run={run} />
        ))}
      </section>

      <section className="mgr-section">
        <h2>Agents ({state.agents.length})</h2>
        {state.agents.length === 0 && <div className="mgr-empty">No sessions yet.</div>}
        {state.agents.map((a) => (
          <div key={a.id} className="mgr-card">
            <div className="mgr-card-head">
              <span className="mgr-card-title">{a.title || a.id}</span>
              {a.activeTurn ? (
                <span className="mgr-badge mgr-badge-running">running</span>
              ) : (
                <span className="mgr-badge">idle</span>
              )}
            </div>
            <div className="mgr-meta">
              {a.cwd && <span>{a.cwd}</span>}
              {a.model && <span> · {a.model}</span>}
              <span> · updated {fmtTime(a.updatedAt)}</span>
            </div>
            {a.activeTurn && (
              <button className="mgr-btn mgr-btn-danger mgr-btn-sm" onClick={() => stopTurn(host, a.activeTurn!)}>
                Stop turn
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="mgr-section">
        <h2>Checkpoints ({state.checkpoints.length})</h2>
        <div className="mgr-row">
          <input
            className="mgr-input"
            placeholder="Label (optional)"
            aria-label="Checkpoint label"
            value={ckptLabel}
            onChange={(e) => setCkptLabel(e.target.value)}
          />
          <button
            className="mgr-btn"
            onClick={() => {
              createCheckpoint(host, ckptLabel);
              setCkptLabel('');
              dispatch({ kind: 'refreshing' });
            }}
          >
            Create checkpoint
          </button>
        </div>
        {state.checkpoints.length === 0 && <div className="mgr-empty">No checkpoints yet.</div>}
        {state.checkpoints.map((c) => (
          <div key={c.id} className="mgr-card">
            <div className="mgr-card-head">
              <span className="mgr-card-title">{c.label || '(unlabeled)'}</span>
              <span className="mgr-sha" title={c.sha}>
                {shortSha(c.sha)}
              </span>
            </div>
            <div className="mgr-meta">{fmtTime(c.createdAt)}</div>
            <button
              className="mgr-btn mgr-btn-sm"
              onClick={() => {
                restoreCheckpoint(host, c.id);
                dispatch({ kind: 'refreshing' });
              }}
            >
              Restore
            </button>
          </div>
        ))}
      </section>

      <section className="mgr-section">
        <h2>Worktrees ({state.worktrees.length})</h2>
        <div className="mgr-row">
          <input
            className="mgr-input"
            placeholder="Branch name"
            aria-label="Worktree branch name"
            value={wtBranch}
            onChange={(e) => setWtBranch(e.target.value)}
          />
          <input
            className="mgr-input"
            placeholder="Path (optional)"
            aria-label="Worktree path"
            value={wtPath}
            onChange={(e) => setWtPath(e.target.value)}
          />
          <button
            className="mgr-btn"
            onClick={() => {
              addWorktree(host, wtBranch, wtPath);
              setWtBranch('');
              setWtPath('');
              dispatch({ kind: 'refreshing' });
            }}
          >
            Add worktree
          </button>
        </div>
        {state.worktrees.length === 0 && <div className="mgr-empty">No worktrees.</div>}
        {state.worktrees.map((w) => (
          <div key={w.path} className="mgr-card">
            <div className="mgr-card-head">
              <span className="mgr-card-title">{w.branch || '(detached)'}</span>
              <span className="mgr-sha" title={w.head}>
                {shortSha(w.head)}
              </span>
            </div>
            <div className="mgr-meta">{w.path}</div>
            <div className="mgr-row">
              <button
                className="mgr-btn mgr-btn-sm"
                disabled={!w.branch}
                title={w.branch ? 'Merge branch into current branch' : 'Detached worktree cannot be merged'}
                onClick={() => {
                  mergeWorktree(host, w.path);
                  dispatch({ kind: 'refreshing' });
                }}
              >
                Merge
              </button>
              <button
                className="mgr-btn mgr-btn-danger mgr-btn-sm"
                onClick={() => {
                  removeWorktree(host, w.path);
                  dispatch({ kind: 'refreshing' });
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

// -- orchestration run cards (parallel agents) ----------------------------------

/** Keyboard activation for UnitCard (role="button"): Enter/Space toggles the
 *  card. Exported so the a11y suite can assert key behavior without a DOM. */
export function unitCardKeyDown(
  e: { key: string; preventDefault(): void },
  onToggle: () => void,
): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onToggle();
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running':
    case 'verifying':
      return 'mgr-badge mgr-badge-running';
    case 'done':
    case 'merged':
      return 'mgr-badge mgr-badge-done';
    case 'failed':
    case 'conflicted':
      return 'mgr-badge mgr-badge-failed';
    case 'cancelled':
      return 'mgr-badge mgr-badge-cancelled';
    default:
      return 'mgr-badge';
  }
}

function fmtRange(range: [number, number]): string {
  return `L${range[0]}–${range[1]}`;
}

function UnitCard({
  runId,
  unit,
  expanded,
  onToggle,
}: {
  runId: string;
  unit: UnitRunView;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const toggleExpanded = (): void => onToggle();
  const onCardKeyDown = (e: { key: string; preventDefault(): void }): void =>
    unitCardKeyDown(e, onToggle);
  return (
    <div
      className="mgr-unit-card"
      onClick={toggleExpanded}
      onKeyDown={onCardKeyDown}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${unit.title || unit.id} — ${unit.status}`}
    >
      <div className="mgr-card-head">
        <span className="mgr-card-title">{unit.title || unit.id}</span>
        <span className={statusBadgeClass(unit.status)}>{unit.status}</span>
      </div>
      <div className="mgr-meta">
        {unit.worktreePath && <span>{unit.worktreePath}</span>}
        {unit.model && <span> · {unit.model}</span>}
        {unit.steps !== undefined && (
          <span>
            {' '}
            · {unit.steps} step{unit.steps === 1 ? '' : 's'}
          </span>
        )}
        {unit.sha && (
          <span className="mgr-sha" title={unit.sha}>
            {' '}
            · {shortSha(unit.sha)}
          </span>
        )}
      </div>
      {unit.error && <div className="mgr-unit-error">{unit.error}</div>}
      {expanded && (
        <pre className="mgr-unit-log" onClick={(e) => e.stopPropagation()}>
          {unit.log.length > 0 ? unit.log.join('\n') : '(no log lines yet)'}
        </pre>
      )}
    </div>
  );
}

function ConflictCard({
  runId,
  conflict,
}: {
  runId: string;
  conflict: MergeConflictView;
}): JSX.Element {
  const first = conflict.hunks[0];
  const unitA = first?.unitA ?? '';
  const unitB = first?.unitB ?? '';
  return (
    <div className="mgr-conflict">
      <div className="mgr-card-head">
        <span className="mgr-card-title mgr-mono">{conflict.file}</span>
        <span className="mgr-badge mgr-badge-failed">conflict #{conflict.index}</span>
      </div>
      {conflict.hunks.map((h, i) => (
        <div key={i} className="mgr-meta mgr-mono">
          {h.file}: {fmtRange(h.rangeA)} ({h.unitA}) vs {fmtRange(h.rangeB)} ({h.unitB})
        </div>
      ))}
      <div className="mgr-row">
        <button
          className="mgr-btn mgr-btn-sm"
          disabled={!unitA}
          onClick={() => resolveConflict(host, runId, conflict.index, unitA)}
        >
          Keep {unitA || '…'}
        </button>
        <button
          className="mgr-btn mgr-btn-sm"
          disabled={!unitB}
          onClick={() => resolveConflict(host, runId, conflict.index, unitB)}
        >
          Keep {unitB || '…'}
        </button>
        <button
          className="mgr-btn mgr-btn-sm"
          onClick={() => openConflictDiff(host, runId, conflict.index)}
        >
          Open diff
        </button>
      </div>
    </div>
  );
}

function OrchestrationRunCard({ run }: { run: OrchestrationRunView }): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (unitId: string): void =>
    setExpanded((prev) => ({ ...prev, [unitId]: !prev[unitId] }));
  return (
    <div className="mgr-card">
      <div className="mgr-card-head">
        <span className="mgr-card-title">{run.goal || run.runId}</span>
        <span className={statusBadgeClass(run.status)}>{run.status}</span>
      </div>
      <div className="mgr-meta">
        <span className="mgr-mono">{run.runId}</span>
        {run.parallel && <span> · parallel</span>}
        {!run.parallel && <span> · sequential</span>}
        <span> · updated {fmtTime(run.updatedAt)}</span>
      </div>
      <div className="mgr-units">
        {run.units.map((u) => (
          <UnitCard
            key={u.id}
            runId={run.runId}
            unit={u}
            expanded={!!expanded[u.id]}
            onToggle={() => toggle(u.id)}
          />
        ))}
      </div>
      {run.status === 'conflicted' && (
        <div className="mgr-conflicts">
          <div className="mgr-conflicts-title">
            Merge conflicts ({run.conflicts.length}) — pick a side per conflict:
          </div>
          {run.conflicts.map((c) => (
            <ConflictCard key={c.index} runId={run.runId} conflict={c} />
          ))}
        </div>
      )}
    </div>
  );
}
