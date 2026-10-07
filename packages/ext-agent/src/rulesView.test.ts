// Tests for the learned-rules sidebar (rulesView.ts).
//
// The markdown helpers and ruleDetailLine are pure and run without vscode.
// Registration (tree view + refresh/delete commands) runs against a minimal
// mocked `vscode` module via vi.hoisted, following the managerView.test.ts
// pattern. File IO is covered through a fake in-memory RuleStore; the real
// FileRuleStore shares the tested parse/format helpers.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const showWarningMessage = vi.fn();
  const showInformationMessage = vi.fn();
  const showQuickPick = vi.fn();
  const createTreeView = vi.fn();

  class TreeItem {
    label: unknown;
    collapsibleState?: number;
    id?: string;
    tooltip?: unknown;
    description?: unknown;
    contextValue?: string;
    constructor(label: unknown, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(e: T): void {
      for (const l of this.listeners) l(e);
    }
  }

  const Disposable = {
    from: (...disposables: Array<{ dispose: () => void }>) => ({
      dispose: () => {
        for (const d of disposables) d.dispose();
      },
    }),
  };

  return {
    commands,
    showWarningMessage,
    showInformationMessage,
    showQuickPick,
    createTreeView,
    TreeItem,
    TreeItemCollapsibleState,
    EventEmitter,
    Disposable,
  };
});

vi.mock('vscode', () => ({
  TreeItem: mocks.TreeItem,
  TreeItemCollapsibleState: mocks.TreeItemCollapsibleState,
  EventEmitter: mocks.EventEmitter,
  Disposable: mocks.Disposable,
  window: {
    createTreeView: mocks.createTreeView,
    showWarningMessage: mocks.showWarningMessage,
    showInformationMessage: mocks.showInformationMessage,
    showQuickPick: mocks.showQuickPick,
  },
  commands: {
    registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
      mocks.commands.set(id, fn);
      return { dispose: () => mocks.commands.delete(id) };
    },
  },
}));

import {
  RULES_DELETE_COMMAND,
  RULES_REFRESH_COMMAND,
  RULES_VIEW_TYPE,
  RuleTreeItem,
  RulesTreeDataProvider,
  formatRulesMarkdown,
  parseRulesMarkdown,
  registerRulesView,
  ruleDetailLine,
  type LearnedRule,
  type RuleStore,
} from './rulesView.js';
import type * as vscode from 'vscode';

function makeRule(over: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id: 'rule-1',
    rule: 'Always use pnpm instead of npm.',
    createdAt: '2026-10-07T10:00:00.000Z',
    source: 'correction',
    project: '',
    ...over,
  };
}

/** In-memory RuleStore for registration tests. */
function makeStore(initial: LearnedRule[] = []): RuleStore & { rules: LearnedRule[] } {
  const rules = [...initial];
  return {
    rules,
    path: '/tmp/fake-rules.md',
    add: async (rule: string, project = '') => {
      const r = makeRule({ id: `id-${rules.length}`, rule, project });
      rules.push(r);
      return r;
    },
    list: async () => [...rules],
    remove: async (id: string) => {
      const i = rules.findIndex((r) => r.id === id);
      if (i === -1) return false;
      rules.splice(i, 1);
      return true;
    },
  };
}

function makeContext(): { subscriptions: Array<{ dispose: () => void }> } & {
  asExtensionContext: vscode.ExtensionContext;
} {
  const subscriptions: Array<{ dispose: () => void }> = [];
  return {
    subscriptions,
    asExtensionContext: { subscriptions } as unknown as vscode.ExtensionContext,
  };
}

beforeEach(() => {
  mocks.commands.clear();
  mocks.createTreeView.mockReset();
  mocks.createTreeView.mockReturnValue({ dispose: () => undefined });
  mocks.showWarningMessage.mockReset();
  mocks.showInformationMessage.mockReset();
  mocks.showQuickPick.mockReset();
});

describe('parseRulesMarkdown', () => {
  it('parses rule lines with metadata', () => {
    const text =
      '- [abc] Always use pnpm instead of npm. <!-- createdAt=2026-10-07T10:00:00.000Z source=correction project=myapp -->\n' +
      '- [def] Never run tests in parallel. <!-- createdAt=2026-10-07T11:00:00.000Z source=correction project= -->\n';
    const rules = parseRulesMarkdown(text);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      id: 'abc',
      rule: 'Always use pnpm instead of npm.',
      createdAt: '2026-10-07T10:00:00.000Z',
      source: 'correction',
      project: 'myapp',
    });
    expect(rules[1]!.project).toBe('');
  });

  it('parses lines without a metadata suffix', () => {
    const rules = parseRulesMarkdown('- [x] Hand-written rule.\n');
    expect(rules).toEqual([
      { id: 'x', rule: 'Hand-written rule.', createdAt: '', source: 'correction', project: '' },
    ]);
  });

  it('skips blank and malformed lines', () => {
    const rules = parseRulesMarkdown('\n# a comment\n- not a rule line\n- [] empty id\n');
    expect(rules).toEqual([]);
  });
});

