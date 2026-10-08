// Tests for agent mode selection/persistence (Group B4). `vscode` is
// mocked; the allowlist semantics are tested in @sunday/tools.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredCommands: Record<string, (...args: unknown[]) => unknown> = {};
const infoMessages: string[] = [];
const executedCommands: string[] = [];
const statusBarItems: Array<{ text: string; command?: string; show: () => void }> = [];
let quickPickResult: { label: string; mode: string } | undefined;

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: vi.fn(() => {
      const item = { text: '', command: undefined as string | undefined, show: vi.fn(), dispose: vi.fn() };
      statusBarItems.push(item);
      return item;
    }),
    showQuickPick: vi.fn(() => Promise.resolve(quickPickResult)),
    showInformationMessage: vi.fn((msg: string) => {
      infoMessages.push(msg);
      return Promise.resolve(undefined);
    }),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands[id] = handler;
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn((id: string) => {
      executedCommands.push(id);
      return Promise.resolve(undefined);
    }),
  },
}));

import {
  MODE_STATE_KEY,
  getAgentMode,
  modeStatusText,
  registerAgentModes,
  setAgentMode,
} from './modes.js';
import type { WorkspaceStateLike } from './modes.js';

function makeState(initial?: Record<string, unknown>): WorkspaceStateLike {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: <T>(key: string, defaultValue: T): T =>
      (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function makeContext(state: WorkspaceStateLike): { workspaceState: unknown; subscriptions: unknown[] } {
  return { workspaceState: state, subscriptions: [] as unknown[] };
}

beforeEach(() => {
  for (const k of Object.keys(registeredCommands)) delete registeredCommands[k];
  infoMessages.length = 0;
  executedCommands.length = 0;
  statusBarItems.length = 0;
  quickPickResult = undefined;
});

describe('getAgentMode / setAgentMode', () => {
  it('defaults to auto', () => {
    expect(getAgentMode(makeState())).toBe('auto');
  });

  it('persists the mode under the state key', async () => {
    const state = makeState();
    await setAgentMode(state, 'reviewer');
    expect(getAgentMode(state)).toBe('reviewer');
    expect(state.get(MODE_STATE_KEY, 'auto')).toBe('reviewer');
  });

  it('falls back to auto for invalid stored values', () => {
    expect(getAgentMode(makeState({ [MODE_STATE_KEY]: 'superuser' }))).toBe('auto');
  });

  it('round-trips every mode', async () => {
    const state = makeState();
    for (const mode of ['auto', 'architect', 'implementer', 'reviewer'] as const) {
      await setAgentMode(state, mode);
      expect(getAgentMode(state)).toBe(mode);
    }
  });
});

describe('modeStatusText', () => {
  it('labels each mode', () => {
    expect(modeStatusText('auto')).toBe('Sunday: Auto');
    expect(modeStatusText('architect')).toBe('Sunday: Architect');
    expect(modeStatusText('reviewer')).toBe('Sunday: Reviewer');
  });
});

describe('registerAgentModes', () => {
  it('creates a status bar item showing the current mode', () => {
    const ctx = makeContext(makeState({ [MODE_STATE_KEY]: 'architect' }));
    registerAgentModes(ctx as never, { log: () => undefined });
    expect(statusBarItems).toHaveLength(1);
    expect(statusBarItems[0]!.text).toBe('Sunday: Architect');
    expect(statusBarItems[0]!.command).toBe('sunday.mode.set');
    expect(registeredCommands['sunday.mode.set']).toBeDefined();
  });

  it('sunday.mode.set persists the picked mode and refreshes the item', async () => {
    const state = makeState();
    const ctx = makeContext(state);
    const logs: string[] = [];
    registerAgentModes(ctx as never, { log: (m) => logs.push(m) });
    quickPickResult = { label: 'Reviewer', mode: 'reviewer' };
    await registeredCommands['sunday.mode.set']!();
    expect(getAgentMode(state)).toBe('reviewer');
    expect(statusBarItems[0]!.text).toBe('Sunday: Reviewer');
    expect(infoMessages.some((m) => m.includes('Reviewer'))).toBe(true);
    expect(logs.some((m) => m.includes('reviewer'))).toBe(true);
  });

  it('cancelling the quickpick changes nothing', async () => {
    const state = makeState();
    registerAgentModes(makeContext(state) as never, { log: () => undefined });
    quickPickResult = undefined;
    await registeredCommands['sunday.mode.set']!();
    expect(getAgentMode(state)).toBe('auto');
    expect(infoMessages).toHaveLength(0);
  });
});
