// SidecarManager tests — discovery is pure fs probing; lifecycle tests spawn
// the fixture daemon for real. No network, no API keys, no vscode API.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import {
  SidecarManager,
  resolveSidecarCommand,
  SidecarNotFoundError,
  ProtocolMismatchError,
  type SidecarStatus,
} from './sidecar.js';

const FIXTURE = fileURLToPath(new URL('./test/fixtures/mini-sundayd.mjs', import.meta.url));
const FIXTURE_URL = new URL('./test/fixtures/mini-sundayd.mjs', import.meta.url).href;
// packages/ext-agent/src -> packages/ext-agent
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const managers: SidecarManager[] = [];
function makeManager(
  sidecarPath: string,
  extra: Record<string, number> = {},
): { manager: SidecarManager; logs: string[] } {
  const logs: string[] = [];
  const manager = new SidecarManager({
    extensionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-ext-')),
    clientVersion: '0.0.1-test',
    readConfig: () => ({ sidecarPath }),
    log: (m) => logs.push(m),
    handshakeTimeoutMs: 5000,
    shutdownTimeoutMs: 2000,
    crashWindowMs: 2000,
    maxRapidCrashes: 2,
    ...extra,
  });
  managers.push(manager);
  return { manager, logs };
}

afterEach(async () => {
  for (const m of managers.splice(0)) {
    try {
      await m.stop();
    } catch {
      /* ignore */
    }
    m.dispose();
  }
});

