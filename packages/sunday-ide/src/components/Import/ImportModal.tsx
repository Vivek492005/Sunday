/**
 * F13 — "Bring everything with you" importer UI.
 *
 * Flow: auto-detect foreign configs → dry-run plan (zero writes) → user
 * reviews → apply → import report (converted / skipped / needs attention).
 * 100% Sunday UI; no VS Code workbench anything.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useIde } from '../../state/ideStore';
import {
  importService,
  type ImportPlan,
  type ImportReport,
} from '../../services/importService';
import { CloseIcon } from '../icons';
import './import.css';

type Phase = 'detecting' | 'plan' | 'applying' | 'report' | 'error';

function shortPath(p: string): string {
  return p.length > 64 ? `…${p.slice(-63)}` : p;
}

export function ImportModal() {
  const { state, dispatch } = useIde();
  const [phase, setPhase] = useState<Phase>('detecting');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string>('');

  const close = useCallback(
    () => dispatch({ type: 'SET_IMPORT_OPEN', open: false }),
    [dispatch],
  );

  const runDetection = useCallback(async () => {
    const folder = state.rootFolder;
    if (!folder) {
      setError('Open a folder first — the importer scans the workspace and your home directory.');
      setPhase('error');
      return;
    }
    setPhase('detecting');
    setError('');
    setReport(null);
    try {
      const p = await importService.plan(folder);
      setPlan(p);
      setPhase('plan');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [state.rootFolder]);

  useEffect(() => {
    if (state.importOpen) void runDetection();
  }, [state.importOpen, runDetection]);

  useEffect(() => {
    if (!state.importOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.importOpen, close]);

  if (!state.importOpen) return null;

  const apply = async () => {
    if (!plan) return;
    setPhase('applying');
    try {
      const r = await importService.apply(plan);
      setReport(r);
      setPhase('report');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  return (
    <div className="sunday-import-overlay" onClick={close}>
      <div className="sunday-import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sunday-import-header">
          <div>
            <h2>Import from other tools</h2>
            <p>Bring everything with you — rules, settings, keybindings, MCP servers.</p>
          </div>
          <button className="sunday-import-close" onClick={close} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sunday-import-body">
          {phase === 'detecting' && <p className="sunday-import-status">Scanning workspace and home directory…</p>}
          {phase === 'applying' && <p className="sunday-import-status">Applying import…</p>}

          {phase === 'error' && (
            <div className="sunday-import-error">
              <p>{error}</p>
              <button onClick={() => void runDetection()}>Retry</button>
            </div>
          )}

          {phase === 'plan' && plan && (
            <>
              <section>
                <h3>Detected ({plan.detected.length})</h3>
                {plan.detected.length === 0 && (
                  <p className="sunday-import-empty">
                    Nothing found — no CLAUDE.md, .cursorrules, VS Code settings, or MCP configs detected.
                  </p>
                )}
                <ul className="sunday-import-list">
                  {plan.detected.map((d) => (
                    <li key={d.path}>
                      <span className="sunday-import-badge">{d.scope}</span>
                      <span className="sunday-import-label">{d.label}</span>
                      <span className="sunday-import-path">{shortPath(d.path)}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3>Dry run — what will happen ({plan.writes.length})</h3>
                <ul className="sunday-import-list">
                  {plan.writes.map((w) => (
                    <li key={w.path} className={w.action === 'skip' ? 'is-skip' : ''}>
                      <span className={`sunday-import-action action-${w.action}`}>{w.action}</span>
                      <span className="sunday-import-label">{w.summary}</span>
                      <span className="sunday-import-path">{shortPath(w.path)}</span>
                    </li>
                  ))}
                </ul>
              </section>

              {plan.unconvertible.length > 0 && (
                <section>
                  <h3>Won't convert automatically ({plan.unconvertible.length})</h3>
                  <ul className="sunday-import-list">
                    {plan.unconvertible.map((u, i) => (
                      <li key={i}>
                        <span className="sunday-import-label">{u.item}</span>
                        <span className="sunday-import-path">{u.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="sunday-import-footer">
                <button className="sunday-import-secondary" onClick={close}>Cancel</button>
                <button
                  className="sunday-import-primary"
                  onClick={() => void apply()}
                  disabled={plan.nothingToDo}
                >
                  {plan.nothingToDo ? 'Nothing to import' : 'Import everything'}
                </button>
              </div>
            </>
          )}

          {phase === 'report' && report && (
            <>
              <section>
                <h3>Converted ({report.converted.length})</h3>
                <ul className="sunday-import-list">
                  {report.converted.map((c, i) => (
                    <li key={i}>
                      <span className="sunday-import-action action-create">✓</span>
                      <span className="sunday-import-label">{c.source}</span>
                      <span className="sunday-import-path">{shortPath(c.target)}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {report.skipped.length > 0 && (
                <section>
                  <h3>Skipped ({report.skipped.length})</h3>
                  <ul className="sunday-import-list">
                    {report.skipped.map((s, i) => (
                      <li key={i} className="is-skip">
                        <span className="sunday-import-label">{shortPath(s.target)}</span>
                        <span className="sunday-import-path">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {report.needsAttention.length > 0 && (
                <section>
                  <h3>Needs your attention ({report.needsAttention.length})</h3>
                  <ul className="sunday-import-list">
                    {report.needsAttention.map((n, i) => (
                      <li key={i}>
                        <span className="sunday-import-label">{n.item}</span>
                        <span className="sunday-import-path">{n.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="sunday-import-footer">
                <button className="sunday-import-primary" onClick={close}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
