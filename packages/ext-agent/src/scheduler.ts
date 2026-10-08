// sunday-agent — scheduled tasks (Group A, A5).
//
// Commands to manage sundayd's cron schedules (`scheduler/*` RPC):
// create (multi-input: name, cron, prompt), list (quickpick with
// enable/disable toggle + run-now), delete (confirm).
//
// Also exports the shared SchedulerSource interface consumed by the
// Mission Control dashboard (A4) — structural typing, no import needed
// on that side.
//
// vscode-coupled by design; covered by scheduler.test.ts with a mocked
// `vscode` module and a stub HostBridge.
import * as vscode from 'vscode';
import type { HostBridge } from './hostBridge.js';
import type { ScheduleDef } from '@sunday/protocol';

export const SCHEDULE_CREATE_COMMAND = 'sunday.schedule.create';
export const SCHEDULE_LIST_COMMAND = 'sunday.schedule.list';
export const SCHEDULE_DELETE_COMMAND = 'sunday.schedule.delete';

export interface SchedulerCommandDeps {
  getBridge: () => Promise<HostBridge | undefined>;
  log: (msg: string) => void;
}

/**
 * Shared local interface for Mission Control (A4): the scheduler command
 * module implements it, and the dashboard consumes it structurally.
 */
export interface ScheduledTaskInfo {
  name: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string;
  lastStatus?: string;
  running: boolean;
}

export interface SchedulerSource {
  listScheduledTasks(): Promise<ScheduledTaskInfo[]>;
  setScheduleEnabled(name: string, enabled: boolean): Promise<void>;
  runScheduleNow(name: string): Promise<void>;
  deleteSchedule(name: string): Promise<void>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Loose client-side cron sanity check (the daemon validates strictly). */
const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

export function validateScheduleName(input: string): string | undefined {
  const v = input.trim();
  if (!v) return 'Enter a name.';
  if (!NAME_RE.test(v)) return 'Use letters, digits, dot, dash, underscore (max 64 chars).';
  return undefined;
}

export function validateCronInput(input: string): string | undefined {
  const v = input.trim();
  if (!v) return 'Enter a cron expression.';
  if (!CRON_RE.test(v)) return 'Cron needs 5 fields: minute hour day month weekday (e.g. "0 9 * * 1-5").';
  return undefined;
}

async function statusInfo(bridge: HostBridge): Promise<ScheduledTaskInfo[]> {
  const { schedules, running } = await bridge.schedulerStatus();
  const runningSet = new Set(running);
  return schedules.map((s) => ({
    name: s.name,
    cron: s.cron,
    enabled: s.enabled,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    running: runningSet.has(s.name),
  }));
}

export async function createSchedule(deps: SchedulerCommandDeps): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Sunday: Create schedule (1/3)',
    prompt: 'Schedule name',
    placeHolder: 'e.g. morning-briefing',
    validateInput: validateScheduleName,
  });
  if (!name) return;
  const cron = await vscode.window.showInputBox({
    title: 'Sunday: Create schedule (2/3)',
    prompt: 'Cron schedule — minute hour day month weekday',
    placeHolder: 'e.g. 0 9 * * 1-5  (weekdays at 09:00)',
    validateInput: validateCronInput,
  });
  if (!cron) return;
  const prompt = await vscode.window.showInputBox({
    title: 'Sunday: Create schedule (3/3)',
    prompt: 'Prompt the agent runs on this schedule',
    placeHolder: 'e.g. Summarize overnight CI failures in this repo',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a prompt.'),
  });
  if (!prompt) return;
  const bridge = await deps.getBridge();
  if (!bridge) return;
  try {
    await bridge.schedulerCreate({ name: name.trim(), cron: cron.trim(), prompt: prompt.trim() });
    deps.log(`schedule created: ${name.trim()} (${cron.trim()})`);
    vscode.window.showInformationMessage(`Schedule "${name.trim()}" created — runs ${cron.trim()}.`);
  } catch (err) {
    deps.log(`schedule create failed: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Could not create schedule: ${(err as Error).message}`);
  }
}

