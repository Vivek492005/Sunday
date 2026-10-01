import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserdManager,
  BrowserdNotFoundError,
  resolveBrowserdCommand,
} from './browserd.js';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-browserd.mjs', import.meta.url));

const managers: BrowserdManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop().catch(() => undefined);
});

function makeManager(extra: Record<string, unknown> = {}): BrowserdManager {
  const m = new BrowserdManager({
    browserdPath: FIXTURE,
    log: () => undefined,
    crashWindowMs: 5000,
    maxRapidCrashes: 3,
    ...extra,
  });
  managers.push(m);
  return m;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('resolveBrowserdCommand', () => {
  it('honours an explicit existing path', () => {
    const cmd = resolveBrowserdCommand('/nonexistent/moddir', FIXTURE);
    expect(cmd.source).toMatch(/config/);
    // .mjs is driven by this node explicitly (Windows-safe, no shebang reliance).
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toEqual([FIXTURE]);
  });

  it('rejects an explicit missing path loudly', () => {
    expect(() => resolveBrowserdCommand('/nonexistent/moddir', '/nope/browserd.js')).toThrow(
      BrowserdNotFoundError,
    );
  });

  it('discovers the sibling workspace package', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserd-resolve-'));
    try {
      const modDir = path.join(tmp, 'a', 'b');
      const cliJs = path.join(tmp, 'browserd', 'dist', 'cli.js');
      await fs.mkdir(path.dirname(cliJs), { recursive: true });
      await fs.writeFile(cliJs, '// fake');
      const cmd = resolveBrowserdCommand(modDir);
      expect(cmd.args).toEqual([cliJs]);
      expect(cmd.source).toMatch(/workspace/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when nothing is discoverable', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserd-resolve-'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = tmp; // empty dir: no browserd on PATH
      expect(() => resolveBrowserdCommand(path.join(tmp, 'mod'))).toThrow(BrowserdNotFoundError);
    } finally {
      process.env.PATH = savedPath;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('BrowserdManager', () => {
  it('starts, handshakes via browser/ping, and reports the driver', async () => {
    const m = makeManager();
    const statuses: string[] = [];
    m.onDidChangeStatus((s) => statuses.push(s));
    await m.start();
    expect(m.getStatus()).toBe('ready');
    expect(m.getDriverName()).toBe('mini');
    expect(statuses).toEqual(['starting', 'ready']);

    const pong = (await m.rpc('browser/ping')) as { driver: string };
    expect(pong.driver).toBe('mini');
  });

  it('stop() is graceful and idempotent', async () => {
    const m = makeManager();
    await m.start();
    await m.stop();
    expect(m.getStatus()).toBe('stopped');
    await m.stop(); // second stop is a no-op
    expect(m.getStatus()).toBe('stopped');
  });

  it('stop() SIGTERMs a child that ignores browser/close', async () => {
    const hung = new BrowserdManager({
      browserdPath: await makeWrapperFixture(['--ignore-close']),
      log: () => undefined,
      shutdownTimeoutMs: 200,
    });
    managers.push(hung);
    await hung.start();
    const t0 = Date.now();
    await hung.stop();
    expect(hung.getStatus()).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 15_000);

  it('gives up after maxRapidCrashes and reports crashed', async () => {
    const crashing = new BrowserdManager({
      browserdPath: await makeWrapperFixture(['--exit-after-ms', '80']),
      log: () => undefined,
      crashWindowMs: 5000,
      maxRapidCrashes: 3,
    });
    managers.push(crashing);
    await crashing.start();
    expect(crashing.getStatus()).toBe('ready');
    await waitFor(() => crashing.getStatus() === 'crashed', 15_000);
    // A later explicit start() resets the backoff and works again.
    await crashing.start();
    expect(crashing.getStatus()).toBe('ready');
  }, 30_000);

  it('restart() recovers a ready manager', async () => {
    const m = makeManager();
    await m.start();
    await m.restart();
    expect(m.getStatus()).toBe('ready');
    expect(m.getDriverName()).toBe('mini');
  });
});

/** Wrapper script that spawns the fixture with extra flags (crash/SIGTERM tests). */
async function makeWrapperFixture(extraArgs: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserd-wrap-'));
  const wrapper = path.join(dir, 'wrap.mjs');
  await fs.writeFile(
    wrapper,
    `import { spawn } from 'node:child_process';\n` +
      `const child = spawn(process.execPath, [${JSON.stringify(FIXTURE)}, ...${JSON.stringify(extraArgs)}], { stdio: 'inherit' });\n` +
      `child.on('exit', (c) => process.exit(c ?? 1));\n`,
  );
  return wrapper;
}
