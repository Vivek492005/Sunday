import { describe, it, expect } from 'vitest';
import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('parses a chat command with a quoted prompt', () => {
    const r = parseArgs(['chat', 'hello world']);
    expect(r.cmd).toBe('chat');
    expect(r.positional).toEqual(['hello world']);
    expect(r.flags).toEqual({});
  });

  it('parses --flag value and boolean flags', () => {
    const r = parseArgs(['chat', 'hi', '--session', 'abc', '--json']);
    expect(r.flags['session']).toBe('abc');
    expect(r.flags['json']).toBe(true);
  });

  it('parses --flag=value form', () => {
    const r = parseArgs(['status', '--json=true']);
    expect(r.flags['json']).toBe('true');
  });

  it('handles -h shorthand', () => {
    const r = parseArgs(['-h']);
    expect(r.flags['help']).toBe(true);
  });

  it('collects everything after -- as positional', () => {
    const r = parseArgs(['chat', '--', '--not-a-flag']);
    expect(r.positional).toEqual(['--not-a-flag']);
  });

  it('returns undefined cmd for empty argv', () => {
    const r = parseArgs([]);
    expect(r.cmd).toBeUndefined();
  });

  it('treats tokens after the command as positional', () => {
    const r = parseArgs(['sessions', 'extra']);
    expect(r.cmd).toBe('sessions');
    expect(r.positional).toEqual(['extra']);
  });
});
