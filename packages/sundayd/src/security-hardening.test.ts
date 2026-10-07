/**
 * S1/S3/S5 security hardening tests:
 * - S1: run_terminal is dangerous → requires approval
 * - S3: sensitive RPCs require the per-boot token
 * - S5: taint escalation + credential gate in the loop
 */
import { describe, expect, it } from 'vitest';
import { PolicyGate, syncDangerousFlags } from './policy.js';
import { runTerminalTool } from '@sunday/tools';
import { ToolRegistry } from '@sunday/tools';
import { SundayDaemon } from './daemon.js';
import { markTainted, newTaintState, taintEscalationReason, STATE_CHANGING_TOOLS } from './taint.js';
import { credentialGateReason, isCredentialFile } from './credential-gate.js';

describe('S1: run_terminal is dangerous', () => {
  it('run_terminal definition carries dangerous:true', () => {
    expect(runTerminalTool.definition.dangerous).toBe(true);
  });

  it('syncDangerousFlags marks run_terminal on the gate', () => {
    const policy = new PolicyGate();
    const registry = new ToolRegistry();
    registry.register(runTerminalTool);
    syncDangerousFlags(policy, registry);
    expect(policy.isDangerous('run_terminal')).toBe(true);
  });

  it('run_terminal is denied without approval in allow-all mode', () => {
    const policy = new PolicyGate(); // default allow-all
    policy.markDangerous('run_terminal');
    const d = policy.evaluate('run_terminal');
    expect(d.allow).toBe(false);
  });
});

describe('S3: per-boot token for sensitive RPCs', () => {
  it('generates a random boot token per boot', () => {
    const a = new SundayDaemon({ bootToken: 'test-token-a' });
    const b = new SundayDaemon({ bootToken: 'test-token-b' });
    expect(a.bootToken).toBe('test-token-a');
    expect(b.bootToken).toBe('test-token-b');
    expect(a.bootToken).not.toBe(b.bootToken);
  });

  it('requireBootToken rejects missing token', () => {
    const d = new SundayDaemon({ bootToken: 'secret-token' });
    expect(() => d.requireBootToken({})).toThrow(/boot token/);
    expect(() => d.requireBootToken(null)).toThrow(/boot token/);
  });

  it('requireBootToken rejects wrong token', () => {
    const d = new SundayDaemon({ bootToken: 'secret-token' });
    expect(() => d.requireBootToken({ bootToken: 'wrong' })).toThrow(/boot token/);
  });

  it('requireBootToken accepts correct token', () => {
    const d = new SundayDaemon({ bootToken: 'secret-token' });
    expect(() => d.requireBootToken({ bootToken: 'secret-token' })).not.toThrow();
  });

  it('policy/approve without token is rejected via dispatch', async () => {
    const d = new SundayDaemon({ bootToken: 'secret-token' });
    // registerMcpMethods is wired by cli.ts; here we test the gate directly
    // through dispatchLocal on a method that requires the token.
    await expect(
      d.dispatchLocal('daemon/set-workspace-trust', { workspaceRoot: '/tmp', trusted: true }),
    ).rejects.toThrow(/boot token/);
  });

  it('daemon/set-workspace-trust with token succeeds', async () => {
    const d = new SundayDaemon({ bootToken: 'secret-token' });
    const r = await d.dispatchLocal('daemon/set-workspace-trust', {
      workspaceRoot: '/tmp/sunday-test-ws',
      trusted: true,
      bootToken: 'secret-token',
    });
    expect(r).toMatchObject({ ok: true });
  });
});

describe('S5: taint escalation uses real tool names', () => {
  it('STATE_CHANGING_TOOLS contains real tool names', () => {
    expect(STATE_CHANGING_TOOLS.has('run_terminal')).toBe(true);
    expect(STATE_CHANGING_TOOLS.has('write_file')).toBe(true);
    expect(STATE_CHANGING_TOOLS.has('edit_file')).toBe(true);
    expect(STATE_CHANGING_TOOLS.has('shell_exec')).toBe(false);
    expect(STATE_CHANGING_TOOLS.has('file_write')).toBe(false);
  });

  it('tainted read_file escalates run_terminal to approval', () => {
    const taint = newTaintState();
    // Not tainted yet — no escalation.
    expect(taintEscalationReason(taint, 'run_terminal')).toBeNull();
    // Simulate a read_file on untrusted content.
    markTainted(taint, 'file_read_untrusted');
    const reason = taintEscalationReason(taint, 'run_terminal');
    expect(reason).toBeTruthy();
    // Read-only tools are not escalated.
    expect(taintEscalationReason(taint, 'read_file')).toBeNull();
  });
});

describe('S5: credential gate', () => {
  it('flags .env, .pem, id_rsa', () => {
    expect(isCredentialFile('.env')).toBe(true);
    expect(isCredentialFile('config/.env.local')).toBe(true);
    expect(isCredentialFile('key.pem')).toBe(true);
    expect(isCredentialFile('~/.ssh/id_rsa')).toBe(true);
    expect(isCredentialFile('src/index.ts')).toBe(false);
  });

  it('credentialGateReason returns a reason for credential files', () => {
    expect(credentialGateReason('.env')).toMatch(/Manual approval/);
    expect(credentialGateReason('src/app.ts')).toBeNull();
  });
});
