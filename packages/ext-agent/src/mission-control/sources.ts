// Mission Control — source adapters (Group A, A4).
//
// Four WorkSource implementations:
// - OrchestrationSource: orchestrator runs via `orchestrate/status` RPC.
// - BrowserSource: browser sessions from an injected provider (the browser
//   panel owns the session state; there is no session-list RPC).
// - CloudTaskSource: A1 cloud tasks via the hosted gateway.
// - ScheduleSource: A5 scheduled tasks via the shared SchedulerSource.
//
// All adapters degrade to empty sections when their backend is
// unreachable — the dashboard stays up.

import type { HostBridge } from '../hostBridge.js';
import type { CloudTaskClient } from '../cloudTasks.js';
import type { SchedulerSource } from '../scheduler.js';
import type { WorkItem, WorkSource } from './types.js';

export interface SourceDeps {
  getBridge: () => Promise<HostBridge | undefined>;
  log: (msg: string) => void;
}

async function requireBridge(deps: SourceDeps): Promise<HostBridge> {
  const bridge = await deps.getBridge();
  if (!bridge) throw new Error('Sunday sidecar is not running.');
  return bridge;
}

// -- orchestrator runs ----------------------------------------------------------

export interface OrchestrationSourceDeps extends SourceDeps {
  /** Run ids the IDE knows about (wired to the orchestration manager view). */
  getRunIds: () => string[];
}

export function makeOrchestrationSource(deps: OrchestrationSourceDeps): WorkSource {
  return {
    kind: 'orchestration',
    label: 'Orchestrator runs',
    emptyNote: 'No active orchestration runs.',
    async list(): Promise<WorkItem[]> {
      const bridge = await requireBridge(deps);
      const items: WorkItem[] = [];
      for (const runId of deps.getRunIds()) {
        try {
          const st = await bridge.orchestrateStatus(runId);
          const units = st.units ?? [];
          items.push({
            id: runId,
            kind: 'orchestration',
            name: st.goal?.slice(0, 80) || runId,
            status: st.status,
            startedAt: st.createdAt ? Date.parse(st.createdAt) || Date.now() : Date.now(),
            lastLog: units.slice(-3).map((u) => `${u.title || u.id}: ${u.status}${u.error ? ` — ${u.error.slice(0, 120)}` : ''}`),
            stoppable: st.status === 'running' || st.status === 'conflicted',
            restartable: false,
          });
        } catch (err) {
          deps.log(`mission control: orchestrateStatus(${runId}) failed: ${(err as Error).message}`);
        }
      }
      return items;
    },
    async stop(item: WorkItem): Promise<void> {
      const bridge = await requireBridge(deps);
      await bridge.orchestrateStop(item.id);
      deps.log(`mission control: stopped orchestration ${item.id}`);
    },
    async restart(): Promise<void> {
      throw new Error('Orchestration runs cannot be restarted — start a new run instead.');
    },
  };
}

// -- browser sessions -----------------------------------------------------------

export interface BrowserSessionInfo {
  id: string;
  url: string;
  startedAt: number;
  hasControl: boolean;
}

export interface BrowserSourceDeps extends SourceDeps {
  getSessions: () => BrowserSessionInfo[];
  closeSession: (id: string) => Promise<void>;
}

export function makeBrowserSource(deps: BrowserSourceDeps): WorkSource {
  return {
    kind: 'browser',
    label: 'Browser sessions',
    emptyNote: 'No browser sessions. Open one with "Sunday: Open Agent Browser".',
    async list(): Promise<WorkItem[]> {
      return deps.getSessions().map((s) => ({
        id: s.id,
        kind: 'browser' as const,
        name: s.url || s.id,
        status: s.hasControl ? 'user-control' : 'agent-control',
        startedAt: s.startedAt,
        lastLog: [],
        stoppable: true,
        restartable: false,
      }));
    },
    async stop(item: WorkItem): Promise<void> {
      await deps.closeSession(item.id);
      deps.log(`mission control: closed browser session ${item.id}`);
    },
    async restart(): Promise<void> {
      throw new Error('Browser sessions cannot be restarted from Mission Control.');
    },
  };
}

// -- cloud tasks (A1) -------------------------------------------------------------

export interface CloudTaskSourceDeps extends SourceDeps {
  makeClient: () => CloudTaskClient;
}

export function makeCloudTaskSource(deps: CloudTaskSourceDeps): WorkSource {
  return {
    kind: 'cloud-task',
    label: 'Cloud tasks',
    emptyNote: 'No cloud tasks. Submit one with "Sunday: Submit Cloud Task".',
    async list(): Promise<WorkItem[]> {
      const tasks = await deps.makeClient().list();
      return tasks.map((t) => ({
        id: t.id,
        kind: 'cloud-task' as const,
        name: t.prompt.slice(0, 80),
        status: t.status,
        startedAt: t.created_at ? Date.parse(t.created_at) || Date.now() : Date.now(),
        lastLog: t.status === 'failed' && t.error ? [t.error.slice(0, 200)] : [],
        stoppable: false,
        restartable: false,
      }));
    },
    async stop(): Promise<void> {
      throw new Error('Cloud tasks cannot be stopped once queued.');
    },
    async restart(): Promise<void> {
      throw new Error('Cloud tasks cannot be restarted — submit a new one instead.');
    },
  };
}

// -- scheduled tasks (A5) -----------------------------------------------------------

export function makeScheduleSource(scheduler: SchedulerSource, log: (m: string) => void): WorkSource {
  return {
    kind: 'schedule',
    label: 'Scheduled tasks',
    emptyNote: 'No schedules yet. Create one with "Sunday: Create Schedule".',
    async list(): Promise<WorkItem[]> {
      const tasks = await scheduler.listScheduledTasks();
      return tasks.map((t) => ({
        id: t.name,
        kind: 'schedule' as const,
        name: `${t.name} — ${t.cron}`,
        status: t.running ? 'running' : t.enabled ? 'enabled' : 'disabled',
        startedAt: t.lastRunAt ? Date.parse(t.lastRunAt) || Date.now() : Date.now(),
        lastLog: t.lastStatus ? [`last run: ${t.lastStatus}`] : [],
        stoppable: t.enabled,
        restartable: t.enabled,
      }));
    },
    async stop(item: WorkItem): Promise<void> {
      await scheduler.setScheduleEnabled(item.id, false);
      log(`mission control: disabled schedule ${item.id}`);
    },
    async restart(item: WorkItem): Promise<void> {
      await scheduler.runScheduleNow(item.id);
      log(`mission control: ran schedule ${item.id} now`);
    },
  };
}
