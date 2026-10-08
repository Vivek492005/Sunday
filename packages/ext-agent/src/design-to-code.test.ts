// Tests for `sunday.designToCode`: framework detection matrix, prompt
// construction, code extraction, vision-error classification, and the
// graceful vision-unavailable path (mocked bridge). `vscode` is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, _fn: (...a: unknown[]) => unknown) => ({ dispose: () => undefined })),
  showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
  showOpenDialog: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  showInputBox: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  openTextDocument: vi.fn(async (..._args: unknown[]) => ({ uri: { fsPath: '/preview' } })),
  showTextDocument: vi.fn(async (..._args: unknown[]) => undefined),
  writeText: vi.fn(async (..._args: unknown[]) => undefined),
  writeFile: vi.fn(async (..._args: unknown[]) => undefined),
  readFile: vi.fn(async (..._args: unknown[]) => new Uint8Array([1, 2, 3])),
  getConfiguration: vi.fn((_section: string) => ({ get: (_k: string, d: unknown) => d })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand: mocks.registerCommand },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
    showOpenDialog: mocks.showOpenDialog,
    showInputBox: mocks.showInputBox,
    showTextDocument: mocks.showTextDocument,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/ws' } }],
    getConfiguration: mocks.getConfiguration,
    openTextDocument: mocks.openTextDocument,
    fs: { readFile: mocks.readFile, writeFile: mocks.writeFile },
  },
  env: { clipboard: { writeText: mocks.writeText } },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
      scheme: 'file',
    }),
  },
}));

import {
  buildDesignToCodePrompt,
  detectFramework,
  editorLanguageFor,
  extractGeneratedCode,
  frameworkLabel,
  imageToDataUrl,
  looksLikeVisionError,
  mimeForExtension,
  registerDesignToCode,
} from './design-to-code.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfiguration.mockImplementation((_s: string) => ({ get: (_k: string, d: unknown) => d }));
});

