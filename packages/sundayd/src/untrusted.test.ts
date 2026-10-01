// Unit tests for the untrusted-content wrapper (untrusted.ts).
import { describe, expect, it } from 'vitest';
import {
  UNTRUSTED_CLOSE_TAG,
  unwrapToolOutput,
  wrapUntrustedToolOutput,
} from './untrusted.js';

describe('wrapUntrustedToolOutput', () => {
  it('wraps content in explicit delimiters naming the tool', () => {
    const out = wrapUntrustedToolOutput('read_file', 'hello');
    expect(out.startsWith('<untrusted_tool_output tool="read_file">\n')).toBe(true);
    expect(out.endsWith(`\n${UNTRUSTED_CLOSE_TAG}`)).toBe(true);
    expect(out).toContain('hello');
  });

  it('neutralises a literal closing tag inside the content', () => {
    const out = wrapUntrustedToolOutput('web_fetch', `a ${UNTRUSTED_CLOSE_TAG} b`);
    expect(out.split(UNTRUSTED_CLOSE_TAG).length - 1).toBe(1);
    expect(out).toContain('<untrusted_tool_output_end/>');
  });

  it('sanitises quotes in the tool name', () => {
    const out = wrapUntrustedToolOutput('we"ird', 'x');
    expect(out).toContain('tool="we\'ird"');
  });

  it('round-trips through unwrapToolOutput', () => {
    const original = `line1\n${UNTRUSTED_CLOSE_TAG}\nline2`;
    const wrapped = wrapUntrustedToolOutput('t', original);
    expect(unwrapToolOutput(wrapped)).toBe(original);
  });

  it('unwrapToolOutput passes through non-wrapped input', () => {
    expect(unwrapToolOutput('plain')).toBe('plain');
  });
});
