/**
 * Sunday Ops — the visible surface for F3/F6/F7/F8/F9/F10/F11/F12.
 *
 * One tab per F that previously had a working backend but no IDE UI.
 * Every tab calls real backend code via opsService; when a backend piece
 * is unavailable the tab shows an honest "not available" state — never
 * mock data.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { opsService, type SessionSummary } from '../../services/opsService';
import { gitService } from '../../services/gitService';
import './ops.css';

type OpsTab = 'routing' | 'sessions' | 'permissions' | 'hooks' | 'evidence' | 'security' | 'browser' | 'scoreboard';

const TABS: { id: OpsTab; label: string; f: string }[] = [
  { id: 'routing', label: 'Routing', f: 'F3' },
  { id: 'sessions', label: 'Sessions', f: 'F6' },
  { id: 'permissions', label: 'Permissions', f: 'F7' },
  { id: 'hooks', label: 'Hooks', f: 'F8' },
  { id: 'evidence', label: 'Evidence', f: 'F9' },
  { id: 'security', label: 'Security', f: 'F10' },
  { id: 'browser', label: 'Browser', f: 'F11' },
  { id: 'scoreboard', label: 'Scoreboard', f: 'F12' },
];

function Err({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="ops-error">{error}</div>;
}

function Loading({ label }: { label: string }) {
  return <div className="ops-loading">{label}…</div>;
}

/* ------------------------------------------------- F3: Routing */