/** Wrap the fixture to inject argv flags (file URL — plain paths don't import). */
function makeWrapper(extraArgs: string[]): string {
  const wrapper = path.join(os.tmpdir(), `sunday-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    wrapper,
    `process.argv.splice(2, 0, ${extraArgs.map((a) => JSON.stringify(a)).join(', ')});\nawait import(${JSON.stringify(
      FIXTURE_URL,
    )});\n`,
  );
  return wrapper;
}

function waitForStatus(m: SidecarManager, want: SidecarStatus, timeoutMs = 8000): Promise<void> {
  if (m.getStatus() === want) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`timed out waiting for status ${want} (still ${m.getStatus()})`));
    }, timeoutMs);
    const sub = m.onDidChangeStatus((s) => {
      if (s === want) {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  });
}

describe('resolveSidecarCommand', () => {
  it('honours an explicit configured path (driven via node)', () => {
    const cmd = resolveSidecarCommand('/nonexistent-ext-dir', FIXTURE);
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toEqual([FIXTURE]);
    expect(cmd.source).toContain('sunday.sidecar.path');
  });

  it('throws SidecarNotFoundError for a configured path that does not exist', () => {
    expect(() => resolveSidecarCommand('/nonexistent-ext-dir', '/nope/sundayd.js')).toThrow(SidecarNotFoundError);
  });

  it('finds the bundled layout before the workspace fallback', () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-bundled-'));
    const bundled = path.join(extDir, 'sundayd', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, '/* fake */');
    const cmd = resolveSidecarCommand(extDir);
    expect(cmd.args).toEqual([bundled]);
    expect(cmd.source).toContain('bundled');
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  it('falls back to the dev workspace layout (packages/sundayd)', () => {
    // extensionDir = <root>/sunday-agent  →  workspace candidate is
    // <root>/sundayd/dist/cli.js. Build the fake root explicitly.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-root-'));
    const extDir = path.join(root, 'sunday-agent');
    const daemon = path.join(root, 'sundayd', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(daemon), { recursive: true });
    fs.writeFileSync(daemon, '/* fake sundayd */');
    const cmd = resolveSidecarCommand(extDir);
    expect(cmd.source).toContain('workspace');
    expect(cmd.args).toEqual([daemon]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('throws SidecarNotFoundError when nothing is found', () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-empty-'));
    // Point extensionDir deep inside the temp dir so the workspace candidate
    // (../sundayd/dist/cli.js) cannot hit the real checkout.
    const deep = path.join(extDir, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const origPath = process.env.PATH;
    process.env.PATH = extDir; // no sundayd here
    try {
      expect(() => resolveSidecarCommand(deep)).toThrow(SidecarNotFoundError);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  });
});

describe('SidecarManager lifecycle', () => {
  it('starts, handshakes, and reports server info', async () => {
    const { manager, logs } = makeManager(FIXTURE);
    expect(manager.getStatus()).toBe('stopped');
    const rpc = await manager.start();
    expect(manager.getStatus()).toBe('ready');
    expect(manager.getServerInfo()).toEqual({ name: 'sundayd', version: '9.9.9-test' });
    expect(rpc).toBe(manager.getRpc());
    expect(logs.join('\n')).toContain('sundayd ready');
    await manager.stop();
    expect(manager.getStatus()).toBe('stopped');
    expect(manager.getRpc()).toBeUndefined();
  });

  it('auto-discovers the workspace sundayd when no path is configured', async () => {
    const logs: string[] = [];
    const manager = new SidecarManager({
      // Use the real package dir: <pkg>/../sundayd/dist/cli.js exists there.
      extensionDir: PKG_DIR,
      clientVersion: '0.0.1-test',
      readConfig: () => ({ sidecarPath: '' }),
      log: (m) => logs.push(m),
      handshakeTimeoutMs: 5000,
    });
    managers.push(manager);
    // The real sundayd needs no keys just to answer sunday/hello.
    await manager.start();
    expect(manager.getStatus()).toBe('ready');
    expect(manager.getServerInfo()?.name).toBe('sundayd');
    await manager.stop();
  });

  it('rejects with ProtocolMismatchError on version mismatch', async () => {
    const wrapper = makeWrapper(['--protocol-version', '999']);
    const { manager } = makeManager(wrapper);
    const err = await manager.start().catch((e) => e);
    expect(err).toBeInstanceOf(ProtocolMismatchError);
    expect(manager.getStatus()).toBe('stopped');
    fs.rmSync(wrapper, { force: true });
  });

  it('rejects a hello response with the wrong shape', async () => {
    const wrapper = makeWrapper(['--bad-hello-shape']);
    const { manager } = makeManager(wrapper);
    await expect(manager.start()).rejects.toThrow();
    expect(manager.getStatus()).toBe('stopped');
    fs.rmSync(wrapper, { force: true });
  });

  it('fails fast when the configured binary does not exist', async () => {
    const { manager } = makeManager('/nope/sundayd.js');
    await expect(manager.start()).rejects.toThrow(SidecarNotFoundError);
    expect(manager.getStatus()).toBe('stopped');
  });

  it('gives up auto-restart after rapid crashes and reports crashed', async () => {
    // Suicide 800ms after spawn: late enough that the hello handshake always
    // lands first (status → ready), early enough to count as a rapid crash.
    const wrapper = makeWrapper(['--exit-after-ms', '800', '--exit-code', '1']);
    const { manager, logs } = makeManager(wrapper, { crashWindowMs: 5000, maxRapidCrashes: 2 });
    await manager.start();
    expect(manager.getStatus()).toBe('ready');
    await waitForStatus(manager, 'crashed', 20000);
    expect(logs.join('\n')).toContain('auto-restart disabled');
    fs.rmSync(wrapper, { force: true });
  });

  it('restart() recovers a healthy daemon and resets backoff', async () => {
    const { manager } = makeManager(FIXTURE);
    await manager.start();
    const rpc = await manager.restart();
    expect(manager.getStatus()).toBe('ready');
    expect(rpc).toBe(manager.getRpc());
    await manager.stop();
  });

  it('stop() on a stopped manager is a no-op', async () => {
    const { manager } = makeManager(FIXTURE);
    await manager.stop();
    expect(manager.getStatus()).toBe('stopped');
  });

  it('notifies status listeners on transitions', async () => {
    const { manager } = makeManager(FIXTURE);
    const seen: SidecarStatus[] = [];
    const sub = manager.onDidChangeStatus((s) => seen.push(s));
    await manager.start();
    await manager.stop();
    sub.dispose();
    expect(seen).toEqual(['starting', 'ready', 'stopped']);
  });
});
