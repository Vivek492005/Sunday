// Tests for the initProject helpers (Group B3). The VS Code wizard flow
// itself is thin glue over scaffold(); the pure bits are tested here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createTerminal: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { installCommandFor } from './initProject.js';
import { TEMPLATE_NAMES } from './scaffold.js';

describe('installCommandFor', () => {
  it('returns npm install for the node templates', () => {
    expect(installCommandFor('react-ts')).toBe('npm install');
    expect(installCommandFor('node-api')).toBe('npm install');
    expect(installCommandFor('nextjs')).toBe('npm install');
  });

  it('returns pip install for the python template', () => {
    expect(installCommandFor('python-cli')).toBe('pip install -e .');
  });

  it('covers every template', () => {
    for (const name of TEMPLATE_NAMES) {
      expect(installCommandFor(name)).toBeTruthy();
    }
  });
});