describe('formatRulesMarkdown', () => {
  it('serialises one line per rule with metadata', () => {
    const out = formatRulesMarkdown([makeRule()]);
    expect(out).toBe(
      '- [rule-1] Always use pnpm instead of npm. <!-- createdAt=2026-10-07T10:00:00.000Z source=correction project= -->\n',
    );
  });

  it('roundtrips through the parser', () => {
    const rules = [
      makeRule(),
      makeRule({ id: 'rule-2', rule: 'Never run tests in parallel.', project: 'myapp' }),
    ];
    expect(parseRulesMarkdown(formatRulesMarkdown(rules))).toEqual(rules);
  });

  it('flattens multi-line rule text to a single line', () => {
    const out = formatRulesMarkdown([makeRule({ rule: 'line one\nline two' })]);
    expect(out.split('\n').filter(Boolean)).toHaveLength(1);
    expect(out).toContain('line one line two');
  });
});

describe('ruleDetailLine', () => {
  it('mentions the learned date and correction source', () => {
    expect(ruleDetailLine(makeRule())).toBe('learned 2026-10-07 · from correction');
  });

  it('appends the project when set', () => {
    expect(ruleDetailLine(makeRule({ project: 'myapp' }))).toBe(
      'learned 2026-10-07 · from correction · myapp',
    );
  });
});

describe('registerRulesView', () => {
  it('creates the tree view and registers refresh + delete commands', () => {
    const ctx = makeContext();
    const store = makeStore();
    const disposable = registerRulesView(ctx.asExtensionContext, store);

    expect(mocks.createTreeView).toHaveBeenCalledTimes(1);
    expect(mocks.createTreeView.mock.calls[0]![0]).toBe(RULES_VIEW_TYPE);
    expect(mocks.commands.has(RULES_REFRESH_COMMAND)).toBe(true);
    expect(mocks.commands.has(RULES_DELETE_COMMAND)).toBe(true);
    expect(ctx.subscriptions).toHaveLength(1);
    expect(typeof disposable.dispose).toBe('function');
  });

  it('lists stored rules as tree items', async () => {
    const ctx = makeContext();
    const store = makeStore([makeRule(), makeRule({ id: 'rule-2' })]);
    registerRulesView(ctx.asExtensionContext, store);

    const provider = new RulesTreeDataProvider(store);
    const children = await provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(RuleTreeItem);
    expect(children[0]!.learnedRule.id).toBe('rule-1');
    expect(children[0]!.contextValue).toBe('sundayRule');
  });

  it('delete command removes the selected rule after confirmation', async () => {
    const ctx = makeContext();
    const store = makeStore([makeRule()]);
    registerRulesView(ctx.asExtensionContext, store);

    mocks.showWarningMessage.mockResolvedValue('Delete');
    const item = new RuleTreeItem(makeRule());
    await mocks.commands.get(RULES_DELETE_COMMAND)!(item);

    expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(store.rules).toHaveLength(0);
  });

  it('delete command keeps the rule when confirmation is dismissed', async () => {
    const ctx = makeContext();
    const store = makeStore([makeRule()]);
    registerRulesView(ctx.asExtensionContext, store);

    mocks.showWarningMessage.mockResolvedValue(undefined);
    await mocks.commands.get(RULES_DELETE_COMMAND)!(new RuleTreeItem(makeRule()));

    expect(store.rules).toHaveLength(1);
  });

  it('delete command without a tree item offers a quick pick', async () => {
    const ctx = makeContext();
    const store = makeStore([makeRule({ id: 'rule-9' })]);
    registerRulesView(ctx.asExtensionContext, store);

    mocks.showQuickPick.mockResolvedValue({
      label: 'Always use pnpm instead of npm.',
      id: 'rule-9',
    });
    mocks.showWarningMessage.mockResolvedValue('Delete');
    await mocks.commands.get(RULES_DELETE_COMMAND)!(undefined);

    expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
    expect(store.rules).toHaveLength(0);
  });

  it('delete command with an empty store informs the user', async () => {
    const ctx = makeContext();
    registerRulesView(ctx.asExtensionContext, makeStore());
    await mocks.commands.get(RULES_DELETE_COMMAND)!(undefined);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
  });

  it('refresh command fires the tree data change event', async () => {
    const ctx = makeContext();
    const store = makeStore([makeRule()]);
    registerRulesView(ctx.asExtensionContext, store);

    const provider = new RulesTreeDataProvider(store);
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired++;
    });
    await provider.refresh();
    expect(fired).toBe(1);
  });
});
