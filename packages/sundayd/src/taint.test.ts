import { describe, it, expect } from 'vitest';
import {
  newTaintState,
  markTainted,
  taintEscalationReason,
  resetTaint,
  STATE_CHANGING_TOOLS,
} from './taint.js';

describe('SEC-09 taint tracking', () => {
  it('does not escalate when nothing tainted', () => {
    const s = newTaintState();
    expect(taintEscalationReason(s, 'run_terminal')).toBeNull();
  });

  it('escalates state-changing tools after untrusted content', () => {
    const s = newTaintState();
    markTainted(s, 'web_fetch');
    const reason = taintEscalationReason(s, 'run_terminal');
    expect(reason).toContain('SEC-09');
    expect(reason).toContain('web_fetch');
  });

  it('does NOT escalate read-only tools', () => {
    const s = newTaintState();
    markTainted(s, 'web_fetch');
    expect(taintEscalationReason(s, 'file_read')).toBeNull();
  });

  it('staged attack: malicious file tries to trigger unapproved write', () => {
    // Simulate: agent reads an untrusted file containing injected instructions,
    // then the model proposes a run_terminal. Taint must force manual approval.
    const s = newTaintState();
    markTainted(s, 'file_read_untrusted'); // the malicious file
    const reason = taintEscalationReason(s, 'run_terminal');
    expect(reason).not.toBeNull();
    expect(reason).toContain('Manual approval required');
  });

  it('reset clears taint for the next turn', () => {
    const s = newTaintState();
    markTainted(s, 'web_fetch');
    resetTaint(s);
    expect(taintEscalationReason(s, 'run_terminal')).toBeNull();
  });

  it('covers all expected state-changing tools', () => {
    expect(STATE_CHANGING_TOOLS.has('run_terminal')).toBe(true);
    expect(STATE_CHANGING_TOOLS.has('write_file')).toBe(true);
    expect(STATE_CHANGING_TOOLS.has('git_push')).toBe(true);
  });
});
