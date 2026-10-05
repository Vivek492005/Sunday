// @sunday/tools — sandbox execution tests. No docker/bwrap required: flag
// construction is pure, availability is probed through an injected fake, and
// execution runs against a fake spawn runner.
import { describe, expect, it, afterEach } from 'vitest';
import {
  buildBwrapCommand,
  buildDockerCommand,
  checkSandboxAvailable,
  clearSandboxAvailabilityCache,
  DEFAULT_DOCKER_IMAGE,
  runSandboxed,
  SANDBOX_WORKDIR,
  setSandboxProbeForTests,
  type SandboxConfig,
} from './sandbox.js';
import type { ToolResult } from './types.js';
import { createDefaultRegistry } from './registry.js';

afterEach(() => {
  setSandboxProbeForTests(undefined);
  clearSandboxAvailabilityCache();
});

describe('buildDockerCommand', () => {
  it('constructs a disposable, network-isolated container invocation', () => {
    const built = buildDockerCommand('npm test', '/home/u/proj', 'node:22-alpine', 'test-name');
    expect(built.cmd).toBe('docker');
    expect(built.argv).toEqual([
      'run',
      '--rm',
      '-i',
      '--name',
      'test-name',
      '--pull',
      'never',
      '--network',
      'none',
      '-v',
      '/home/u/proj:/work',
      '-w',
      '/work',
      'node:22-alpine',
      'sh',
      '-c',
      'npm test',
    ]);
    expect(built.containerName).toBe('test-name');
  });

  it('generates a unique container name when none is given', () => {
    const a = buildDockerCommand('true', '/w', 'img');
    const b = buildDockerCommand('true', '/w', 'img');
    expect(a.containerName).not.toBe(b.containerName);
  });
});

describe('buildBwrapCommand', () => {
  it('unshares the network namespace and keeps the host root read-only', () => {
    const built = buildBwrapCommand('make build', '/home/u/proj');
    expect(built.cmd).toBe('bwrap');
    const a = built.argv;
    expect(a).toContain('--unshare-net');
    expect(a).toContain('--die-with-parent');
    // Host root read-only, workspace writable at /work:
    const roIdx = a.indexOf('--ro-bind');
    expect(a.slice(roIdx, roIdx + 3)).toEqual(['--ro-bind', '/', '/']);
    expect(a).toContain('--proc');
    expect(a).toContain('--dev');
    // --dir /work must precede --bind (bwrap won't create the mountpoint):
    expect(a.indexOf('--dir')).toBeLessThan(a.indexOf('--bind'));
    const bindIdx = a.indexOf('--bind');
    expect(a.slice(bindIdx, bindIdx + 3)).toEqual(['--bind', '/home/u/proj', SANDBOX_WORKDIR]);
    expect(a.slice(-3)).toEqual(['sh', '-c', 'make build']);
    expect(a).toContain('--chdir');
  });
});

