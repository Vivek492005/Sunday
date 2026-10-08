// sunday-agent — onboarding wizard (Workflow, C3): checklist state machine.
// Pure step list construction + immutable updates; the command module owns
// I/O and posts updates to the webview.

import type { RepoAnalysis } from './detect.js';
import { stackLabel } from './detect.js';

export type StepStatus = 'done' | 'pending' | 'running' | 'failed' | 'skipped';

export type StepAction = 'install' | 'env' | 'dev' | 'build';

export interface ChecklistStep {
  id: string;
  label: string;
  detail?: string;
  status: StepStatus;
  /** Set when the step has a "Run" button in the webview. */
  action?: StepAction;
  /** Shell command shown/run for the action (install/dev/build). */
  command?: string;
}

/** Build the initial checklist from the analysis. */
export function initialChecklist(a: RepoAnalysis): ChecklistStep[] {
  const steps: ChecklistStep[] = [
    {
      id: 'stack',
      label: `Detected stack: ${stackLabel(a)}`,
      detail: a.readmeSummary,
      status: 'done',
    },
  ];
  if (a.installCommand) {
    steps.push({
      id: 'install',
      label: 'Install dependencies',
      detail: a.installCommand,
      status: 'pending',
      action: 'install',
      command: a.installCommand,
    });
  }
  if (a.hasEnvExample) {
    steps.push({
      id: 'env',
      label: 'Create .env from .env.example',
      detail:
        a.envExampleVars.length > 0
          ? `Copies the template and leaves ${a.envExampleVars.length} variable(s) for you to fill in.`
          : 'Copies the template file.',
      status: 'pending',
      action: 'env',
    });
  }
  if (a.devCommand) {
    steps.push({
      id: 'dev',
      label: 'Run the dev server',
      detail: a.devCommand,
      status: 'pending',
      action: 'dev',
      command: a.devCommand,
    });
  }
  if (a.buildCommand) {
    steps.push({
      id: 'build',
      label: 'Run the build',
      detail: a.buildCommand,
      status: 'pending',
      action: 'build',
      command: a.buildCommand,
    });
  }
  return steps;
}

/** Immutable status update for one step (no-op for unknown ids). */
export function applyStepUpdate(
  steps: ChecklistStep[],
  id: string,
  patch: Partial<Pick<ChecklistStep, 'status' | 'detail'>>,
): ChecklistStep[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Final summary: what worked vs what needs manual attention. */
export function summarize(steps: ChecklistStep[]): { worked: string[]; needsAttention: string[] } {
  const worked: string[] = [];
  const needsAttention: string[] = [];
  for (const s of steps) {
    if (s.status === 'done') worked.push(s.label);
    else if (s.status === 'failed') needsAttention.push(`${s.label} — failed${s.detail ? `: ${s.detail}` : ''}`);
    else if (s.status === 'pending' || s.status === 'running')
      needsAttention.push(`${s.label} — not completed`);
  }
  return { worked, needsAttention };
}
