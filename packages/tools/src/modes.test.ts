// Tests for agent modes (Group B4): allowlists, denial messages, parsing.
import { describe, expect, it } from 'vitest';

import {
  AGENT_MODE_ENV,
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  agentModeLabel,
  canUseTool,
  modeDenialMessage,
  modeSystemPromptSuffix,
  modeToolAllowlist,
  parseAgentMode,
} from './modes.js';

describe('parseAgentMode', () => {
  it('parses the four modes case-insensitively', () => {
    expect(parseAgentMode('architect')).toBe('architect');
    expect(parseAgentMode('Reviewer')).toBe('reviewer');
    expect(parseAgentMode('IMPLEMENTER')).toBe('implementer');
    expect(parseAgentMode(' auto ')).toBe('auto');
  });

  it('falls back to auto for missing/invalid values', () => {
    expect(parseAgentMode(undefined)).toBe('auto');
    expect(parseAgentMode(null)).toBe('auto');
    expect(parseAgentMode('')).toBe('auto');
    expect(parseAgentMode('superuser')).toBe('auto');
  });

  it('exposes the env var name and default', () => {
    expect(AGENT_MODE_ENV).toBe('SUNDAY_AGENT_MODE');
    expect(DEFAULT_AGENT_MODE).toBe('auto');
    expect(AGENT_MODES).toEqual(['auto', 'architect', 'implementer', 'reviewer']);
  });
});

describe('modeToolAllowlist', () => {
  it('auto and implementer allow everything (null allowlist)', () => {
    expect(modeToolAllowlist('auto')).toBeNull();
    expect(modeToolAllowlist('implementer')).toBeNull();
  });

  it('architect allows read-only tools only', () => {
    const allow = modeToolAllowlist('architect')!;
    for (const t of READ_ONLY_TOOLS) expect(allow.has(t)).toBe(true);
    for (const t of WRITE_TOOLS) expect(allow.has(t)).toBe(false);
  });

  it('reviewer allows read-only tools only', () => {
    const allow = modeToolAllowlist('reviewer')!;
    for (const t of READ_ONLY_TOOLS) expect(allow.has(t)).toBe(true);
    for (const t of WRITE_TOOLS) expect(allow.has(t)).toBe(false);
  });
});

describe('canUseTool', () => {
  it('allows all tools in auto/implementer', () => {
    expect(canUseTool('auto', 'write_file')).toBe(true);
    expect(canUseTool('implementer', 'run_terminal')).toBe(true);
    expect(canUseTool('auto', 'some_future_tool')).toBe(true);
  });

  it('blocks writes and execution in architect mode', () => {
    expect(canUseTool('architect', 'write_file')).toBe(false);
    expect(canUseTool('architect', 'edit_file')).toBe(false);
    expect(canUseTool('architect', 'run_terminal')).toBe(false);
    expect(canUseTool('architect', 'read_file')).toBe(true);
    expect(canUseTool('architect', 'search')).toBe(true);
    expect(canUseTool('architect', 'git_diff')).toBe(true);
  });

  it('blocks writes in reviewer mode', () => {
    expect(canUseTool('reviewer', 'write_file')).toBe(false);
    expect(canUseTool('reviewer', 'edit_file')).toBe(false);
    expect(canUseTool('reviewer', 'run_terminal')).toBe(false);
    expect(canUseTool('reviewer', 'read_file')).toBe(true);
    expect(canUseTool('reviewer', 'git_diff')).toBe(true);
  });

  it('fail-closes unknown tools in restricted modes', () => {
    expect(canUseTool('architect', 'mystery_tool')).toBe(false);
    expect(canUseTool('reviewer', 'mystery_tool')).toBe(false);
  });
});

describe('modeDenialMessage', () => {
  it('uses the contract string for reviewer write attempts', () => {
    expect(modeDenialMessage('reviewer', 'write_file')).toContain('Reviewer mode: writes disabled');
    expect(modeDenialMessage('reviewer', 'edit_file')).toContain('Reviewer mode: writes disabled');
    expect(modeDenialMessage('reviewer', 'run_terminal')).toContain('Reviewer mode: writes disabled');
  });

  it('names the mode and tool for other denials', () => {
    expect(modeDenialMessage('architect', 'write_file')).toContain('Architect mode');
    expect(modeDenialMessage('architect', 'write_file')).toContain('write_file');
    expect(modeDenialMessage('reviewer', 'browser_open')).toContain('Reviewer mode');
  });
});

describe('modeSystemPromptSuffix / agentModeLabel', () => {
  it('returns a planning suffix for architect and reviewer guidance', () => {
    expect(modeSystemPromptSuffix('architect')).toContain('Architect mode');
    expect(modeSystemPromptSuffix('reviewer')).toContain('Reviewer mode');
    expect(modeSystemPromptSuffix('implementer')).toContain('Implementer mode');
    expect(modeSystemPromptSuffix('auto')).toBe('');
  });

  it('labels all modes', () => {
    expect(agentModeLabel('auto')).toBe('Auto');
    expect(agentModeLabel('reviewer')).toBe('Reviewer');
  });
});