describe('checkSandboxAvailable', () => {
  it('docker is available when the probe finds the CLI', () => {
    expect(checkSandboxAvailable('docker', { probe: () => true })).toEqual({ ok: true });
  });

  it('docker missing yields an actionable error', () => {
    const r = checkSandboxAvailable('docker', { probe: () => false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/docker CLI was not found/);
    expect(r.reason).toMatch(/Docker Desktop/);
    expect(r.reason).toMatch(/sunday\.sandbox\.mode/);
  });

  it('bubblewrap is Linux-only', () => {
    const r = checkSandboxAvailable('bubblewrap', { probe: () => true, platform: 'darwin' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only supported on Linux/);
  });

  it('bubblewrap missing on Linux yields install guidance', () => {
    const r = checkSandboxAvailable('bubblewrap', { probe: () => false, platform: 'linux' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bwrap.*was not found/);
    expect(r.reason).toMatch(/bubblewrap/);
  });

  it('off is always available', () => {
    expect(checkSandboxAvailable('off', { probe: () => false }).ok).toBe(true);
  });
});

describe('runSandboxed', () => {
  const cfg: SandboxConfig = { mode: 'docker', dockerImage: 'img:test' };

  function fakeRunner(calls: { cmd: string; argv: string[] }[], result?: Partial<ToolResult>) {
    return async (
      cmd: string,
      argv: string[],
      _cwd: string,
      _timeoutMs: number,
      _maxOut: number,
    ): Promise<ToolResult> => {
      calls.push({ cmd, argv });
      return {
        output: 'fake-output',
        isError: false,
        metadata: { exitCode: 0, ...(result?.metadata ?? {}) },
        ...result,
      };
    };
  }

  it('docker mode shells out to docker with network disabled', async () => {
    const calls: { cmd: string; argv: string[] }[] = [];
    const res = await runSandboxed({
      command: 'echo hi',
      sandbox: cfg,
      cwd: '/home/u/proj',
      timeoutMs: 1000,
      maxOut: 1000,
      probe: () => true,
      runner: fakeRunner(calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('docker');
    expect(calls[0].argv).toContain('--network');
    expect(calls[0].argv[calls[0].argv.indexOf('--network') + 1]).toBe('none');
    expect(calls[0].argv).toContain('img:test');
    expect(calls[0].argv.slice(-3)).toEqual(['sh', '-c', 'echo hi']);
    expect(res.output).toBe('fake-output');
    expect(res.metadata).toMatchObject({ sandbox: 'docker' });
  });

  it('bubblewrap mode shells out to bwrap', async () => {
    const calls: { cmd: string; argv: string[] }[] = [];
    const res = await runSandboxed({
      command: 'echo hi',
      sandbox: { mode: 'bubblewrap', dockerImage: DEFAULT_DOCKER_IMAGE },
      cwd: '/home/u/proj',
      timeoutMs: 1000,
      maxOut: 1000,
      probe: () => true,
      // bubblewrap is Linux-only; pin the platform so this test is
      // meaningful on macOS/Windows CI runners too.
      platform: 'linux',
      runner: fakeRunner(calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bwrap');
    expect(calls[0].argv).toContain('--unshare-net');
    expect(res.metadata).toMatchObject({ sandbox: 'bubblewrap' });
  });

  it('fails with a clear error when the sandbox binary is missing', async () => {
    const res = await runSandboxed({
      command: 'echo hi',
      sandbox: cfg,
      cwd: '/home/u/proj',
      timeoutMs: 1000,
      maxOut: 1000,
      probe: () => false,
    });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/docker CLI was not found/);
  });

  it('docker mode with an empty image asks for sunday.sandbox.dockerImage', async () => {
    const res = await runSandboxed({
      command: 'echo hi',
      sandbox: { mode: 'docker', dockerImage: '  ' },
      cwd: '/home/u/proj',
      timeoutMs: 1000,
      maxOut: 1000,
      probe: () => true,
    });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/sunday\.sandbox\.dockerImage/);
  });

  it('docker exit 125 appends a docker-pull hint', async () => {
    const calls: { cmd: string; argv: string[] }[] = [];
    const res = await runSandboxed({
      command: 'echo hi',
      sandbox: cfg,
      cwd: '/home/u/proj',
      timeoutMs: 1000,
      maxOut: 1000,
      probe: () => true,
      runner: fakeRunner(calls, {
        isError: true,
        output: "Unable to find image 'img:test' locally",
        metadata: { exitCode: 125 },
      }),
    });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/docker pull img:test/);
  });
});

describe('run_terminal sandbox wiring', () => {
  it('routes into the sandbox layer instead of the host shell', async () => {
    // Probe says docker is missing: if the decision point failed to route,
    // host `echo hi` would succeed. Instead we get the sandbox error.
    setSandboxProbeForTests(() => false);
    const r = createDefaultRegistry();
    const res = await r.call(
      'run_terminal',
      { command: 'echo hi' },
      { cwd: process.cwd(), sandbox: { mode: 'docker', dockerImage: 'img:test' } },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/docker CLI was not found/);
    expect(res.output).toMatch(/sunday\.sandbox\.mode/);
  });

  it('host execution is unchanged when no sandbox is configured', async () => {
    const r = createDefaultRegistry();
    const res = await r.call('run_terminal', { command: 'echo host-path-ok' }, { cwd: process.cwd() });
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/host-path-ok/);
    expect(res.metadata).not.toHaveProperty('sandbox');
  }, 30000); // Windows runners: terminal spawn can be slow
});