export async function listSchedules(deps: SchedulerCommandDeps): Promise<void> {
  const bridge = await deps.getBridge();
  if (!bridge) return;
  let infos: ScheduledTaskInfo[];
  try {
    infos = await statusInfo(bridge);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not list schedules: ${(err as Error).message}`);
    return;
  }
  if (!infos.length) {
    vscode.window.showInformationMessage('No schedules yet. Create one with "Sunday: Create Schedule".');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    infos.map((s) => ({
      label: `${s.enabled ? '$(check)' : '$(circle-slash)'} ${s.name}`,
      description: `${s.cron}${s.running ? ' · running now' : ''}${s.lastStatus ? ` · last: ${s.lastStatus}` : ''}`,
      detail: s.enabled ? 'Enabled — pick an action' : 'Disabled — pick an action',
      info: s,
    })),
    { title: 'Sunday: Scheduled tasks', placeHolder: 'Select a schedule' },
  );
  if (!pick) return;
  const s = pick.info;
  const action = await vscode.window.showQuickPick(
    [
      { label: s.enabled ? 'Disable' : 'Enable', action: 'toggle' },
      { label: 'Run now', action: 'run' },
      { label: 'Delete', action: 'delete' },
    ],
    { title: `Sunday: ${s.name}`, placeHolder: 'Choose an action' },
  );
  if (!action) return;
  try {
    if (action.action === 'toggle') {
      await bridge.schedulerUpdate({ name: s.name, enabled: !s.enabled });
      vscode.window.showInformationMessage(`Schedule "${s.name}" ${s.enabled ? 'disabled' : 'enabled'}.`);
    } else if (action.action === 'run') {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running schedule "${s.name}"…`, cancellable: false },
        () => bridge.schedulerRunNow({ name: s.name }),
      );
      vscode.window.showInformationMessage(`Schedule "${s.name}" finished.`);
    } else {
      const confirm = await vscode.window.showWarningMessage(
        `Delete schedule "${s.name}"? This cannot be undone.`,
        'Delete',
        'Cancel',
      );
      if (confirm !== 'Delete') return;
      await bridge.schedulerDelete({ name: s.name });
      vscode.window.showInformationMessage(`Schedule "${s.name}" deleted.`);
    }
    deps.log(`schedule ${s.name}: ${action.action}`);
  } catch (err) {
    deps.log(`schedule ${action.action} failed for ${s.name}: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Schedule action failed: ${(err as Error).message}`);
  }
}

export async function deleteSchedule(deps: SchedulerCommandDeps): Promise<void> {
  const bridge = await deps.getBridge();
  if (!bridge) return;
  let infos: ScheduledTaskInfo[];
  try {
    infos = await statusInfo(bridge);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not list schedules: ${(err as Error).message}`);
    return;
  }
  if (!infos.length) {
    vscode.window.showInformationMessage('No schedules to delete.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    infos.map((s) => ({ label: s.name, description: s.cron, info: s })),
    { title: 'Sunday: Delete schedule', placeHolder: 'Select a schedule to delete' },
  );
  if (!pick) return;
  const confirm = await vscode.window.showWarningMessage(
    `Delete schedule "${pick.info.name}"? This cannot be undone.`,
    'Delete',
    'Cancel',
  );
  if (confirm !== 'Delete') return;
  try {
    await bridge.schedulerDelete({ name: pick.info.name });
    deps.log(`schedule deleted: ${pick.info.name}`);
    vscode.window.showInformationMessage(`Schedule "${pick.info.name}" deleted.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not delete schedule: ${(err as Error).message}`);
  }
}

export function registerSchedulerCommands(
  context: vscode.ExtensionContext,
  deps: SchedulerCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SCHEDULE_CREATE_COMMAND, () => createSchedule(deps)),
    vscode.commands.registerCommand(SCHEDULE_LIST_COMMAND, () => listSchedules(deps)),
    vscode.commands.registerCommand(SCHEDULE_DELETE_COMMAND, () => deleteSchedule(deps)),
  );
}

/** SchedulerSource implementation for Mission Control (A4). */
export function makeSchedulerSource(deps: SchedulerCommandDeps): SchedulerSource {
  return {
    async listScheduledTasks(): Promise<ScheduledTaskInfo[]> {
      const bridge = await deps.getBridge();
      if (!bridge) return [];
      try {
        return await statusInfo(bridge);
      } catch {
        return [];
      }
    },
    async setScheduleEnabled(name: string, enabled: boolean): Promise<void> {
      const bridge = await deps.getBridge();
      if (!bridge) throw new Error('Sunday sidecar is not running.');
      await bridge.schedulerUpdate({ name, enabled });
    },
    async runScheduleNow(name: string): Promise<void> {
      const bridge = await deps.getBridge();
      if (!bridge) throw new Error('Sunday sidecar is not running.');
      await bridge.schedulerRunNow({ name });
    },
    async deleteSchedule(name: string): Promise<void> {
      const bridge = await deps.getBridge();
      if (!bridge) throw new Error('Sunday sidecar is not running.');
      await bridge.schedulerDelete({ name });
    },
  };
}

export type { ScheduleDef };
