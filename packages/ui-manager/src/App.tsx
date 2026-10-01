import { useEffect, useReducer, useState } from 'react';
import {
  addWorktree,
  applyManagerError,
  applyManagerState,
  clearError,
  createCheckpoint,
  createInitialState,
  mergeWorktree,
  removeWorktree,
  requestRefresh,
  restoreCheckpoint,
  setRefreshing,
  shortSha,
  stopTurn,
  type InboundMessage,
  type ManagerState,
} from './managerClient.js';
import { postToExtension } from './vscode.js';

type Action =
  | { kind: 'state'; snap: Extract<InboundMessage, { type: 'sunday/manager/state' }> }
  | { kind: 'error'; message: string }
  | { kind: 'refreshing' }
  | { kind: 'clear-error' };

function reducer(state: ManagerState, action: Action): ManagerState {
  switch (action.kind) {
    case 'state':
      return applyManagerState(state, action.snap);
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

  return (
    <div className="mgr-root">
      <header className="mgr-header">
        <span className="mgr-title">Sunday Manager</span>
        <button className="mgr-btn" onClick={refresh} disabled={state.refreshing}>
          {state.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      {(state.workspaceRoot || state.repoRoot) && (
        <div className="mgr-roots">
          {state.workspaceRoot && <div className="mgr-root-line">workspace: {state.workspaceRoot}</div>}
          {state.repoRoot && <div className="mgr-root-line">repo: {state.repoRoot}</div>}
        </div>
      )}
      {state.error && (
        <div className="mgr-error">
          {state.error}
          <button className="mgr-btn mgr-btn-sm" onClick={() => dispatch({ kind: 'clear-error' })}>
            Dismiss
          </button>
        </div>
      )}

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
            value={wtBranch}
            onChange={(e) => setWtBranch(e.target.value)}
          />
          <input
            className="mgr-input"
            placeholder="Path (optional)"
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
