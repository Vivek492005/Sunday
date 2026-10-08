// Tests for the `sunday.style.infer` command (Group B2).
// `vscode` is mocked; style inference runs for real against temp dirs with
// a temp SUNDAY_HOME so the real home is untouched.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const commands: Record<string, (...args: unknown[]) => unknown> = {};
const infoMessages: string[] = [];
const warnMessages: string[] = [];

vi.mock('vscode', () => ({
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
}));

import { loadStoredStyle } from '@sunday/context';
import { registerStyleInfer } from './styleInfer.js';

const TS = `import { x } from './x';\n\nexport function doThing(inputName: string): string {\n  const resultValue = 'ok';\n  return resultValue + inputName;\n}\n`;

beforeEach(() => {
  for (const k of Object.keys(commands)) delete commands[k];
  infoMessages.length = 0;
  warnMessages.length = 0;
  process.env.SUNDAY_HOME = mkdtempSync(join(tmpdir(), 'sunday-style-home-'));
});

describe('registerStyleInfer', () => {
  it('registers sunday.style.infer', () => {
    registerStyleInfer({ subscriptions: [] } as never, {
      getWorkspaceRoot: () => undefined,
      log: () => undefined,
    });
    expect(commands['sunday.style.infer']).toBeDefined();
  });

  it('warns when no workspace is open', async () => {
    registerStyleInfer({ subscriptions: [] } as never, {
      getWorkspaceRoot: () => undefined,
      log: () => undefined,
    });
    await commands['sunday.style.infer']!();
    expect(warnMessages.some((m) => m.includes('no workspace folder'))).toBe(true);
  });

  it('infers, stores, and reports the style summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sunday-style-ws-'));
    writeFileSync(join(root, 'a.ts'), TS);
    const logs: string[] = [];
    registerStyleInfer({ subscriptions: [] } as never, {
      getWorkspaceRoot: () => root,
      log: (m) => logs.push(m),
    });
    await commands['sunday.style.infer']!();
    const stored = loadStoredStyle(root);
    expect(stored).not.toBeNull();
    expect(stored?.indent.kind).toBe('spaces');
    expect(stored?.indent.size).toBe(2);
    expect(infoMessages.some((m) => m.includes('code style updated'))).toBe(true);
    expect(infoMessages.some((m) => m.includes('2-space indent'))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('handles an empty repo gracefully', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sunday-style-empty-'));
    registerStyleInfer({ subscriptions: [] } as never, {
      getWorkspaceRoot: () => root,
      log: () => undefined,
    });
    await commands['sunday.style.infer']!();
    expect(loadStoredStyle(root)).not.toBeNull();
    expect(infoMessages.some((m) => m.includes('No strong code-style signal'))).toBe(true);
  });
});
