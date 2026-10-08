// Tests for `sunday.memory.applyFrom` (Group B5). `vscode` is mocked;
// the store and agent sender are fakes. Covers the picker flow, the
// delimited injection format, and the empty/give-up paths.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredCommands: Record<string, (...args: unknown[]) => unknown> = {};
const infoMessages: string[] = [];
const errorMessages: string[] = [];
const sentMessages: string[] = [];
let quickPickQueue: unknown[] = [];
let inputBoxResult: string | undefined = '';

vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(() => Promise.resolve(quickPickQueue.shift() ?? undefined)),
    showInputBox: vi.fn(() => Promise.resolve(inputBoxResult)),
    showInformationMessage: vi.fn((msg: string) => {
      infoMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showErrorMessage: vi.fn((msg: string) => {
      errorMessages.push(msg);
      return Promise.resolve(undefined);
    }),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands[id] = handler;
      return { dispose: vi.fn() };
    }),
  },
}));

import {
  formatImportedMemories,
  memoryPickDetail,
  memoryPickLabel,
  registerMemoryApplyFrom,
  type CrossProjectMemory,
  type CrossProjectStore,
  type MemoryApplyDeps,
} from './memoryApply.js';

function mem(overrides: Partial<CrossProjectMemory> = {}): CrossProjectMemory {
  return {
    id: 'm1',
    text: 'We decided to use pnpm for the monorepo.',
    timestamp: '2026-10-01T10:00:00.000Z',
    project: 'proj-other',
    tags: ['decision'],
    source: 'auto',
    ...overrides,
  };
}

function makeStore(mems: CrossProjectMemory[]): CrossProjectStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listProjects: async () => [...new Set(mems.map((m) => m.project))].sort(),
    queryByProject: async (projectId: string, query: string, limit = 10) => {
      calls.push(`${projectId}:${query}:${limit}`);
      return mems.filter((m) => m.project === projectId).slice(0, limit);
    },
  };
}

function makeDeps(store: CrossProjectStore, current = 'proj-current'): MemoryApplyDeps {
  return {
    store,
    currentProjectId: () => current,
    sendToAgent: async (message: string) => {
      sentMessages.push(message);
    },
    log: () => undefined,
  };
}

beforeEach(() => {
  for (const k of Object.keys(registeredCommands)) delete registeredCommands[k];
  infoMessages.length = 0;
  errorMessages.length = 0;
  sentMessages.length = 0;
  quickPickQueue = [];
  inputBoxResult = '';
});

describe('memoryPickLabel / memoryPickDetail / formatImportedMemories', () => {
  it('truncates long labels and shows tags + date in the detail', () => {
    const m = mem({ text: 'x'.repeat(200), tags: ['a', 'b'], timestamp: '2026-09-15T00:00:00Z' });
    expect(memoryPickLabel(m)).toBe(`${'x'.repeat(80)}…`);
    expect(memoryPickDetail(m)).toBe('a, b · 2026-09-15');
  });

  it('formats a clearly delimited import block', () => {
    const out = formatImportedMemories([mem(), mem({ id: 'm2', text: 'Second memory.' })], 'proj-other');
    expect(out).toContain('<imported-memories project="proj-other" count="2">');
    expect(out).toContain('</imported-memories>');
    expect(out).toContain('We decided to use pnpm');
    expect(out).toContain('Second memory.');
  });
});

describe('registerMemoryApplyFrom', () => {
  it('registers sunday.memory.applyFrom', () => {
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(makeStore([])));
    expect(registeredCommands['sunday.memory.applyFrom']).toBeDefined();
  });

  it('flows project → search → multi-select → delimited inject', async () => {
    const store = makeStore([mem(), mem({ id: 'm2', text: 'Other project note.' }), mem({ id: 'm3', project: 'proj-current', text: 'Own note.' })]);
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(store));
    // Project picker: choose proj-other. Search: empty (newest). Results: pick both.
    quickPickQueue = [
      { label: 'proj-other' },
      [
        { label: 'We decided to use pnpm for the monorepo.', mem: mem() },
        { label: 'Other project note.', mem: mem({ id: 'm2', text: 'Other project note.' }) },
      ],
    ];
    await registeredCommands['sunday.memory.applyFrom']!();
    // Current project excluded from the picker; only the other project offered.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain('<imported-memories project="proj-other" count="2">');
    expect(sentMessages[0]).toContain('</imported-memories>');
    expect(sentMessages[0]).not.toContain('Own note.');
    expect(infoMessages.some((m) => m.includes('applied 2 memories'))).toBe(true);
  });

  it('scopes the search to the picked project', async () => {
    const store = makeStore([mem()]);
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(store));
    quickPickQueue = [{ label: 'proj-other' }, []];
    inputBoxResult = 'pnpm';
    await registeredCommands['sunday.memory.applyFrom']!();
    expect(store.calls).toEqual(['proj-other:pnpm:10']);
  });

  it('informs when no other projects have memories', async () => {
    const store = makeStore([mem({ project: 'proj-current', text: 'Own note.' })]);
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(store));
    await registeredCommands['sunday.memory.applyFrom']!();
    expect(infoMessages.some((m) => m.includes('no memories from other projects'))).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  it('informs when the search matches nothing', async () => {
    const store = makeStore([]);
    // Force a project to exist but no results.
    store.queryByProject = async () => [];
    store.listProjects = async () => ['proj-other'];
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(store));
    quickPickQueue = [{ label: 'proj-other' }];
    await registeredCommands['sunday.memory.applyFrom']!();
    expect(infoMessages.some((m) => m.includes('no memories matched'))).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  it('sends nothing when the user cancels the project picker', async () => {
    const store = makeStore([mem()]);
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(store));
    quickPickQueue = [undefined]; // user cancels
    await registeredCommands['sunday.memory.applyFrom']!();
    expect(sentMessages).toHaveLength(0);
  });

  it('sends nothing when no memories are selected', async () => {
    const store = makeStore([mem()]);
    registerMemoryApplyFrom({ subscriptions: [] } as never, makeDeps(store));
    quickPickQueue = [{ label: 'proj-other' }, []];
    await registeredCommands['sunday.memory.applyFrom']!();
    expect(sentMessages).toHaveLength(0);
  });
});
