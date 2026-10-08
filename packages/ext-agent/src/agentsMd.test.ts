// Tests for the AGENTS.md watcher + reload command (Group B1).
// `vscode` is mocked; @sunday/context runs for real against temp dirs.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const commands: Record<string, (...args: unknown[]) => unknown> = {};
const watchers: Array<{ pattern: string }> = [];
const infoMessages: string[] = [];
const warnMessages: string[] = [];

vi.mock('vscode', () => ({
  workspace: {
    createFileSystemWatcher: vi.fn((pattern: string) => {
      const w = { pattern };
      watchers.push(w);
      return {
        onDidChange: vi.fn(),
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        dispose: vi.fn(),
      };
    }),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
      commands[id] = handler;
      return { dispose: vi.fn() };
    }),
  },
  window: {
    showInformationMessage: vi.fn((msg: string) => {
      infoMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showWarningMessage: vi.fn((msg: string) => {
      warnMessages.push(msg);
      return Promise.resolve(undefined);
    }),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { registerAgentsMd, summarizeAgentsMd } from './agentsMd.js';
import { loadAgentsMd } from '@sunday/context';

function makeContext(): { subscriptions: unknown[] } {
  return { subscriptions: [] as unknown[] };
}

beforeEach(() => {
  for (const k of Object.keys(commands)) delete commands[k];
  watchers.length = 0;
  infoMessages.length = 0;
  warnMessages.length = 0;
});

describe('summarizeAgentsMd', () => {
  it('reports "none found" when empty', () => {
    expect(summarizeAgentsMd(loadAgentsMd(mkdtempSync(join(tmpdir(), 'sunday-noagents-'))))).toContain(
      'No AGENTS.md found',
    );
  });

  it('lists sources when a file is found', () => {
    const root = mkdtempSync(join(tmpdir(), 'sunday-agents-'));
    writeFileSync(join(root, 'AGENTS.md'), 'Be terse.');
    const summary = summarizeAgentsMd(loadAgentsMd(root));
    expect(summary).toContain('Loaded AGENTS.md from:');
    expect(summary).toContain(join(root, 'AGENTS.md'));
  });
});

describe('registerAgentsMd', () => {
  it('creates a **/AGENTS.md watcher and registers sunday.agentsMd.reload', () => {
    const ctx = makeContext();
    registerAgentsMd(ctx as never, { getWorkspaceRoot: () => undefined, log: () => undefined });
    expect(watchers.some((w) => w.pattern === '**/AGENTS.md')).toBe(true);
    expect(commands['sunday.agentsMd.reload']).toBeDefined();
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it('reload warns when no workspace is open', async () => {
    registerAgentsMd(makeContext() as never, { getWorkspaceRoot: () => undefined, log: () => undefined });
    await commands['sunday.agentsMd.reload']!();
    expect(warnMessages.some((m) => m.includes('no workspace folder'))).toBe(true);
  });

  it('reload reports loaded sources for a workspace with AGENTS.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sunday-agents-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Prefer pnpm.');
    const logs: string[] = [];
    registerAgentsMd(makeContext() as never, {
      getWorkspaceRoot: () => root,
      log: (m) => logs.push(m),
    });
    await commands['sunday.agentsMd.reload']!();
    expect(infoMessages.some((m) => m.includes('Loaded AGENTS.md from:'))).toBe(true);
    expect(infoMessages.some((m) => m.includes(join(root, 'AGENTS.md')))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('reload reports gracefully when no AGENTS.md exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sunday-agents-'));
    registerAgentsMd(makeContext() as never, {
      getWorkspaceRoot: () => root,
      log: () => undefined,
    });
    await commands['sunday.agentsMd.reload']!();
    expect(infoMessages.some((m) => m.includes('No AGENTS.md found'))).toBe(true);
  });
});
