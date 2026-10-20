/**
 * Mission Control — kanban over the REAL orchestrator daemon.
 *
 * Missions are planned (`orchestrate/plan`), run (`orchestrate/run`),
 * tracked (`orchestrate/status` + `orchestrate/event`) and stopped
 * (`orchestrate/stop`) by electron/missionService.ts via the daemon.
 * This view renders that real state — planned units, live log tail,
 * per-unit status — and shows daemon errors honestly. No mock data.
 *
 * Columns: Queued (planned + queued) / Running / Done /
 * Failed (failed + error + stopped — the card shows its real label).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { AGENT_MODELS } from '../../services/agentService';
import {
  missionService,
  type Mission,
  type MissionStatus,
  type UnitRunStatus,
} from '../../services/missionService';
import './missions.css';

type ColumnId = 'queued' | 'running' | 'done' | 'failed';

const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
];

function columnFor(status: MissionStatus): ColumnId {
  switch (status) {
    case 'planned':
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
    case 'error':
    case 'stopped':
      return 'failed';
  }
}

function statusChipClass(status: MissionStatus): string {
  if (status === 'done') return 'mission-chip ok';
  if (status === 'running' || status === 'queued') return 'mission-chip warn';
  if (status === 'failed' || status === 'error' || status === 'stopped') return 'mission-chip danger';
  return 'mission-chip';
}

const UNIT_ICON: Record<UnitRunStatus, string> = {
  queued: '○',
  running: '◐',
  verifying: '◎',
  done: '✓',
  failed: '✕',
  cancelled: '⊘',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour12: false });
}

/** Live log tail — last entries, auto-scrolled to the newest line. */
function LogTail({ mission }: { mission: Mission }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const entries = mission.logTail.slice(-6);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mission.logTail]);

  if (entries.length === 0) return null;
  return (
    <div className="mission-log" ref={ref} aria-label="Mission log">
      {entries.map((e, i) => (
        <div key={`${e.ts}-${i}`} className="mission-log-row">
          <span className="mission-log-time">{formatLogTime(e.ts)}</span>
          <span className="mission-log-phase">{e.phase}</span>
          {e.unitId && <span>{e.unitId}</span>}
          {e.detail && <span className="mission-log-detail">{e.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function unitStatusFor(mission: Mission, unitId: string): UnitRunStatus | undefined {
  return mission.units?.find((u) => u.id === unitId)?.status;
}

function MissionCard({
  mission,
  busy,
  onStart,
  onStop,
  onRefresh,
}: {
  mission: Mission;
  busy: boolean;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRefresh: (id: string) => void;
}) {
  const isActive = mission.status === 'running' || mission.status === 'queued';
  const isTerminal =
    mission.status === 'done' ||
    mission.status === 'failed' ||
    mission.status === 'error' ||
    mission.status === 'stopped';
  const planUnits = mission.plan?.units ?? [];
  // Once running, prefer live unit states (they carry sha / errors);
  // before that, show the plan checklist.
  const checklist =
    mission.units && mission.units.length > 0
      ? mission.units.map((u) => ({ id: u.id, title: u.title, status: u.status, sha: u.sha, error: u.error }))
      : planUnits.map((u) => ({
          id: u.id,
          title: u.title,
          status: unitStatusFor(mission, u.id),
          sha: undefined as string | undefined,
          error: undefined as string | undefined,
        }));

  return (
    <div className="mission-card">
      <div className="mission-goal" title={mission.goal}>
        {mission.goal}
      </div>
      <div className="mission-meta">
        <span className={statusChipClass(mission.status)}>{mission.status}</span>
        <span className="mission-chip">{mission.model ?? 'auto'}</span>
        <span>{formatTime(mission.createdAt)}</span>
      </div>

      {checklist.length > 0 && (
        <ul className="mission-units">
          {checklist.map((u) => (
            <li key={u.id} className="mission-unit" data-status={u.status ?? 'planned'}>
              <span className="mission-unit-icon">{u.status ? UNIT_ICON[u.status] : '○'}</span>
              <span className="mission-unit-title">{u.title}</span>
              {u.sha && <span className="mission-unit-sha">{u.sha.slice(0, 8)}</span>}
            </li>
          ))}
        </ul>
      )}
      {checklist.some((u) => u.error) && (
        <div className="mission-card-error">
          {checklist
            .filter((u) => u.error)
            .map((u) => `${u.id}: ${u.error}`)
            .join(' · ')}
        </div>
      )}

      {mission.plan && mission.status === 'planned' && (
        <div className="mission-budget">
          Est. {mission.plan.totalBudget} model requests · {mission.plan.units.length} unit
          {mission.plan.units.length === 1 ? '' : 's'}
        </div>
      )}

      <LogTail mission={mission} />

      {mission.error && <div className="mission-card-error">{mission.error}</div>}

      <div className="mission-actions">
        {mission.status === 'planned' && (
          <button className="sunday-btn missions-btn small" disabled={busy} onClick={() => onStart(mission.id)}>
            Run mission
          </button>
        )}
        {isActive && (
          <>
            <button className="sunday-btn ghost missions-btn small" disabled={busy} onClick={() => onStop(mission.id)}>
              Stop
            </button>
            {mission.runId && (
              <button className="sunday-btn ghost missions-btn small" disabled={busy} onClick={() => onRefresh(mission.id)}>
                Refresh status
              </button>
            )}
            <span className="missions-note">auto-refreshing…</span>
          </>
        )}
        {isTerminal && mission.runId && (
          <button className="sunday-btn ghost missions-btn small" disabled={busy} onClick={() => onRefresh(mission.id)}>
            Refresh status
          </button>
        )}
      </div>
    </div>
  );
}

export function MissionControl() {
  const { state } = useIde();
  const workspaceRoot = state.rootFolder;
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState<string>('auto');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      setMissions(await missionService.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Main process broadcasts this after every mutating missions call.
  useEffect(() => {
    const onChanged = () => {
      void reload();
    };
    window.addEventListener('sunday:missions:changed', onChanged);
    return () => window.removeEventListener('sunday:missions:changed', onChanged);
  }, [reload]);

  const hasActive = (missions ?? []).some((m) => m.status === 'running' || m.status === 'queued');

  // Poll refresh every 4s while any mission is in flight. The interval
  // is cleaned up on unmount and whenever nothing is active anymore.
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      void (async () => {
        const current = await missionService.list().catch(() => null);
        if (!current) return;
        for (const m of current) {
          if ((m.status === 'running' || m.status === 'queued') && m.runId) {
            await missionService.refresh(m.id).catch(() => undefined);
          }
        }
        await reload();
      })();
    }, 4000);
    return () => clearInterval(timer);
  }, [hasActive, reload]);

  const create = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed) {
      setError('Describe the mission first.');
      return;
    }
    if (!workspaceRoot) {
      setError('Open a folder first — missions run against a workspace.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await missionService.create({
        goal: trimmed,
        ...(model !== 'auto' ? { model } : {}),
        workspaceRoot,
      });
      setGoal('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [goal, model, workspaceRoot, reload]);

  const act = useCallback(
    async (id: string, fn: (id: string) => Promise<Mission>) => {
      setBusyIds((prev) => new Set(prev).add(id));
      setError(null);
      try {
        await fn(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await reload();
      }
    },
    [reload],
  );

  const onStart = useCallback((id: string) => void act(id, missionService.start), [act]);
  const onStop = useCallback((id: string) => void act(id, missionService.stop), [act]);
  const onRefresh = useCallback((id: string) => void act(id, missionService.refresh), [act]);

  return (
    <div className="missions-root">
      <div className="sunday-sidebar-header">
        <span className="title">MISSION CONTROL</span>
      </div>

      <div className="missions-create">
        <textarea
          className="missions-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe the mission — Sunday plans it into units and runs them…"
          rows={3}
        />
        <div className="missions-row">
          <select
            className="missions-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Mission model"
          >
            {AGENT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button className="sunday-btn missions-btn" disabled={creating} onClick={() => void create()}>
            {creating ? 'Planning…' : 'Plan mission'}
          </button>
        </div>
        <div className="missions-note" title={workspaceRoot ?? undefined}>
          {workspaceRoot
            ? `Workspace: ${workspaceRoot}`
            : 'No workspace open — open a folder to plan a mission.'}
        </div>
      </div>

      {error && <div className="missions-error">{error}</div>}

      <div className="missions-board">
        {missions === null ? (
          <div className="missions-loading">Loading missions…</div>
        ) : missions.length === 0 ? (
          <div className="missions-empty">
            No missions yet. Plan your first mission above — tasks run on the real Sunday agent daemon.
          </div>
        ) : (
          COLUMNS.map((col) => {
            const cards = missions.filter((m) => columnFor(m.status) === col.id);
            return (
              <div key={col.id} className="missions-column" data-col={col.id}>
                <div className="missions-column-header">
                  <span className="missions-column-dot" />
                  <span>{col.label}</span>
                  <span className="missions-count">{cards.length}</span>
                </div>
                {cards.length === 0 ? (
                  <div className="missions-column-empty">—</div>
                ) : (
                  cards.map((m) => (
                    <MissionCard
                      key={m.id}
                      mission={m}
                      busy={busyIds.has(m.id)}
                      onStart={onStart}
                      onStop={onStop}
                      onRefresh={onRefresh}
                    />
                  ))
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
