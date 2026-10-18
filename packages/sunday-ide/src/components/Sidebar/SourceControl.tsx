/**
 * Sunday Source Control — git status/stage/commit/diff, all Sunday's own UI.
 * Raw git CLI in the main process; porcelain parsing in gitParse.ts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { gitService, type GitFileChange, type GitStatusResult } from '../../services/gitService';
import { statusLabel } from '../../services/gitParse';
import { RefreshIcon, PlusIcon } from '../icons';
import { DiffModal } from './DiffModal';
import './sourcecontrol.css';

function fileName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}

export function SourceControl() {
  const { state, dispatch } = useIde();
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [diffTarget, setDiffTarget] = useState<{ path: string; staged: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!state.rootFolder) {
      setStatus(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const s = await gitService.status(state.rootFolder);
      setStatus(s);
      dispatch({ type: 'SET_BRANCH', branch: s.branch });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Git status failed');
    } finally {
      setLoading(false);
    }
  }, [state.rootFolder, dispatch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn();
    if (!r.ok) setError(r.error ?? 'Git operation failed');
    await refresh();
  };

  const stage = (f: GitFileChange) =>
    state.rootFolder && mutate(() => gitService.stage(state.rootFolder as string, [f.path]));
  const unstage = (f: GitFileChange) =>
    state.rootFolder && mutate(() => gitService.unstage(state.rootFolder as string, [f.path]));
  const stageAll = () =>
    state.rootFolder &&
    mutate(() => gitService.stage(state.rootFolder as string, (status?.unstaged ?? []).map((f) => f.path)));

  const commit = async () => {
    if (!state.rootFolder || !message.trim() || committing) return;
    setCommitting(true);
    setError(null);
    try {
      const r = await gitService.commit(state.rootFolder, message.trim());
      if (!r.ok) setError(r.error ?? 'Commit failed');
      else setMessage('');
    } finally {
      setCommitting(false);
      await refresh();
    }
  };

  if (!state.rootFolder) {
    return (
      <div className="sunday-sc-root">
        <div className="sunday-sidebar-header"><span className="title">SOURCE CONTROL</span></div>
        <div className="sunday-empty-state">
          <div style={{ fontSize: 14, color: 'var(--sunday-fg-dim)' }}>Open a folder to use git</div>
        </div>
      </div>
    );
  }

  const total = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);

  return (
    <div className="sunday-sc-root">
      <div className="sunday-sidebar-header">
        <span className="title">SOURCE CONTROL{status?.branch ? ` — ${status.branch}` : ''}</span>
        <div className="sunday-icon-actions">
          <button className="sunday-icon-btn" title="Refresh" onClick={() => void refresh()}>
            <RefreshIcon size={15} />
          </button>
        </div>
      </div>

      <div className="sunday-sc-body">
        {loading && !status && <div className="sunday-sc-hint">Reading git status…</div>}
        {error && <div className="sunday-sc-error">{error}</div>}

        {status && !status.isRepo && (
          <div className="sunday-sc-hint">This folder is not a git repository.</div>
        )}

        {status?.isRepo && total === 0 && (
          <div className="sunday-sc-hint">Working tree clean — nothing to commit.</div>
        )}

        {status && status.staged.length > 0 && (
          <div className="sunday-sc-group">
            <div className="sunday-sc-group-title">STAGED · {status.staged.length}</div>
            {status.staged.map((f) => (
              <ScRow
                key={`s:${f.path}`}
                file={f}
                actionLabel="Unstage"
                onAction={() => void unstage(f)}
                onDiff={() => setDiffTarget({ path: f.path, staged: true })}
                onOpen={() => dispatch({ type: 'OPEN_FILE', path: `${state.rootFolder}/${f.path}` })}
              />
            ))}
          </div>
        )}

        {status && status.unstaged.length > 0 && (
          <div className="sunday-sc-group">
            <div className="sunday-sc-group-title">
              CHANGES · {status.unstaged.length}
              <button className="sunday-sc-link" onClick={() => void stageAll()}>Stage all</button>
            </div>
            {status.unstaged.map((f) => (
              <ScRow
                key={`u:${f.path}`}
                file={f}
                actionLabel="Stage"
                onAction={() => void stage(f)}
                onDiff={() => setDiffTarget({ path: f.path, staged: false })}
                onOpen={() => dispatch({ type: 'OPEN_FILE', path: `${state.rootFolder}/${f.path}` })}
              />
            ))}
          </div>
        )}

        {status?.isRepo && (
          <div className="sunday-sc-commit">
            <textarea
              className="sunday-sc-message"
              placeholder="Commit message…"
              value={message}
              rows={3}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void commit();
              }}
            />
            <button
              className="sunday-btn sunday-sc-commit-btn"
              disabled={!message.trim() || status.staged.length === 0 || committing}
              onClick={() => void commit()}
              title={status.staged.length === 0 ? 'Stage changes first' : 'Commit (Ctrl+Enter)'}
            >
              {committing ? 'Committing…' : `Commit${status.staged.length ? ` (${status.staged.length})` : ''}`}
            </button>
          </div>
        )}
      </div>

      {diffTarget && state.rootFolder && (
        <DiffModal
          rootFolder={state.rootFolder}
          filePath={diffTarget.path}
          staged={diffTarget.staged}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </div>
  );
}

function ScRow({
  file,
  actionLabel,
  onAction,
  onDiff,
  onOpen,
}: {
  file: GitFileChange;
  actionLabel: string;
  onAction: () => void;
  onDiff: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="sunday-sc-row" title={file.path}>
      <button className="sunday-sc-name" onClick={onOpen}>
        <span className="fname">{fileName(file.path)}</span>
        <span className="fdir">{file.path}</span>
      </button>
      <span className={`sunday-sc-badge s-${file.status}`} title={statusLabel(file.status)}>{file.status}</span>
      <button className="sunday-sc-mini" onClick={onDiff} title="View diff">
        Diff
      </button>
      <button className="sunday-sc-mini" onClick={onAction} title={actionLabel}>
        {actionLabel === 'Stage' ? <PlusIcon size={13} /> : '−'}
      </button>
    </div>
  );
}