function makeBridge(reply: { ok: boolean; text?: string; error?: string }) {
  const listeners = new Set<(n: unknown) => void>();
  return {
    listeners,
    sessionCreate: vi.fn(async () => ({ session: { id: 'sess-1' } })),
    chatSend: vi.fn(async (params: { message: unknown }) => {
      setTimeout(() => {
        for (const l of [...listeners])
          l({
            turnId: 'turn-1',
            sessionId: 'sess-1',
            event: reply.ok
              ? { type: 'text-delta', delta: reply.text ?? '' }
              : { type: 'turn-error', code: 500, message: reply.error ?? 'boom' },
          });
        // end the turn for the ok path
        if (reply.ok)
          for (const l of [...listeners])
            l({ turnId: 'turn-1', sessionId: 'sess-1', event: { type: 'turn-end', finishReason: 'stop' } });
      }, 0);
      return { turnId: 'turn-1' };
    }),
    onChatEvent: vi.fn((l: (n: unknown) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
  };
}

function depsWithBridge(reply: { ok: boolean; text?: string; error?: string }, pkg?: string) {
  const bridge = makeBridge(reply);
  return {
    bridge,
    deps: {
      ensureBridge: async () => bridge,
      getCwd: () => '/ws',
      log: vi.fn(),
      readWorkspaceFile: async () => pkg,
    },
  };
}

async function invokeCommand() {
  const [, handler] = mocks.registerCommand.mock.calls[0] as [string, (...a: unknown[]) => Promise<void>];
  await handler({ fsPath: '/ws/design.png', scheme: 'file' });
}

describe('detectFramework', () => {
  const matrix: Array<[Record<string, unknown>, string]> = [
    [{ dependencies: { react: '^18', 'react-dom': '^18' } }, 'react'],
    [{ dependencies: { next: '^14' }, devDependencies: { typescript: '^5' } }, 'nextjs'],
    [{ dependencies: { vue: '^3' } }, 'vue'],
    [{ dependencies: { nuxt: '^3' } }, 'vue'],
    [{ dependencies: { svelte: '^4' } }, 'svelte'],
    [{ devDependencies: { '@sveltejs/kit': '^2' } }, 'svelte'],
    [{ dependencies: { express: '^4' } }, 'react'], // default
    [{}, 'react'],
  ];
  for (const [pkg, expected] of matrix) {
    it(`detects ${expected} for ${JSON.stringify(Object.keys((pkg as { dependencies?: object }).dependencies ?? (pkg as { devDependencies?: object }).devDependencies ?? {}))}`, () => {
      expect(detectFramework(pkg as { dependencies?: Record<string, string> }).framework).toBe(expected);
    });
  }
  it('detects typescript', () => {
    expect(detectFramework({ devDependencies: { typescript: '^5' } }).typescript).toBe(true);
    expect(detectFramework({ dependencies: { react: '^18' } }).typescript).toBe(false);
  });
  it('next wins over react when both present', () => {
    expect(detectFramework({ dependencies: { next: '^14', react: '^18' } }).framework).toBe('nextjs');
  });
});

describe('editorLanguageFor / frameworkLabel', () => {
  it('maps tsx for react+ts, jsx otherwise', () => {
    expect(editorLanguageFor({ framework: 'react', typescript: true })).toEqual({
      language: 'typescriptreact',
      ext: '.tsx',
    });
    expect(editorLanguageFor({ framework: 'react', typescript: false }).ext).toBe('.jsx');
    expect(editorLanguageFor({ framework: 'vue', typescript: true }).ext).toBe('.vue');
    expect(editorLanguageFor({ framework: 'svelte', typescript: false }).ext).toBe('.svelte');
  });
  it('labels frameworks', () => {
    expect(frameworkLabel({ framework: 'nextjs', typescript: true })).toBe('Next.js + TypeScript');
    expect(frameworkLabel({ framework: 'vue', typescript: false })).toBe('Vue');
  });
});

describe('buildDesignToCodePrompt', () => {
  it('names the framework and demands code-only output', () => {
    const p = buildDesignToCodePrompt({ framework: 'vue', typescript: true });
    expect(p).toContain('Vue + TypeScript');
    expect(p).toContain('Output ONLY code, no explanation');
  });
});

describe('extractGeneratedCode', () => {
  it('strips fences', () => {
    expect(extractGeneratedCode('```tsx\nconst A = 1;\n```')).toBe('const A = 1;');
    expect(extractGeneratedCode('```\n<div/>\n```')).toBe('<div/>');
  });
  it('leaves plain code alone', () => {
    expect(extractGeneratedCode('  const A = 1;  ')).toBe('const A = 1;');
  });
});

describe('looksLikeVisionError', () => {
  it('classifies vision failures', () => {
    expect(looksLikeVisionError('model does not support image inputs')).toBe(true);
    expect(looksLikeVisionError('unsupported media type')).toBe(true);
    expect(looksLikeVisionError('gateway timeout')).toBe(false);
  });
});

describe('mimeForExtension / imageToDataUrl', () => {
  it('maps extensions', () => {
    expect(mimeForExtension('a.png')).toBe('image/png');
    expect(mimeForExtension('a.JPG')).toBe('image/jpeg');
    expect(mimeForExtension('a.webp')).toBe('image/webp');
  });
  it('builds a data URL', () => {
    const url = imageToDataUrl(new Uint8Array([1, 2, 3]), 'image/png');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('sunday.designToCode command', () => {
  it('registers the command', () => {
    const { deps } = depsWithBridge({ ok: true, text: 'x' });
    registerDesignToCode({ subscriptions: [] } as never, deps as never);
    expect(mocks.registerCommand).toHaveBeenCalledWith('sunday.designToCode', expect.any(Function));
  });

  it('sends image parts and previews the generated code', async () => {
    const { bridge, deps } = depsWithBridge(
      { ok: true, text: '```tsx\nexport const A = () => <div/>;\n```' },
      JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { typescript: '^5' } }),
    );
    registerDesignToCode({ subscriptions: [] } as never, deps as never);
    await invokeCommand();
    const sent = bridge.chatSend.mock.calls[0][0] as { message: unknown[] };
    expect(Array.isArray(sent.message)).toBe(true);
    const parts = sent.message as Array<{ type: string; dataUrl?: string }>;
    expect(parts.find((p) => p.type === 'image')?.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(parts.find((p) => p.type === 'text')).toBeTruthy();
    expect(mocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'typescriptreact', content: 'export const A = () => <div/>;' }),
    );
    expect(mocks.showTextDocument).toHaveBeenCalled();
  });

  it('shows a clear error with a text-description suggestion when the model lacks vision', async () => {
    const { deps } = depsWithBridge({ ok: false, error: 'this model does not support image inputs' });
    registerDesignToCode({ subscriptions: [] } as never, deps as never);
    await invokeCommand();
    expect(mocks.showErrorMessage).toHaveBeenCalled();
    const msg = String(mocks.showErrorMessage.mock.calls[0][0]);
    expect(msg).toMatch(/failed/);
    expect(msg).toMatch(/text description/);
    expect(mocks.openTextDocument).not.toHaveBeenCalled();
  });

  it('errors clearly when the gateway is unreachable', async () => {
    const { deps } = depsWithBridge({ ok: true, text: 'x' });
    deps.ensureBridge = async () => {
      throw new Error('sidecar down');
    };
    registerDesignToCode({ subscriptions: [] } as never, deps as never);
    await invokeCommand();
    expect(mocks.showErrorMessage).toHaveBeenCalled();
    expect(String(mocks.showErrorMessage.mock.calls[0][0])).toMatch(/could not reach the AI gateway/);
  });

  it('applies to a file after the filename input', async () => {
    mocks.showInformationMessage.mockResolvedValueOnce('Apply to file…' as never);
    mocks.showInputBox.mockResolvedValueOnce('MyCard.tsx' as never);
    const { deps } = depsWithBridge({ ok: true, text: 'const X = 1;' });
    registerDesignToCode({ subscriptions: [] } as never, deps as never);
    await invokeCommand();
    expect(mocks.writeFile).toHaveBeenCalled();
    const written = mocks.writeFile.mock.calls[0][1] as Uint8Array;
    expect(Buffer.from(written).toString('utf8')).toBe('const X = 1;');
  });

  it('copies to clipboard on Copy', async () => {
    mocks.showInformationMessage.mockResolvedValueOnce('Copy to clipboard' as never);
    const { deps } = depsWithBridge({ ok: true, text: 'const X = 1;' });
    registerDesignToCode({ subscriptions: [] } as never, deps as never);
    await invokeCommand();
    expect(mocks.writeText).toHaveBeenCalledWith('const X = 1;');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
