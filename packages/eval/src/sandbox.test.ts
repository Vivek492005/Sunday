// @sunday/eval — sandbox wiring tests (F12).
//
// Verifies the --sandbox option end to end: the scripted adapter stamps
// ctx.sandbox so run_terminal executes inside the sandbox, a missing
// backend fails fast instead of running unsandboxed, and the default
// (off) behavior is unchanged. The bubblewrap tests run live here
// (bwrap is installed on this VM); docker is asserted unavailable
// (no docker CLI here) via the real availability probe.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCKER_IMAGE } from '@sunday/tools';
import { FakeModelAdapter } from './adapters.js';
import { parseSandboxOption, assertSandboxAvailable } from './sandboxOption.js';
import { TASKS } from './tasks.js';
import type { EvalTask } from './types.js';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('eval --sandbox option parsing', () => {
  it('defaults to off with the default docker image', () => {
    expect(parseSandboxOption([])).toEqual({ mode: 'off', dockerImage: DEFAULT_DOCKER_IMAGE });
  });

  it('parses --sandbox and --sandbox-image in both forms', () => {
    expect(parseSandboxOption(['--sandbox', 'bubblewrap'])).toEqual({
      mode: 'bubblewrap',
      dockerImage: DEFAULT_DOCKER_IMAGE,
    });
    expect(parseSandboxOption(['--sandbox=docker', '--sandbox-image', 'node:22-alpine'])).toEqual({
      mode: 'docker',
      dockerImage: 'node:22-alpine',
    });
    expect(parseSandboxOption(['--sandbox-image=node:22-alpine', '--sandbox', 'docker'])).toEqual({
      mode: 'docker',
      dockerImage: 'node:22-alpine',
    });
  });

  it('rejects unknown modes instead of silently running unsandboxed', () => {
    expect(() => parseSandboxOption(['--sandbox', 'firecracker'])).toThrow(
      /--sandbox must be one of off, docker, bubblewrap/,
    );
  });
});

describe('eval sandbox availability (fail fast)', () => {
  it('adapter construction throws when the requested backend is unavailable', () => {
    // Docker is not installed on this machine — the real probe must fail.
    expect(
      () => new FakeModelAdapter({ sandbox: { mode: 'docker', dockerImage: DEFAULT_DOCKER_IMAGE } }),
    ).toThrow(/docker CLI was not found/);
    expect(() =>
      assertSandboxAvailable({ mode: 'docker', dockerImage: DEFAULT_DOCKER_IMAGE }),
    ).toThrow(/docker CLI was not found/);
  });

  it('default (off) adapter constructs without a backend', () => {
    expect(() => new FakeModelAdapter()).not.toThrow();
    expect(() => new FakeModelAdapter({ sandbox: { mode: 'off', dockerImage: DEFAULT_DOCKER_IMAGE } })).not.toThrow();
  });
});

describe('eval sandboxed run (bubblewrap, live)', () => {
  it('runs the terminal task sandboxed and returns output', async () => {
    const root = tempRoot('sunday-eval-sandbox-');
    try {
      const adapter = new FakeModelAdapter({
        sandbox: { mode: 'bubblewrap', dockerImage: DEFAULT_DOCKER_IMAGE },
      });
      const task = TASKS.find((t) => t.id === 'terminal-run');
      expect(task).toBeDefined();
      const transcript = await adapter.runTask(task!, root);
      expect(transcript).toHaveLength(1);
      expect(transcript[0].tool).toBe('run_terminal');
      expect(transcript[0].valid).toBe(true);
      expect(transcript[0].result.output).toContain('42');
      // The call really went through the sandbox path (not host execution).
      expect(transcript[0].result.metadata?.sandbox).toBe('bubblewrap');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('isolates the sandbox tmpfs from the host', async () => {
    // bwrap mounts a fresh /tmp tmpfs: a file created at /tmp inside the
    // sandbox must not appear on the host. The same command unsandboxed
    // DOES create it — proving the difference is the sandbox, not the cmd.
    const marker = `sunday-eval-sandbox-probe-${Date.now()}-${process.pid}`;
    const probeTask: EvalTask = {
      id: 'sandbox-probe',
      title: 'sandbox isolation probe',
      category: 'terminal',
      seed: 0,
      prompt: 'probe',
      setup() {},
      script: [
        { kind: 'tool', tool: 'run_terminal', args: { command: `touch /tmp/${marker} && echo created` } },
      ],
      check: () => ({ pass: true, notes: '' }),
    };
    const root = tempRoot('sunday-eval-sandbox-');
    try {
      const sandboxed = new FakeModelAdapter({
        sandbox: { mode: 'bubblewrap', dockerImage: DEFAULT_DOCKER_IMAGE },
      });
      const t1 = await sandboxed.runTask(probeTask, root);
      expect(t1[0].valid).toBe(true);
      expect(t1[0].result.output).toContain('created');
      expect(existsSync(join('/tmp', marker))).toBe(false);

      const host = new FakeModelAdapter();
      const t2 = await host.runTask(probeTask, root);
      expect(t2[0].valid).toBe(true);
      expect(existsSync(join('/tmp', marker))).toBe(true);
    } finally {
      rmSync(join('/tmp', marker), { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
