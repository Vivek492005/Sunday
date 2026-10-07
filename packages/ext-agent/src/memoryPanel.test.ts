// Tests for the memory panel: label/tooltip/tree-item mapping (pure
// helpers) plus the provider and registration wiring. `vscode` is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    public label: string;
    public collapsibleState: number;
    public tooltip?: string;
    public description?: string;
    public contextValue?: string;
    public id?: string;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    public event = () => undefined;
    public fire = vi.fn();
    public dispose = () => undefined;
  },
  window: {
    createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

import * as vscode from 'vscode';
import {
  MEMORY_VIEW_ID,
  MemoryTreeProvider,
  memoryLabel,
  memoryToTreeItem,
  memoryTooltip,
  registerMemoryPanel,
  type MemoryRecordLike,
  type MemoryStoreLike,
} from './memoryPanel.js';

function makeMem(overrides: Partial<MemoryRecordLike> = {}): MemoryRecordLike {
  return {
    id: 'id-1',
    text: 'We decided to vendor the VS Code tree.',
    timestamp: '2026-10-07T10:00:00.000Z',
    project: 'sunday',
    tags: ['decision'],
    source: 'auto',
    ...overrides,
  };
}

function makeStore(mems: MemoryRecordLike[]): MemoryStoreLike {
  return {
    list: vi.fn(async (_opts?: { limit?: number }) => [...mems]),
    delete: vi.fn(async (_id: string) => true),
  };
}

describe('memoryLabel', () => {
  it('returns the text as-is under 60 chars', () => {
    expect(memoryLabel(makeMem())).toBe('We decided to vendor the VS Code tree.');
  });

  it('truncates long text at 60 chars with an ellipsis', () => {
    const mem = makeMem({ text: 'x'.repeat(100) });
    expect(memoryLabel(mem)).toBe(`${'x'.repeat(60)}…`);
  });

  it('collapses whitespace', () => {
    const mem = makeMem({ text: 'line one\n  line two' });
    expect(memoryLabel(mem)).toBe('line one line two');
  });
});

describe('memoryTooltip', () => {
  it('contains full text, project, date, and tags', () => {
    const tip = memoryTooltip(makeMem());
    expect(tip).toContain('We decided to vendor the VS Code tree.');
    expect(tip).toContain('sunday');
    expect(tip).toContain('2026-10-07');
    expect(tip).toContain('decision');
  });

  it('falls back to "note" for untagged memories', () => {
    expect(memoryTooltip(makeMem({ tags: [] }))).toContain('note');
  });
});

describe('memoryToTreeItem', () => {
  it('maps a memory to a tree item with label, tooltip, and description', () => {
    const item = memoryToTreeItem(makeMem());
    expect(item.label).toBe('We decided to vendor the VS Code tree.');
    expect(item.tooltip).toContain('Project: sunday');
    expect(item.description).toBe('sunday');
    expect(item.contextValue).toBe('sundayMemory');
    expect(item.id).toBe('id-1');
  });
});

describe('MemoryTreeProvider', () => {
  it('returns one tree item per memory, newest first as stored', async () => {
    const provider = new MemoryTreeProvider(makeStore([makeMem(), makeMem({ id: 'id-2', text: 'second' })]));
    const children = await provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0]?.label).toBe('We decided to vendor the VS Code tree.');
    expect(children[1]?.label).toBe('second');
  });

  it('returns an empty array when the store is empty', async () => {
    const provider = new MemoryTreeProvider(makeStore([]));
    expect(await provider.getChildren()).toHaveLength(0);
  });

  it('getTreeItem is the identity', async () => {
    const provider = new MemoryTreeProvider(makeStore([]));
    const item = memoryToTreeItem(makeMem());
    expect(provider.getTreeItem(item)).toBe(item);
  });
});

describe('registerMemoryPanel', () => {
  let context: { subscriptions: unknown[] };

  beforeEach(() => {
    context = { subscriptions: [] };
    vi.clearAllMocks();
  });

  it('creates the sunday.memoryView tree view and returns a disposable', () => {
    const store = makeStore([]);
    const disposable = registerMemoryPanel(
      context as unknown as vscode.ExtensionContext,
      store,
    );
    expect(vscode.window.createTreeView).toHaveBeenCalledWith(
      MEMORY_VIEW_ID,
      expect.objectContaining({ treeDataProvider: expect.anything() }),
    );
    expect(context.subscriptions).toHaveLength(1);
    expect(typeof (disposable as { dispose: unknown }).dispose).toBe('function');
  });
});
