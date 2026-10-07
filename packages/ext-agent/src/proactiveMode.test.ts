// Tests for proactive mode: pure helpers plus registration behavior with a
// mocked `vscode` (same vi.mock pattern as chatView.test.ts / codeActions.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SaveDoc = { fileName: string; uri: { scheme: string } };

const mocks = vi.hoisted(() => ({
  getConfiguration: vi.fn(),
  onDidSaveTextDocument: vi.fn(
    (_fn: (doc: SaveDoc) => void): { dispose: () => void } => ({ dispose: () => undefined }),
  ),
  onDidChangeTextDocument: vi.fn(() => ({ dispose: () => undefined })),
  createStatusBarItem: vi.fn(() => ({
    dispose: () => undefined,
    show: vi.fn(),
    hide: vi.fn(),
    text: '',
    tooltip: '',
  })),
  getDiagnostics: vi.fn(() => [] as { severity?: number }[]),
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  Disposable: { from: (...ds: { dispose(): void }[]) => ({ dispose: () => ds.forEach((d) => d.dispose()) }) },
  workspace: {
    getConfiguration: mocks.getConfiguration,
    onDidSaveTextDocument: mocks.onDidSaveTextDocument,
    onDidChangeTextDocument: mocks.onDidChangeTextDocument,
  },
  window: { createStatusBarItem: mocks.createStatusBarItem },
  languages: { getDiagnostics: mocks.getDiagnostics },
}));

import {
  checkingText,
  isProactiveEnabled,
  readProactiveEnabled,
  registerProactiveMode,
  resultText,
  shouldCheckOnSave,
  summarizeDiagnostics,
} from './proactiveMode.js';

const context = { subscriptions: [] as { dispose(): void }[] } as never;

function setConfig(value: unknown) {
  mocks.getConfiguration.mockReturnValue({ get: (_key: string) => value });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isProactiveEnabled', () => {
  it('true only for literal true', () => {
    expect(isProactiveEnabled(true)).toBe(true);
    expect(isProactiveEnabled(false)).toBe(false);
    expect(isProactiveEnabled(undefined)).toBe(false);
    expect(isProactiveEnabled('true')).toBe(false);
    expect(isProactiveEnabled(1)).toBe(false);
  });
});

describe('readProactiveEnabled', () => {
  it('reads sunday config defensively, defaults to false', () => {
    setConfig(undefined);
    expect(readProactiveEnabled()).toBe(false);
    expect(mocks.getConfiguration).toHaveBeenCalledWith('sunday');

    setConfig(true);
    expect(readProactiveEnabled()).toBe(true);
  });
});

describe('shouldCheckOnSave', () => {
  it('watches .ts/.tsx/.js on file scheme', () => {
    expect(shouldCheckOnSave('/a/b.ts', 'file')).toBe(true);
    expect(shouldCheckOnSave('/a/b.tsx', 'file')).toBe(true);
    expect(shouldCheckOnSave('/a/b.js', 'file')).toBe(true);
    expect(shouldCheckOnSave('/a/B.TS', 'file')).toBe(true);
  });

  it('ignores other extensions and non-file schemes', () => {
    expect(shouldCheckOnSave('/a/b.css', 'file')).toBe(false);
    expect(shouldCheckOnSave('/a/b.jsx', 'file')).toBe(false);
    expect(shouldCheckOnSave('/a/Makefile', 'file')).toBe(false);
    expect(shouldCheckOnSave('/a/b.ts', 'untitled')).toBe(false);
    expect(shouldCheckOnSave('/a/b.ts', 'vscode-remote')).toBe(false);
  });
});

describe('summarizeDiagnostics', () => {
  it('counts errors and warnings, ignores other severities', () => {
    expect(
      summarizeDiagnostics([{ severity: 0 }, { severity: 0 }, { severity: 1 }, { severity: 2 }, {}]),
    ).toEqual({ errors: 2, warnings: 1 });
    expect(summarizeDiagnostics([])).toEqual({ errors: 0, warnings: 0 });
  });
});

describe('status bar text', () => {
  it('checkingText uses the basename', () => {
    expect(checkingText('/x/y/z.ts')).toBe('$(sparkle) Proactive: checking z.ts');
  });

  it('resultText reports clean vs counts', () => {
    expect(resultText('/x/a.ts', 0, 0)).toBe('$(check) Proactive: a.ts clean');
    expect(resultText('/x/a.ts', 1, 2)).toBe('$(sparkle) Proactive: a.ts — 1 error, 2 warnings');
    expect(resultText('/x/a.ts', 0, 1)).toBe('$(sparkle) Proactive: a.ts — 1 warning');
  });
});

describe('registerProactiveMode', () => {
  it('returns a no-op disposable when disabled', () => {
    setConfig(false);
    const d = registerProactiveMode(context);
    d.dispose();
    expect(mocks.onDidSaveTextDocument).not.toHaveBeenCalled();
    expect(mocks.createStatusBarItem).not.toHaveBeenCalled();
  });

  it('registers listeners and a status bar item when enabled', () => {
    setConfig(true);
    const d = registerProactiveMode(context);
    expect(mocks.onDidSaveTextDocument).toHaveBeenCalledTimes(1);
    expect(mocks.onDidChangeTextDocument).toHaveBeenCalledTimes(1);
    expect(mocks.createStatusBarItem).toHaveBeenCalled();
    d.dispose();
  });

  it('on save of a watched file: shows "checking", then result after debounce', () => {
    vi.useFakeTimers();
    try {
      setConfig(true);
      const item = {
        dispose: () => undefined,
        show: vi.fn(),
        hide: vi.fn(),
        text: '',
        tooltip: '',
      };
      mocks.createStatusBarItem.mockReturnValue(item);
      registerProactiveMode(context);

      const saveHandler = mocks.onDidSaveTextDocument.mock.calls[0]![0];
      mocks.getDiagnostics.mockReturnValue([{ severity: 0 }, { severity: 1 }]);
      saveHandler({ fileName: '/x/a.ts', uri: { scheme: 'file' } });
      expect(item.text).toBe('$(sparkle) Proactive: checking a.ts');

      vi.advanceTimersByTime(1000);
      expect(item.text).toBe('$(sparkle) Proactive: a.ts — 1 error, 1 warning');
      expect(item.tooltip).toContain('no changes made');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores saves of unwatched files', () => {
    setConfig(true);
    const item = { dispose: () => undefined, show: vi.fn(), hide: vi.fn(), text: '', tooltip: '' };
    mocks.createStatusBarItem.mockReturnValue(item);
    registerProactiveMode(context);

    const saveHandler = mocks.onDidSaveTextDocument.mock.calls[0]![0];
    saveHandler({ fileName: '/x/style.css', uri: { scheme: 'file' } });
    expect(item.text).toBe('');
  });
});
