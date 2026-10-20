/**
 * Mission Control service — typed access to the `window.sunday.missions`
 * bridge. Every call hits real backend code (electron/missionService.ts),
 * which in turn drives the real sundayd orchestrator RPCs. No mocks.
 *
 * The shared types below are the canonical Mission shapes; preload.ts
 * mirrors them exactly (see the integration snippet).
 */
import type { SundayAPI } from '../../electron/preload';

declare global {
  interface Window {
    sunday?: SundayAPI;
  }
}

export interface PlannedUnit {
  id: string;
  title: string;
  owns_paths: string[];
  acceptance: string[];
  budget: number;
}

export interface MissionPlan {
  units: PlannedUnit[];
  totalBudget: number;
}

export type UnitRunStatus = 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface UnitRunState {
  id: string;
  title: string;
  status: UnitRunStatus;
  worktreePath?: string;
  model?: string;
  steps?: number;
  sha?: string;
  error?: string;
}

export type MissionStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'error';

export interface MissionLogEntry {
  ts: string;
  unitId?: string;
  phase: string;
  detail?: string;
}

export interface Mission {
  id: string;
  goal: string;
  model?: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  status: MissionStatus;
  runId?: string;
  plan?: MissionPlan;
  units?: UnitRunState[];
  logTail: MissionLogEntry[];
  error?: string;
}

export interface CreateMissionInput {
  goal: string;
  model?: string;
  workspaceRoot: string;
}

/** Shape of the preload `missions` bridge (mirrored in electron/preload.ts). */
export interface MissionsBridge {
  list(): Promise<Mission[]>;
  create(input: CreateMissionInput): Promise<Mission>;
  start(id: string): Promise<Mission>;
  refresh(id: string): Promise<Mission>;
  stop(id: string): Promise<Mission>;
}

function bridge(): SundayAPI {
  const api = window.sunday;
  if (!api) {
    throw new Error(
      'Sunday bridge unavailable — the Sunday IDE renderer must run inside the Electron shell (`pnpm dev`).',
    );
  }
  return api;
}

function missions(): MissionsBridge {
  // Cast: the `missions` field is added to SundayAPI by the preload
  // integration (same shapes). The cast keeps this module type-correct
  // both before and after that integration lands.
  const api = bridge() as SundayAPI & { missions?: MissionsBridge };
  if (!api.missions) {
    throw new Error('Sunday missions bridge unavailable — preload integration missing.');
  }
  return api.missions;
}

export const missionService = {
  list: (): Promise<Mission[]> => missions().list(),
  create: (input: CreateMissionInput): Promise<Mission> => missions().create(input),
  start: (id: string): Promise<Mission> => missions().start(id),
  refresh: (id: string): Promise<Mission> => missions().refresh(id),
  stop: (id: string): Promise<Mission> => missions().stop(id),
};
