// sunday-agent — agent mode selection (Group B4).
//
// Modes: Auto / Architect / Implementer / Reviewer. The mode is persisted
// per workspace in `context.workspaceState` and stamped into the sidecar
// env as SUNDAY_AGENT_MODE at spawn (see extension.ts extraEnv); the daemon
// enforces it in the agent loop's tool-dispatch path. Changing the mode
// therefore applies after a sidecar restart — the command offers one.
//
// The canonical allowlists/denial messages live in @sunday/tools (modes.ts);
// this module is the VS Code shell around them.
import * as vscode from 'vscode';
import {
  AGENT_MODES,
  AGENT_MODE_ENV,
  agentModeLabel,
  parseAgentMode,
  type AgentMode,
} from '@sunday/tools';

/** Re-exported for extension.ts extraEnv stamping (single source: @sunday/tools). */
export { AGENT_MODES, AGENT_MODE_ENV, agentModeLabel, parseAgentMode };
export type { AgentMode };

/** workspaceState key for the per-workspace agent mode. */
export const MODE_STATE_KEY = 'sunday.agentMode';

/** Minimal structural shape of vscode.ExtensionContext['workspaceState']. */
export interface WorkspaceStateLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Read the persisted mode (default: auto). Invalid stored values fall back. */
export function getAgentMode(state: WorkspaceStateLike): AgentMode {
  return parseAgentMode(state.get<string>(MODE_STATE_KEY, 'auto'));
}

/** Persist the mode. */
export async function setAgentMode(state: WorkspaceStateLike, mode: AgentMode): Promise<void> {
  await state.update(MODE_STATE_KEY, parseAgentMode(mode));
}

/** Status-bar text for a mode. */
export function modeStatusText(mode: AgentMode): string {
  return `Sunday: ${agentModeLabel(mode)}`;
}

const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  auto: 'Default behavior — all tools available',
  architect: 'Planning only — read-only tools, no writes or execution',
  implementer: 'Full tool access — make changes directly',
  reviewer: 'Read + diff only — writes are disabled',
};

export interface AgentModesDeps {
  log(msg: string): void;
}

/**
 * Register the mode status-bar item and the `sunday.mode.set` command.
 * The item shows the current mode; clicking it (or the command) opens a
 * quickpick. Returns nothing — disposables go to context.subscriptions.
 */
export function registerAgentModes(
  context: vscode.ExtensionContext,
  deps: AgentModesDeps,
): void {
  const state = context.workspaceState as unknown as WorkspaceStateLike;

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'sunday.mode.set';
  item.tooltip = 'Sunday agent mode — click to change';
  const refresh = (): void => {
    item.text = modeStatusText(getAgentMode(state));
    item.show();
  };
  refresh();

  const setCommand = vscode.commands.registerCommand('sunday.mode.set', async () => {
    const pick = await vscode.window.showQuickPick(
      AGENT_MODES.map((mode) => ({
        label: agentModeLabel(mode),
        description: MODE_DESCRIPTIONS[mode],
        mode,
      })),
      { placeHolder: 'Select Sunday agent mode' },
    );
    if (!pick) return;
    await setAgentMode(state, pick.mode);
    refresh();
    deps.log(`agent mode set to ${pick.mode}`);
    const action = await vscode.window.showInformationMessage(
      `Sunday agent mode: ${agentModeLabel(pick.mode)}. Applies after the sidecar restarts.`,
      'Restart Sidecar',
      'Later',
    );
    if (action === 'Restart Sidecar') {
      await vscode.commands.executeCommand('sunday.sidecar.restart');
    }
  });

  context.subscriptions.push(item, setCommand);
}
