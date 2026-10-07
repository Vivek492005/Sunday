/**
 * S6: outbound prompt redaction — secrets in user text, @file expansions,
 * edit prompts, code actions, terminal output, and diffs are redacted
 * before reaching the provider.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: { fs: { readFile: vi.fn(), readDirectory: vi.fn() }, getConfiguration: vi.fn() },
  window: { showWarningMessage: vi.fn() },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); },
}));

import { buildEditPrompt } from './inlineEdit.js';
import { buildFixPrompt, buildExplainPrompt } from './codeActions.js';
import { buildTerminalErrorPrompt } from './terminalExplain.js';
import { buildCommitPrompt } from './gitCommit.js';

const SECRET_CODE = 'const key = "gsk_test123456789";\nconst x = 1;';

describe('S6: outbound prompt redaction', () => {
  it('buildEditPrompt redacts secrets in code', () => {
    const p = buildEditPrompt('fix it', SECRET_CODE, 'typescript');
    expect(p).not.toContain('gsk_test123456789');
    expect(p).toContain('[REDACTED:');
  });

  it('buildFixPrompt redacts secrets in code', () => {
    const p = buildFixPrompt([], SECRET_CODE, { languageId: 'typescript' });
    expect(p).not.toContain('gsk_test123456789');
  });

  it('buildExplainPrompt redacts secrets in code', () => {
    const p = buildExplainPrompt(SECRET_CODE, 'typescript');
    expect(p).not.toContain('gsk_test123456789');
  });

  it('buildTerminalErrorPrompt redacts secrets in output', () => {
    const p = buildTerminalErrorPrompt({
      command: 'deploy.sh',
      output: 'OPENROUTER_API_KEY=sk-or-v1-secret12345678 failed',
    });
    expect(p).not.toContain('sk-or-v1-secret12345678');
  });

  it('buildCommitPrompt redacts secrets in diff', () => {
    const p = buildCommitPrompt('+API_KEY=gsk_diffsecret12345678', false);
    expect(p).not.toContain('gsk_diffsecret12345678');
  });
});
