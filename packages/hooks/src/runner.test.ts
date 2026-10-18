import { describe, expect, it } from 'vitest';
import { runHookCommand, sanitizeEnv } from './runner.js';

const ECHO = process.platform === 'win32' ? 'cmd' : 'echo';
const echoArgs = (msg: string): string[] =>
  process.platform === 'win32' ? ['/c', 'echo', msg] : [msg];

describe('runner', () => {
  it('runs a command and captures output', async () => {
    const r = await runHookCommand(ECHO, echoArgs('hello-hook'), {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain('hello-hook');
    expect(r.spawnError).toBeUndefined();
  }, 15000);

  it('timeout NEVER hangs: a sleeping process is killed', async () => {
    const sleepCmd = process.platform === 'win32' ? 'powershell' : 'sleep';
    const sleepArgs =
      process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 30'] : ['30'];
    const start = Date.now();
    const r = await runHookCommand(sleepCmd, sleepArgs, {
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    // Must return well before the 30s sleep would finish.
    expect(elapsed).toBeLessThan(10000);
  }, 20000);

  it('caps output and flags truncation', async () => {
    // `yes` produces unbounded output; the cap must stop accumulation.
    const r = await runHookCommand('yes', [], {
      cwd: process.cwd(),
      timeoutMs: 3000,
      outputCapBytes: 1024,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
  }, 15000);

  it('reports spawn errors instead of throwing', async () => {
    const r = await runHookCommand('__definitely_not_a_real_binary__', [], {
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    expect(r.spawnError).toBeDefined();
    expect(r.exitCode).toBeNull();
  }, 10000);

  it('applies {file}/{tool}/{cwd} templates', async () => {
    const r = await runHookCommand(ECHO, echoArgs('{tool}:{file}'), {
      cwd: process.cwd(),
      timeoutMs: 5000,
      templates: { tool: 'read_file', file: 'a.ts' },
    });
    expect(r.stdout).toContain('read_file:a.ts');
  }, 15000);

  it('leaves templates untouched when allowTemplates is false', async () => {
    const r = await runHookCommand(ECHO, echoArgs('{file}'), {
      cwd: process.cwd(),
      timeoutMs: 5000,
      allowTemplates: false,
      templates: { file: 'a.ts' },
    });
    expect(r.stdout).toContain('{file}');
  }, 15000);
});

describe('sanitizeEnv', () => {
  it('strips secret-shaped vars', () => {
    const env = {
      PATH: '/bin',
      SUNDAY_GATEWAY_KEY: 'shh',
      OPENAI_API_KEY: 'shh',
      MY_TOKEN: 'shh',
      DB_SECRET: 'shh',
      SAFE_VAR: 'ok',
    };
    const out = sanitizeEnv(env as NodeJS.ProcessEnv);
    expect(out.PATH).toBe('/bin');
    expect(out.SAFE_VAR).toBe('ok');
    expect(out.SUNDAY_GATEWAY_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.MY_TOKEN).toBeUndefined();
    expect(out.DB_SECRET).toBeUndefined();
    expect(out.SUNDAY_HOOK).toBe('1');
  });
});