function RoutingPanel() {
  const [policies, setPolicies] = useState<Awaited<ReturnType<typeof opsService.routingPolicies>> | null>(null);
  const [recent, setRecent] = useState<Awaited<ReturnType<typeof opsService.routingRecent>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [p, r] = await Promise.all([opsService.routingPolicies(), opsService.routingRecent()]);
        if (live) {
          setPolicies(p);
          setRecent(r);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Err error={error} />;
  if (!policies || !recent) return <Loading label="Loading routing" />;

  return (
    <div className="ops-panel">
      <div className="ops-note">{recent.note}</div>
      {recent.available && recent.entries.length > 0 && (
        <div className="ops-section">
          <h4>Recent decisions</h4>
          <table className="ops-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Task class</th>
                <th>Chosen</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {recent.entries.slice(-20).reverse().map((e) => (
                <tr key={e.seq}>
                  <td className="mono dim">{e.ts.slice(11, 19)}</td>
                  <td><span className="ops-chip">{e.taskClass}</span></td>
                  <td className="mono">{e.chosen ?? e.primary ?? '—'}</td>
                  <td className="dim">{e.reason ?? e.error ?? e.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ops-section">
        <h4>Route policies <span className="dim">(real config — every agent turn goes through this)</span></h4>
        <table className="ops-table">
          <thead>
            <tr>
              <th>Task class</th>
              <th>Primary</th>
              <th>Fallbacks</th>
              <th>Downgrade</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.taskClass}>
                <td><span className="ops-chip">{p.taskClass}</span></td>
                <td className="mono">{p.primary}</td>
                <td className="mono dim">{p.fallbacks.length > 0 ? p.fallbacks.join(', ') : '—'}</td>
                <td>
                  <span className={`ops-chip ${p.downgrade === 'ask' ? 'ok' : p.downgrade === 'never' ? 'danger' : ''}`}>
                    {p.downgrade}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ops-note">
          <strong>ask</strong> = Sunday never switches models without your consent. A consent prompt appears
          before any downgrade; denied/timeout pauses routing instead of silently switching.
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------- F6: Sessions */

function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [log, setLog] = useState<Awaited<ReturnType<typeof opsService.sessionLog>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await opsService.sessions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setLog(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const entries = await opsService.sessionLog(selected);
        if (live) setLog(entries);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [selected]);

  const act = useCallback(
    async (kind: 'rewind' | 'branch' | 'export', entryId?: string) => {
      if (!selected) return;
      setBusy(true);
      setError(null);
      try {
        if (kind === 'rewind' && entryId) {
          await window.sunday!.session.rewind(selected, entryId);
        } else if (kind === 'branch') {
          const title = window.prompt('Branch title:', 'branch');
          if (title === null) return;
          await window.sunday!.session.branch(selected, entryId, title || undefined);
        } else if (kind === 'export') {
          const res = (await window.sunday!.session.export(selected, 'markdown')) as { transcript?: string };
          const text = typeof res === 'string' ? res : res?.transcript ?? JSON.stringify(res, null, 2);
          const blob = new Blob([text], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `sunday-session-${selected.slice(0, 8)}.md`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
        if (selected) setLog(await opsService.sessionLog(selected));
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [selected, refresh],
  );

  if (error && !sessions) return <Err error={error} />;
  if (!sessions) return <Loading label="Loading sessions" />;

  return (
    <div className="ops-panel">
      <Err error={error} />
      {sessions.length === 0 ? (
        <div className="ops-empty">
          No daemon sessions yet. Sessions appear here once you chat with the Sunday Agent —
          every turn is written to an append-only, checksummed event log.
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
                <div className="ops-list-title mono">{s.id.slice(0, 12)}…</div>
                <div className="ops-list-sub dim">
                  {s.title ?? s.model ?? ''} {s.cwd ? `· ${s.cwd.split('/').pop()}` : ''}
                </div>
              </button>
            ))}
          </div>
          <div className="ops-detail">
            {!selected ? (
              <div className="ops-empty">Select a session to see its event timeline.</div>
            ) : !log ? (
              <Loading label="Loading event log" />
            ) : (
              <>
                <div className="ops-actions">
                  <button className="sunday-btn ghost ops-btn" disabled={busy} onClick={() => void act('branch')}>
                    Branch
                  </button>
                  <button className="sunday-btn ghost ops-btn" disabled={busy} onClick={() => void act('export')}>
                    Export
                  </button>
                </div>
                <div className="ops-timeline">
                  {log.map((e) => (
                    <div key={e.id} className="ops-timeline-row">
                      <span className="mono dim">#{e.seq}</span>
                      <span className="ops-chip">{e.type}</span>
                      <span className="dim">{e.summary}</span>
                      <button
                        className="ops-link"
                        disabled={busy}
                        title="Rewind session to this entry"
                        onClick={() => {
                          if (window.confirm(`Rewind session to entry #${e.seq} (${e.type})?`)) {
                            void act('rewind', e.id);
                          }
                        }}
                      >
                        rewind
                      </button>
                    </div>
                  ))}
                  {log.length === 0 && <div className="ops-empty">No events in this session yet.</div>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="ops-note">
        Rewind restores the session to an earlier checkpoint. The log is append-only with a SHA-256
        per entry — history is never silently rewritten.
      </div>
    </div>
  );
}

/* ------------------------------------------------- F7: Permissions */

function PermissionsPanel() {
  const { state } = useIde();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof opsService.policyInfo>> | null>(null);
  const [cmd, setCmd] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof opsService.policyEvaluate>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    opsService
      .policyInfo()
      .then((i) => {
        if (live) setInfo(i);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const test = useCallback(async () => {
    if (!cmd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await opsService.policyEvaluate(cmd.trim(), state.rootFolder ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [cmd, state.rootFolder]);

  if (error && !info) return <Err error={error} />;
  if (!info) return <Loading label="Loading policy" />;

  return (
    <div className="ops-panel">
      <Err error={error} />
      <div className="ops-section">
        <h4>Current profile: <span className="ops-chip ok">{info.currentProfile}</span></h4>
        <div className="ops-note">{info.profileSource}</div>
      </div>
      <div className="ops-section">
        <h4>Test a command</h4>
        <div className="ops-row">
          <input
            className="ops-input mono"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void test();
            }}
            placeholder='e.g. rm -rf /  or  npm install lodash'
          />
          <button className="sunday-btn ops-btn" disabled={busy} onClick={() => void test()}>
            Classify
          </button>
        </div>
        {result && (
          <div className="ops-result">
            <div>
              Tier: <span className={`ops-chip ${result.tier === 'destructive' ? 'danger' : result.tier === 'network' ? 'warn' : 'ok'}`}>{result.tier}</span>
              {' '}Decision: <span className={`ops-chip ${result.decision === 'deny' ? 'danger' : result.decision === 'ask' ? 'warn' : 'ok'}`}>{result.decision}</span>
            </div>
            <ul className="ops-reasons">
              {result.reasons.map((r, i) => (
                <li key={i} className="dim">{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="ops-section">
        <h4>Profile decision matrix <span className="dim">(real — from permission-intel)</span></h4>
        <table className="ops-table">
          <thead>
            <tr>
              <th>Tier</th>
              {info.profiles.map((p) => (
                <th key={p}>{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {info.tiers.map((t) => (
              <tr key={t}>
                <td className="mono">{t}</td>
                {info.profiles.map((p) => {
                  const d = info.matrix[p]?.[t] ?? '?';
                  return (
                    <td key={p}>
                      <span className={`ops-chip ${d === 'deny' ? 'danger' : d === 'ask' ? 'warn' : 'ok'}`}>{d}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ops-note">
          Destructive + network actions can never be blanket-allowlisted — <span className="mono">grant()</span> throws
          for those tiers. Approval decisions are written to the audit log.
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------- F8: Hooks */

function HooksPanel() {
  const { state } = useIde();
  const [hooks, setHooks] = useState<Awaited<ReturnType<typeof opsService.hooks>> | null>(null);
  const [consents, setConsents] = useState<Awaited<ReturnType<typeof opsService.hooksConsent>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [h, c] = await Promise.all([
          opsService.hooks(state.rootFolder ?? undefined),
          opsService.hooksConsent(),
        ]);
        if (live) {
          setHooks(h);
          setConsents(c);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [state.rootFolder]);

  if (error && !hooks) return <Err error={error} />;
  if (!hooks || !consents) return <Loading label="Loading hooks" />;

  return (
    <div className="ops-panel">
      <Err error={error} />
      <div className="ops-section">
        <h4>Configured hooks ({hooks.length})</h4>
        {hooks.length === 0 ? (
          <div className="ops-empty">
            No hooks configured. Add <span className="mono">.sunday/hooks.json</span> in your workspace
            (or <span className="mono">~/.sunday/hooks.json</span> for user hooks) — 5 recipes ship with Sunday:
            format-on-edit, secret-scan, block-env-reads, test-before-done, changelog-update.
          </div>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Event</th>
                <th>Source</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((h) => (
                <tr key={`${h.source}:${h.name}`}>
                  <td className="mono">{h.name}</td>
                  <td><span className="ops-chip">{h.event}</span></td>
                  <td className="dim">{h.source}</td>
                  <td>{h.enabled ? <span className="ops-chip ok">on</span> : <span className="ops-chip">off</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="ops-section">
        <h4>Hash-pinned consents ({consents.length})</h4>
        {consents.length === 0 ? (
          <div className="ops-note">
            No repo-hook consents recorded. Repo hooks never run without your explicit consent for the
            exact file hash — any byte change re-triggers consent.
          </div>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Hash</th>
                <th>Workspace</th>
                <th>Consented</th>
              </tr>
            </thead>
            <tbody>
              {consents.map((c) => (
                <tr key={c.hash}>
                  <td className="mono">{c.hash}</td>
                  <td className="dim">{c.workspaceRoot}</td>
                  <td className="dim">{c.consentedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------- F9: Evidence */

function EvidencePanel() {
  const { state } = useIde();
  const [goal, setGoal] = useState('');
  const [diff, setDiff] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof opsService.evidenceForDiff>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadWorktreeDiff = useCallback(async () => {
    if (!state.rootFolder) {
      setError('Open a folder first to load the worktree diff.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const st = await gitService.status(state.rootFolder);
      const files = [...st.unstaged.map((f) => f.path), ...st.staged.map((f) => f.path)];
      if (files.length === 0) {
        setError('Worktree is clean — nothing to analyze.');
        return;
      }
      const parts: string[] = [];
      for (const f of files.slice(0, 20)) {
        const d = await gitService.diff(state.rootFolder, f, false);
        if (d) parts.push(d);
      }
      if (parts.length === 0) {
        setError('No diff content found.');
        return;
      }
      setDiff(parts.join('\n'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [state.rootFolder]);

  const analyze = useCallback(async () => {
    if (!diff.trim()) {
      setError('Paste a diff or load the worktree diff first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await opsService.evidenceForDiff(diff, goal || 'review changes'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [diff, goal]);

  return (
    <div className="ops-panel">
      <Err error={error} />
      <div className="ops-row">
        <input
          className="ops-input"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Goal / intent (e.g. fix login bug)"
        />
        <button className="sunday-btn ghost ops-btn" disabled={busy} onClick={() => void loadWorktreeDiff()}>
          Load worktree diff
        </button>
        <button className="sunday-btn ops-btn" disabled={busy} onClick={() => void analyze()}>
          Analyze
        </button>
      </div>
      <textarea
        className="ops-textarea mono"
        value={diff}
        onChange={(e) => setDiff(e.target.value)}
        placeholder="Paste a unified diff here, or load the current worktree diff…"
        rows={8}
      />
      {result && (
        <div className="ops-section">
          <h4>
            Evidence pack — {result.hunks} hunks,{' '}
            <span className={result.highRisk > 0 ? 'text-danger' : 'text-ok'}>{result.highRisk} high-risk</span>,{' '}
            {result.unrelated} unrelated to intent
          </h4>
          {result.topRisks.length > 0 ? (
            <table className="ops-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Tier</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.topRisks.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.path}</td>
                    <td><span className={`ops-chip ${r.tier === 'critical' ? 'danger' : 'warn'}`}>{r.tier}</span></td>
                    <td className="dim">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="ops-note">No high-risk hunks. Auth/crypto, migrations, dep manifests, and public API changes would surface here.</div>
          )}
          <div className="ops-note">
            Verdict: {result.highRisk > 0 ? <strong className="text-danger">needs-review</strong> : <strong className="text-ok">looks clean</strong>}
            {result.unrelated > 0 && ` — ${result.unrelated} hunk(s) unrelated to the stated goal.`}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------- F10: Security */

function SecurityPanel() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof opsService.securityStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    opsService
      .securityStatus()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error && !status) return <Err error={error} />;
  if (!status) return <Loading label="Loading security status" />;

  return (
    <div className="ops-panel">
      <div className="ops-section">
        <h4>Injection firewall — {status.firewallRules.length} detection rules <span className="dim">(real config)</span></h4>
        <table className="ops-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Severity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {status.firewallRules.map((r) => (
              <tr key={r.rule}>
                <td className="mono">{r.rule}</td>
                <td><span className={`ops-chip ${r.severity === 'block' ? 'danger' : 'warn'}`}>{r.severity}</span></td>
                <td className="dim">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ops-section">
        <h4>Taint → sink policy</h4>
        <table className="ops-table">
          <thead>
            <tr>
              <th>Sink</th>
              <th>Risk tier</th>
            </tr>
          </thead>
          <tbody>
            {status.sinkTiers.map((s) => (
              <tr key={s.sink}>
                <td className="mono">{s.sink}</td>
                <td><span className={`ops-chip ${s.tier === 'destructive' ? 'danger' : s.tier === 'network' ? 'warn' : 'ok'}`}>{s.tier}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ops-note">
          Untrusted content reaching a terminal, network, or outside-workspace sink always triggers
          an approval prompt — the firewall verdict runs on every agent tool call.
        </div>
      </div>
      <div className="ops-section">
        <h4>Secret scan</h4>
        <div className="ops-note">{status.secretScan.note}</div>
        <h4>MCP tool pins</h4>
        <div className="ops-note">{status.mcpPins.note}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------- F11: Browser */

function BrowserPanel() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<Awaited<ReturnType<typeof opsService.browserVisualDiff>> | null>(null);
  const [a11y, setA11y] = useState<Awaited<ReturnType<typeof opsService.browserA11yScan>> | null>(null);
  const [matrix, setMatrix] = useState<Awaited<ReturnType<typeof opsService.browserViewportMatrix>> | null>(null);
  const [captured, setCaptured] = useState<{ label: string; png: string }[]>([]);

  const run = useCallback(
    async (kind: string, fn: () => Promise<void>) => {
      setBusy(kind);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const openUrl = useCallback(async () => {
    if (!url.trim()) {
      setError('Enter a URL first.');
      return;
    }
    await run('open', async () => {
      const r = await opsService.browserOpen(url.trim());
      if (r.needsApproval) {
        setError(`New origin ${r.origin ?? ''} needs approval — approve it in the agent browser first, then retry.`);
      }
    });
  }, [url, run]);

  const capture = useCallback(
    async (label: string) => {
      await run(`cap-${label}`, async () => {
        const png = await opsService.browserScreenshot();
        setCaptured((prev) => [...prev.slice(-3), { label, png }]);
      });
    },
    [run],
  );

  const visualDiff = useCallback(async () => {
    if (captured.length < 2) {
      setError('Capture two screenshots first (open two URLs and capture each).');
      return;
    }
    const [a, b] = captured.slice(-2);
    await run('diff', async () => {
      setDiffResult(await opsService.browserVisualDiff(a.png, b.png));
    });
  }, [captured, run]);

  const a11yScan = useCallback(async () => {
    await run('a11y', async () => {
      setA11y(await opsService.browserA11yScan());
    });
  }, [run]);

  const viewportMatrix = useCallback(async () => {
    if (!url.trim()) {
      setError('Enter a URL first.');
      return;
    }
    await run('matrix', async () => {
      setMatrix(await opsService.browserViewportMatrix(url.trim()));
    });
  }, [url, run]);

  return (
    <div className="ops-panel">
      <Err error={error} />
      <div className="ops-note">
        Browser-verified UI loop: open a page, capture screenshots, pixel-diff before/after a fix,
        run an axe-core accessibility scan, or capture the mobile/tablet/desktop viewport matrix.
        Requires the agent browser (browserd) — if it is offline the actions below report it honestly.
      </div>
      <div className="ops-section">
        <h4>1 · Open page</h4>
        <div className="ops-row">
          <input
            className="ops-input mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void openUrl();
            }}
            placeholder="https://…"
          />
          <button className="sunday-btn ops-btn" disabled={!!busy} onClick={() => void openUrl()}>
            {busy === 'open' ? 'Opening…' : 'Open'}
          </button>
        </div>
      </div>
      <div className="ops-section">
        <h4>2 · Visual diff</h4>
        <div className="ops-row">
          <button className="sunday-btn ghost ops-btn" disabled={!!busy} onClick={() => void capture('before')}>
            {busy === 'cap-before' ? 'Capturing…' : 'Capture A'}
          </button>
          <button className="sunday-btn ghost ops-btn" disabled={!!busy} onClick={() => void capture('after')}>
            {busy === 'cap-after' ? 'Capturing…' : 'Capture B'}
          </button>
          <button className="sunday-btn ops-btn" disabled={!!busy || captured.length < 2} onClick={() => void visualDiff()}>
            {busy === 'diff' ? 'Diffing…' : `Diff (${captured.length} captured)`}
          </button>
        </div>
        {diffResult && (
          <div className="ops-result mono">
            {diffResult.diffPixels}/{diffResult.totalPixels} pixels differ ({(diffResult.diffRatio * 100).toFixed(2)}%)
            {diffResult.diffPath && <div className="dim">Diff artifact: {diffResult.diffPath}</div>}
          </div>
        )}
      </div>
      <div className="ops-section">
        <h4>3 · Accessibility scan</h4>
        <button className="sunday-btn ops-btn" disabled={!!busy} onClick={() => void a11yScan()}>
          {busy === 'a11y' ? 'Scanning…' : 'Run axe-core scan'}
        </button>
        {a11y && (
          <div className="ops-section">
            <div className="ops-note">
              {a11y.url ?? 'current page'} — {a11y.violations.length} violation(s), {a11y.passes} rule(s) passed
            </div>
            {a11y.violations.length > 0 && (
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Impact</th>
                    <th>Nodes</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {a11y.violations.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">{v.id}</td>
                      <td>
                        <span className={`ops-chip ${v.impact === 'critical' || v.impact === 'serious' ? 'danger' : 'warn'}`}>
                          {v.impact ?? 'unknown'}
                        </span>
                      </td>
                      <td className="mono">×{v.nodes}</td>
                      <td className="dim">{v.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
      <div className="ops-section">
        <h4>4 · Viewport matrix</h4>
        <button className="sunday-btn ops-btn" disabled={!!busy} onClick={() => void viewportMatrix()}>
          {busy === 'matrix' ? 'Capturing…' : 'Capture 390×844 / 820×1180 / 1440×900'}
        </button>
        {matrix && matrix.length > 0 && (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Viewport</th>
                <th>Size</th>
                <th>Artifact</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((s) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="mono dim">{s.width}×{s.height}</td>
                  <td className="dim">{s.path ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------- F12: Scoreboard */

function ScoreboardPanel() {
  const [board, setBoard] = useState<Awaited<ReturnType<typeof opsService.scoreboard>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    opsService
      .scoreboard()
      .then((b) => {
        if (live) setBoard(b);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error && !board) return <Err error={error} />;
  if (!board) return <Loading label="Loading scoreboard" />;

  return (
    <div className="ops-panel">
      {!board.found ? (
        <div className="ops-empty">{board.note}</div>
      ) : (
        <>
          <div className="ops-note">
            {board.generatedAt && <>Generated {board.generatedAt.slice(0, 10)}. </>}
            {board.note}
          </div>
          {board.rows.length === 0 ? (
            <div className="ops-empty">{board.note}</div>
          ) : (
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Runs</th>
                  <th>Pass rate</th>
                  <th>Tool reliability</th>
                  <th>Median time</th>
                  <th>Cost / success</th>
                  <th>Loop-trigger</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.model}>
                    <td className="mono">{r.model}</td>
                    <td className="mono">{r.runs}</td>
                    <td>{r.passRate}</td>
                    <td>{r.toolReliability}</td>
                    <td className="mono dim">{r.medianTime}</td>
                    <td className="mono">{r.costPerSuccess}</td>
                    <td>{r.loopTriggerRate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="ops-note">
            Cost-per-successful-task counts only verifier-passing tasks (F1). Loop-trigger rate replays
            each transcript through the real F2 LoopGuard. Reproduce: <span className="mono">sunday-eval run [--live]</span> then <span className="mono">sunday-eval scoreboard</span>.
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------- shell */

export function OpsView() {
  const [tab, setTab] = useState<OpsTab>('routing');

  return (
    <div className="ops-root">
      <div className="sunday-sidebar-header">
        <span className="title">SUNDAY OPS</span>
      </div>
      <div className="ops-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`ops-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
            title={`${t.label} (${t.f})`}
          >
            <span className="ops-tab-f">{t.f}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="ops-body">
        {tab === 'routing' && <RoutingPanel />}
        {tab === 'sessions' && <SessionsPanel />}
        {tab === 'permissions' && <PermissionsPanel />}
        {tab === 'hooks' && <HooksPanel />}
        {tab === 'evidence' && <EvidencePanel />}
        {tab === 'security' && <SecurityPanel />}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'scoreboard' && <ScoreboardPanel />}
      </div>
    </div>
  );
}
