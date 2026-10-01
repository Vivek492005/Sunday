// Tests for the Part A workspace-trust prompts: trusted workspaces skip the
// prompt, untrusted ones show Allow/Deny, and Deny returns false.
import { describe, expect, it, vi } from 'vitest';
import {
  confirmSkillWithScripts,
  confirmTrustWorkspace,
  confirmWorkspaceMcpServer,
  type TrustPrompt,
} from './trust.js';

function makePrompt(trusted: boolean, choice: string | undefined): TrustPrompt & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isWorkspaceTrusted: () => trusted,
    showWarningMessage: vi.fn(async (message: string, ..._items: string[]) => {
      asked.push(message);
      return choice;
    }),
  };
}

describe('confirmWorkspaceMcpServer', () => {
  it('skips the prompt when trusted', async () => {
    const p = makePrompt(true, undefined);
    await expect(confirmWorkspaceMcpServer(p, 'git')).resolves.toBe(true);
    expect(p.asked).toHaveLength(0);
  });

  it('returns true on Allow and false on Deny', async () => {
    await expect(confirmWorkspaceMcpServer(makePrompt(false, 'Allow'), 'git')).resolves.toBe(true);
    const denied = makePrompt(false, 'Deny');
    await expect(confirmWorkspaceMcpServer(denied, 'git')).resolves.toBe(false);
    expect(denied.asked[0]).toContain('"git"');
  });

  it('treats a dismissed dialog as denial', async () => {
    await expect(confirmWorkspaceMcpServer(makePrompt(false, undefined), 'git')).resolves.toBe(false);
  });
});

describe('confirmSkillWithScripts', () => {
  it('skips the prompt when trusted, prompts when not', async () => {
    await expect(confirmSkillWithScripts(makePrompt(true, undefined), 'deploy')).resolves.toBe(true);
    const p = makePrompt(false, 'Allow');
    await expect(confirmSkillWithScripts(p, 'deploy')).resolves.toBe(true);
    expect(p.asked[0]).toContain('"deploy"');
  });
});

describe('confirmTrustWorkspace', () => {
  it('returns true immediately when trusted, prompts otherwise', async () => {
    const p = makePrompt(true, undefined);
    await expect(confirmTrustWorkspace(p)).resolves.toBe(true);
    expect(p.asked).toHaveLength(0);
    await expect(confirmTrustWorkspace(makePrompt(false, 'Deny'))).resolves.toBe(false);
  });
});
