// Tests for `sunday.onboardRepo` command wiring: registration, .env copy
// logic (incl. existing-.env overwrite prompt), approval-gated shell runs,
// and live checklist updates. `vscode` is mocked; fs/shell are injected.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _fn: (...a: unknown[]) => unknown) => ({ dispose: () => undefined })),
  showWarningMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
  createWebviewPanel: vi.fn((..._args: unknown[]) => undefined as never),
  createTerminal: vi.fn((_name: string) => ({ show: vi.fn(), sendText: vi.fn() })),
}));

let messageHandler: ((msg: { type?: string; stepId?: string }) => Promise<void>) | undefined;
let postedStates: unknown[][] = [];
let disposedCallback: (() => void) | undefined;

vi.mock('vscode', () => ({
  commands: { registerCommand: mocks.registerCommand },
  window: {
    showWarningMessage: mocks.showWarningMessage,
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
    createWebviewPanel: mocks.createWebviewPanel,
    createTerminal: mocks.createTerminal,
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/ws' } }] },
  ViewColumn: { One: 1 },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
}));

import { registerOnboardRepo, type OnboardRepoDeps } from './index.js';

const NODE_FILES: Record<string, string | null> = {
  'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'tsc' } }),
  'package-lock.json': null,
  'pnpm-lock.yaml': 'lockfileVersion: 9',
  'yarn.lock': null,
  'pyproject.toml': null,
  'requirements.txt': null,
  'poetry.lock': null,
  'uv.lock': null,
  Pipfile: null,
  'go.mod': null,
  'Cargo.toml': null,
  Dockerfile: null,
  'README.md': null,
  '.env.example': 'PORT=3000\n',
};

function setupPanel() {
  messageHandler = undefined;
  postedStates = [];
  disposedCallback = undefined;
  mocks.createWebviewPanel.mockImplementation(() => {
    const panel = {
      webview: {
        html: '',
        postMessage: vi.fn(async (...args: unknown[]) => {
          postedStates.push(args);
        }),
        onDidReceiveMessage: vi.fn((h: typeof messageHandler) => {
          messageHandler = h;
          return { dispose: () => undefined };
        }),
      },
      onDidDispose: vi.fn((h: () => void) => {
        disposedCallback = h;
        return { dispose: () => undefined };
      }),
      dispose: vi.fn(),
    };
    return panel as never;
  });
}

function makeDeps(overrides: Partial<OnboardRepoDeps> = {}): OnboardRepoDeps & {
  written: Record<string, string>;
  runShell: ReturnType<typeof vi.fn>;
} {
  const written: Record<string, string> = {};
  const store: Record<string, string | null> = { ...NODE_FILES };
  const runShell = vi.fn(async () => ({ exitCode: 0, output: 'ok' }));
  const deps: OnboardRepoDeps = {
    log: vi.fn(),
    readWorkspaceFile: async (p: string) => store[p.replace('/ws/', '')] ?? null,
    writeWorkspaceFile: async (p: string, c: string) => {
      written[p] = c;
      store[p.replace('/ws/', '')] = c;
    },
    runShell,
    ...overrides,
  };
  return { ...deps, written, runShell };
}

async function invoke() {
  const [, handler] = mocks.registerCommand.mock.calls[0] as [string, () => Promise<void>];
  await handler();
  if (!messageHandler) throw new Error('message handler not captured');
}

beforeEach(() => {
  vi.clearAllMocks();
  setupPanel();
});

describe('sunday.onboardRepo', () => {
  it('registers the command and opens a webview with the checklist', async () => {
    const deps = makeDeps();
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    expect(mocks.registerCommand).toHaveBeenCalledWith('sunday.onboardRepo', expect.any(Function));
    await invoke();
    expect(mocks.createWebviewPanel).toHaveBeenCalled();
    const panel = mocks.createWebviewPanel.mock.results[0].value as { webview: { html: string } };
    expect(panel.webview.html).toContain('Detected stack: Node.js (pnpm)');
    expect(panel.webview.html).toContain('Install dependencies');
  });

  it('copies .env.example to .env and marks the step done', async () => {
    const deps = makeDeps();
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'copyEnv' });
    expect(deps.written['/ws/.env']).toBe('PORT=3000\n');
    const last = postedStates[postedStates.length - 1][0] as { steps: Array<{ id: string; status: string }> };
    expect(last.steps.find((s) => s.id === 'env')?.status).toBe('done');
  });

  it('asks before overwriting an existing .env', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce('Keep existing' as never);
    const deps = makeDeps({
      readWorkspaceFile: async (p: string) =>
        p.endsWith('.env') ? 'PORT=9999\n' : (NODE_FILES[p.replace('/ws/', '')] ?? null),
    });
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'copyEnv' });
    expect(deps.written['/ws/.env']).toBeUndefined();
    const last = postedStates[postedStates.length - 1][0] as { steps: Array<{ id: string; status: string }> };
    expect(last.steps.find((s) => s.id === 'env')?.status).toBe('skipped');
  });

  it('runs install behind an approval modal and marks done on success', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce('Run' as never);
    const deps = makeDeps();
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'run', stepId: 'install' });
    expect(mocks.showWarningMessage).toHaveBeenCalled();
    expect(String(mocks.showWarningMessage.mock.calls[0][0])).toContain('pnpm install');
    expect(deps.runShell).toHaveBeenCalledWith('pnpm install', '/ws');
    const last = postedStates[postedStates.length - 1][0] as { steps: Array<{ id: string; status: string }> };
    expect(last.steps.find((s) => s.id === 'install')?.status).toBe('done');
  });

  it('marks the step failed when the command fails', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce('Run' as never);
    const deps = makeDeps();
    deps.runShell.mockResolvedValueOnce({ exitCode: 1, output: 'boom' });
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'run', stepId: 'build' });
    const last = postedStates[postedStates.length - 1][0] as { steps: Array<{ id: string; status: string }> };
    const build = last.steps.find((s) => s.id === 'build');
    expect(build?.status).toBe('failed');
  });

  it('does nothing when the user cancels the approval modal', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce('Cancel' as never);
    const deps = makeDeps();
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'run', stepId: 'install' });
    expect(deps.runShell).not.toHaveBeenCalled();
  });

  it('launches the dev server in a terminal (approval-gated)', async () => {
    mocks.showWarningMessage.mockResolvedValueOnce('Run' as never);
    const deps = makeDeps();
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'run', stepId: 'dev' });
    expect(mocks.createTerminal).toHaveBeenCalledWith('Sunday: dev');
    expect(deps.runShell).not.toHaveBeenCalled(); // not exec'd — long-running
  });

  it('shows a summary when the panel is disposed', async () => {
    mocks.showWarningMessage.mockResolvedValue('Run' as never);
    const deps = makeDeps();
    registerOnboardRepo({ subscriptions: [] } as never, deps);
    await invoke();
    await messageHandler!({ type: 'run', stepId: 'install' });
    disposedCallback!();
    expect(mocks.showWarningMessage).toHaveBeenCalled(); // summary with pending items
    const lastCall = mocks.showWarningMessage.mock.calls[mocks.showWarningMessage.mock.calls.length - 1][0];
    expect(String(lastCall)).toMatch(/needing attention/);
  });
});
